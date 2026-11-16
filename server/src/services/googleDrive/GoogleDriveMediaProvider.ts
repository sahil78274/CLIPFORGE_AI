import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  GOOGLE_DRIVE_SUPPORTED_MIME_TYPES,
  MAX_GOOGLE_DRIVE_FILE_BYTES,
} from '@clipforge/shared';
import { env } from '../../config/env';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';
import { probeMediaFile, type MediaProbeInfo } from '../mediaProbeService';
import { getGoogleDriveOAuthService, type GoogleDriveOAuthService } from './GoogleDriveOAuthService';

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  thumbnailLink: string | null;
  md5Checksum: string | null;
  sha256Checksum: string | null;
  driveModifiedTime: string | null;
  canDownload: boolean;
}

export interface AcquiredDriveMedia {
  localFilePath: string;
  mimeType: string;
  sizeBytes: number;
  probe: MediaProbeInfo;
  metadata: DriveFileMetadata;
  checksumVerified: boolean;
}

export interface DriveDownloadOptions {
  userId: string;
  fileId: string;
  metadata: DriveFileMetadata;
  destPath: string;
  signal?: AbortSignal;
  maxDurationSec?: number;
  onProgress?: (percent: number, message: string) => void;
}

const DRIVE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'md5Checksum',
  'sha256Checksum',
  'thumbnailLink',
  'modifiedTime',
  'trashed',
  'capabilities(canDownload)',
  'videoMediaMetadata(width,height,durationMillis)',
].join(',');

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);

/** Hosts Google Drive may redirect alt=media downloads to (SSRF allowlist). */
const GOOGLE_MEDIA_REDIRECT_HOSTS = new Set([
  'www.googleapis.com',
  'googleapis.com',
  'content.googleapis.com',
  'drive.google.com',
  'docs.google.com',
  'drive.usercontent.google.com',
  'storage.googleapis.com',
  'lh3.googleusercontent.com',
  '127.0.0.1',
  'localhost',
  '::1',
]);

function inferExtension(name: string, mimeType: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return ext;
  if (mimeType.includes('quicktime')) return '.mov';
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('matroska')) return '.mkv';
  if (mimeType.includes('m4v')) return '.m4v';
  return '.mp4';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseContentRange(
  header: string | null
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) };
}

async function computeFileHash(filePath: string, algorithm: 'sha256' | 'md5'): Promise<string> {
  const hash = crypto.createHash(algorithm);
  await pipeline(
    fs.createReadStream(filePath),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    })
  );
  return hash.digest('hex');
}

/**
 * Google's Drive `files.get?alt=media` often replies with a 302 to a different
 * Google media host. Generic fetch drops the Authorization header on a cross-origin
 * redirect, so follow redirects explicitly and re-attach the user's bearer token
 * only for hosts on the strict Google allowlist. Local test servers are allowed
 * by the same list so the integration suite can exercise real byte streams.
 */
async function fetchDriveMedia(
  initialUrl: string,
  accessToken: string,
  rangeHeader: string,
  signal: AbortSignal
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop < 6; hop += 1) {
    const parsed = new URL(currentUrl);
    if (!GOOGLE_MEDIA_REDIRECT_HOSTS.has(parsed.hostname)) {
      throw new AppError(
        'Google Drive returned a media redirect to a disallowed host.',
        502,
        'GOOGLE_DRIVE_UNSAFE_REDIRECT'
      );
    }
    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'video/*,application/octet-stream,*/*;q=0.1',
        Range: rangeHeader,
      },
      signal,
    });
    if (res.status < 300 || res.status >= 400 || res.status === 304) {
      return res;
    }
    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, currentUrl).toString();
    if (!next.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(next)) {
      throw new AppError(
        'Google Drive returned a non-HTTPS media redirect.',
        502,
        'GOOGLE_DRIVE_UNSAFE_REDIRECT'
      );
    }
    currentUrl = next;
  }
  throw new AppError('Too many Google Drive media redirects.', 502, 'GOOGLE_DRIVE_UNSAFE_REDIRECT');
}

/**
 * GoogleDriveMediaProvider — backend media acquisition for direct Drive imports.
 *
 * Every file is independently verified with the *authenticated ClipForge user's*
 * own OAuth credentials before any byte is downloaded. Downloads use the Drive
 * v3 `alt=media` endpoint with HTTP Range chunks, are streamed straight to a
 * temporary file (never buffered in RAM), are resumable/retryable, and are
 * validated by byte count, Drive checksum and FFprobe before entering the
 * existing FFmpeg / Faster-Whisper chunked pipeline.
 */
export class GoogleDriveMediaProvider {
  readonly name = 'google_drive';

  constructor(private readonly oauth: GoogleDriveOAuthService) {}

  private driveFileUrl(fileId: string): string {
    const base = env.GOOGLE_DRIVE_API_BASE_URL.replace(/\/+$/, '');
    return `${base}/files/${encodeURIComponent(fileId)}`;
  }

  /** Fetch and validate Drive metadata using the connected user's own token. */
  async fetchFileMetadata(userId: string, fileId: string): Promise<DriveFileMetadata> {
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(fileId)) {
      throw new BadRequestError('Invalid Google Drive file ID.', 'GOOGLE_DRIVE_INVALID_FILE_ID');
    }
    const { accessToken } = await this.oauth.getValidAccessToken(userId);
    const url = new URL(this.driveFileUrl(fileId));
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', DRIVE_FIELDS);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      throw new AppError(
        `Unable to reach Google Drive metadata API: ${err?.message || 'network error'}`,
        502,
        'GOOGLE_DRIVE_METADATA_FAILED'
      );
    }

    if (res.status === 401) return this.oauth.markReauthRequired(userId);
    if (res.status === 403) {
      throw new ForbiddenError(
        'Your connected Google account does not have permission to read this Google Drive file. Re-select the video in the Google Picker.',
        'GOOGLE_DRIVE_ACCESS_DENIED'
      );
    }
    if (res.status === 404) {
      throw new NotFoundError(
        'The selected Google Drive file was not found, was deleted, or is no longer shared with your connected Google account.',
        'GOOGLE_DRIVE_FILE_NOT_FOUND'
      );
    }
    if (!res.ok) {
      throw new AppError(
        `Google Drive metadata request failed (HTTP ${res.status}).`,
        502,
        'GOOGLE_DRIVE_METADATA_FAILED'
      );
    }

    const raw: any = await res.json().catch(() => ({}));
    return this.validateMetadata(raw, fileId);
  }

  private validateMetadata(raw: any, requestedFileId: string): DriveFileMetadata {
    const id = String(raw?.id || '').trim();
    // Never trust a client-supplied ID without confirming Drive returned that exact file.
    if (!id || id !== requestedFileId) {
      throw new BadRequestError(
        'Google Drive returned a different file than the one selected. Please re-select your video.',
        'GOOGLE_DRIVE_FILE_ID_MISMATCH'
      );
    }
    if (raw?.trashed === true || raw?.explicitlyTrashed === true) {
      throw new NotFoundError(
        'The selected Google Drive file is in the trash.',
        'GOOGLE_DRIVE_FILE_NOT_FOUND'
      );
    }

    const name = String(raw?.name || `drive_video_${id}.mp4`);
    const mimeType = String(raw?.mimeType || '').toLowerCase().trim();
    const ext = path.extname(name).toLowerCase();
    const hasVideoMetadata =
      raw?.videoMediaMetadata && typeof raw.videoMediaMetadata === 'object';
    const mimeSupported = (GOOGLE_DRIVE_SUPPORTED_MIME_TYPES as readonly string[]).includes(
      mimeType
    );
    // Google occasionally reports binary uploads as application/octet-stream even
    // though it parsed them as video. Accept only with a known video extension AND
    // Drive-provided videoMediaMetadata. Everything else (PDFs, docs, shortcuts) is rejected.
    const octetStreamVideo =
      mimeType === 'application/octet-stream' && ALLOWED_EXTENSIONS.has(ext) && hasVideoMetadata;
    if (!mimeSupported && !octetStreamVideo) {
      throw new BadRequestError(
        `Google Drive item "${name}" has MIME type "${mimeType || 'unknown'}", which is not a supported video. Select an MP4, MOV, WebM, MKV or M4V file.`,
        'GOOGLE_DRIVE_NOT_VIDEO'
      );
    }
    if (raw?.capabilities?.canDownload === false) {
      throw new ForbiddenError(
        'Google Drive does not allow downloading this file. Select a downloadable video file.',
        'GOOGLE_DRIVE_DOWNLOAD_DENIED'
      );
    }

    const maxBytes = Math.min(env.GOOGLE_DRIVE_MAX_FILE_BYTES, MAX_GOOGLE_DRIVE_FILE_BYTES);
    const sizeBytes =
      raw?.size !== undefined && raw?.size !== null && Number.isFinite(Number(raw.size))
        ? Number(raw.size)
        : null;
    if (sizeBytes !== null && sizeBytes <= 0) {
      throw new BadRequestError('The selected Google Drive video is empty.', 'GOOGLE_DRIVE_EMPTY_FILE');
    }
    if (sizeBytes !== null && sizeBytes > maxBytes) {
      throw new BadRequestError(
        `The selected Google Drive video (${(sizeBytes / 1024 ** 3).toFixed(1)} GiB) exceeds the maximum import size of ${(maxBytes / 1024 ** 3).toFixed(0)} GiB.`,
        'GOOGLE_DRIVE_FILE_TOO_LARGE'
      );
    }

    const durationMillis = Number(raw?.videoMediaMetadata?.durationMillis || 0);
    const durationSec =
      Number.isFinite(durationMillis) && durationMillis > 0
        ? Math.round(durationMillis / 1000)
        : null;
    if (durationSec !== null && durationSec > env.MAX_VIDEO_DURATION_SEC + 5) {
      throw new BadRequestError(
        `The selected Google Drive video is ${Math.round(durationSec / 3600)}h long, exceeding the ${Math.round(env.MAX_VIDEO_DURATION_SEC / 3600)}-hour maximum.`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    return {
      id,
      name,
      mimeType: mimeSupported ? mimeType : 'video/mp4',
      sizeBytes,
      durationSec,
      width: Number(raw?.videoMediaMetadata?.width) || null,
      height: Number(raw?.videoMediaMetadata?.height) || null,
      thumbnailLink: raw?.thumbnailLink ? String(raw.thumbnailLink) : null,
      md5Checksum: raw?.sha256Checksum ? null : raw?.md5Checksum ? String(raw.md5Checksum) : null,
      sha256Checksum: raw?.sha256Checksum ? String(raw.sha256Checksum) : null,
      driveModifiedTime: raw?.modifiedTime ? String(raw.modifiedTime) : null,
      canDownload: true,
    };
  }

  /**
   * Stream a Drive video to a temporary file using retryable HTTP Range chunks.
   * Supports multi-GB / 10-hour files with constant RAM usage.
   */
  async downloadFileToDisk(options: DriveDownloadOptions): Promise<AcquiredDriveMedia> {
    const { userId, fileId, metadata } = options;
    const maxBytes = Math.min(env.GOOGLE_DRIVE_MAX_FILE_BYTES, MAX_GOOGLE_DRIVE_FILE_BYTES);
    const maxDurationSec = options.maxDurationSec ?? env.MAX_VIDEO_DURATION_SEC;
    const chunkSize = env.GOOGLE_DRIVE_DOWNLOAD_CHUNK_BYTES;

    fs.mkdirSync(path.dirname(options.destPath), { recursive: true });
    const partPath = `${options.destPath}.part`;
    const resumeMetaPath = `${partPath}.json`;

    // Resume only when the partial file belongs to the exact same Drive revision.
    let downloaded = 0;
    let expectedTotal = metadata.sizeBytes;
    let etag: string | null = null;
    if (fs.existsSync(partPath) && fs.existsSync(resumeMetaPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(resumeMetaPath, 'utf8'));
        if (saved.fileId === fileId && saved.modifiedTime === metadata.driveModifiedTime) {
          downloaded = fs.statSync(partPath).size;
          etag = saved.etag || null;
          if (typeof saved.expectedTotal === 'number' && saved.expectedTotal > 0) {
            expectedTotal = saved.expectedTotal;
          }
        }
      } catch {
        /* ignore corrupt resume metadata */
      }
    }
    if (fs.existsSync(partPath) && downloaded <= 0) fs.unlinkSync(partPath);
    if (downloaded > (expectedTotal ?? maxBytes)) {
      fs.rmSync(partPath, { force: true });
      fs.rmSync(resumeMetaPath, { force: true });
      downloaded = 0;
    }

    let consecutiveFailures = 0;
    const retryOrThrow = async (reason: string, backoffMs = 0): Promise<void> => {
      consecutiveFailures += 1;
      if (consecutiveFailures > 5) {
        throw new AppError(
          `Google Drive download failed after ${consecutiveFailures - 1} retries (${reason}). Click Retry to resume the import.`,
          502,
          'GOOGLE_DRIVE_DOWNLOAD_FAILED'
        );
      }
      logger.warn('Retrying Google Drive media download', {
        attempt: consecutiveFailures,
        reason,
      });
      await sleep(Math.max(backoffMs, 250 * 2 ** (consecutiveFailures - 1)));
    };

    let lastReportedPct = 8;
    const report = (pct: number, msg: string) => {
      const bounded = Math.max(8, Math.min(96, Math.round(pct)));
      if (bounded >= lastReportedPct) {
        lastReportedPct = bounded;
        options.onProgress?.(bounded, msg);
      }
    };
    const pctFor = (bytes: number) =>
      expectedTotal && expectedTotal > 0
        ? 10 + (bytes / expectedTotal) * 82
        : Math.min(90, 10 + (bytes / (50 * 1024 * 1024)) * 10);

    report(10, `Preparing to stream "${metadata.name}" from Google Drive...`);

    let guard = 0;
    while (guard++ < 20000) {
      if (options.signal?.aborted) {
        throw new AppError('Google Drive download cancelled.', 499, 'GOOGLE_DRIVE_DOWNLOAD_CANCELLED');
      }
      if (expectedTotal !== null && downloaded >= expectedTotal) break;

      const rangeStart = downloaded;
      const rangeEnd =
        expectedTotal !== null
          ? Math.min(rangeStart + chunkSize - 1, expectedTotal - 1)
          : rangeStart + chunkSize - 1;

      const { accessToken } = await this.oauth.getValidAccessToken(userId);
      const url = new URL(this.driveFileUrl(fileId));
      url.searchParams.set('alt', 'media');
      url.searchParams.set('supportsAllDrives', 'true');

      const attemptSignal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(180_000),
      ]);

      let res: Response;
      try {
        res = await fetchDriveMedia(
          url.toString(),
          accessToken,
          `bytes=${rangeStart}-${rangeEnd}`,
          attemptSignal
        );
      } catch (err: any) {
        if (options.signal?.aborted) {
          throw new AppError('Google Drive download cancelled.', 499, 'GOOGLE_DRIVE_DOWNLOAD_CANCELLED');
        }
        if ((err as AppError)?.code === 'GOOGLE_DRIVE_UNSAFE_REDIRECT') throw err;
        await retryOrThrow(`network error: ${err?.message || 'connection failed'}`);
        continue;
      }

      if (res.status === 401) return this.oauth.markReauthRequired(userId);
      if (res.status === 403) {
        throw new ForbiddenError(
          'Google Drive denied the media download (permission revoked, download restriction, or quota exceeded).',
          'GOOGLE_DRIVE_DOWNLOAD_DENIED'
        );
      }
      if (res.status === 404) {
        throw new NotFoundError(
          'The Google Drive video disappeared during download. Re-select the file and retry.',
          'GOOGLE_DRIVE_FILE_NOT_FOUND'
        );
      }
      if (res.status === 416) {
        if (expectedTotal !== null && downloaded >= expectedTotal) break;
        throw new AppError(
          'Google Drive reported an invalid download range. Retry the import.',
          502,
          'GOOGLE_DRIVE_DOWNLOAD_FAILED'
        );
      }
      if (isRetryableStatus(res.status)) {
        const retryAfter = Number(res.headers.get('retry-after') || 0);
        await retryOrThrow(
          `HTTP ${res.status}`,
          retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 0
        );
        continue;
      }
      if (!res.ok || !res.body) {
        throw new AppError(
          `Google Drive media stream returned HTTP ${res.status}.`,
          502,
          'GOOGLE_DRIVE_DOWNLOAD_FAILED'
        );
      }

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType.startsWith('text/') || contentType === 'application/json') {
        throw new BadRequestError(
          `Google Drive returned "${contentType}" instead of binary video media.`,
          'GOOGLE_DRIVE_NOT_VIDEO'
        );
      }

      const responseEtag = res.headers.get('etag');
      if (etag && responseEtag && responseEtag !== etag) {
        fs.rmSync(partPath, { force: true });
        fs.rmSync(resumeMetaPath, { force: true });
        throw new AppError(
          'The Google Drive file changed while downloading. Click Retry to download the latest version.',
          409,
          'GOOGLE_DRIVE_FILE_CHANGED'
        );
      }
      etag = etag || responseEtag;

      const contentRange = parseContentRange(res.headers.get('content-range'));
      let writeFlags: 'a' | 'w' = downloaded > 0 ? 'a' : 'w';
      if (res.status === 200) {
        // Server ignored Range: it is sending the whole file, so restart from byte 0.
        downloaded = 0;
        writeFlags = 'w';
        const contentLength = Number(res.headers.get('content-length') || 0);
        if (contentLength > 0) expectedTotal = contentLength;
      } else if (res.status === 206) {
        if (!contentRange || contentRange.start !== rangeStart) {
          throw new AppError(
            'Google Drive returned an unexpected byte range. Retry the import.',
            502,
            'GOOGLE_DRIVE_DOWNLOAD_FAILED'
          );
        }
        if (contentRange.total > 0) {
          if (metadata.sizeBytes && contentRange.total !== metadata.sizeBytes) {
            throw new BadRequestError(
              'Google Drive reported a different file size than its metadata. Retry the import.',
              'GOOGLE_DRIVE_INTEGRITY_MISMATCH'
            );
          }
          expectedTotal = contentRange.total;
        }
      } else {
        throw new AppError(
          `Unexpected Google Drive media response (HTTP ${res.status}).`,
          502,
          'GOOGLE_DRIVE_DOWNLOAD_FAILED'
        );
      }

      if (expectedTotal !== null && expectedTotal > maxBytes) {
        throw new BadRequestError(
          'The Google Drive video exceeds the maximum import size.',
          'GOOGLE_DRIVE_FILE_TOO_LARGE'
        );
      }

      let bytesThisChunk = 0;
      const progressTransform = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytesThisChunk += chunk.length;
          if (downloaded + bytesThisChunk > maxBytes) {
            cb(
              new BadRequestError(
                'The Google Drive video stream exceeded the maximum permitted file size.',
                'GOOGLE_DRIVE_FILE_TOO_LARGE'
              )
            );
            return;
          }
          if (bytesThisChunk % (4 * 1024 * 1024) < chunk.length) {
            const totalForPct = expectedTotal || maxBytes;
            report(
              pctFor(downloaded + bytesThisChunk),
              `Downloading "${metadata.name}" from Google Drive (${Math.min(
                100,
                Math.round(((downloaded + bytesThisChunk) / totalForPct) * 100)
              )}%)...`
            );
          }
          cb(null, chunk);
        },
      });

      try {
        await pipeline(
          Readable.fromWeb(res.body as any),
          progressTransform,
          fs.createWriteStream(partPath, { flags: writeFlags }),
          { signal: options.signal }
        );
      } catch (err: any) {
        if (options.signal?.aborted) {
          throw new AppError('Google Drive download cancelled.', 499, 'GOOGLE_DRIVE_DOWNLOAD_CANCELLED');
        }
        logger.warn('Google Drive stream chunk interrupted; resuming from last byte', {
          fileId,
          atByte: downloaded,
          err: err?.message,
        });
        downloaded = fs.existsSync(partPath) ? fs.statSync(partPath).size : downloaded;
        await retryOrThrow(`interrupted stream: ${err?.message || 'connection reset'}`);
        continue;
      }

      consecutiveFailures = 0;
      downloaded += bytesThisChunk;
      fs.writeFileSync(
        resumeMetaPath,
        JSON.stringify({
          fileId,
          modifiedTime: metadata.driveModifiedTime,
          etag,
          expectedTotal,
        }),
        'utf8'
      );

      if (bytesThisChunk === 0) {
        await retryOrThrow('empty response body');
        continue;
      }
      // No Range support / no declared size: a single 200 response is the complete file.
      if (res.status === 200 && expectedTotal === null) {
        expectedTotal = downloaded;
        break;
      }
      if (expectedTotal === null && bytesThisChunk < rangeEnd - rangeStart + 1) {
        expectedTotal = downloaded;
        break;
      }
    }

    if (!fs.existsSync(partPath)) {
      throw new AppError(
        'Google Drive download did not produce a local file.',
        502,
        'GOOGLE_DRIVE_DOWNLOAD_FAILED'
      );
    }

    const stat = fs.statSync(partPath);
    let checksumVerified = false;
    try {
      if (expectedTotal !== null && stat.size !== expectedTotal) {
        throw new BadRequestError(
          `Incomplete Google Drive download (${stat.size} of ${expectedTotal} bytes). Retry the import to resume.`,
          'GOOGLE_DRIVE_INTEGRITY_MISMATCH'
        );
      }
      if (stat.size === 0) {
        throw new BadRequestError('Downloaded Google Drive file is empty.', 'GOOGLE_DRIVE_EMPTY_FILE');
      }

      if (metadata.sha256Checksum || metadata.md5Checksum) {
        const algorithm = metadata.sha256Checksum ? 'sha256' : 'md5';
        const expected = (metadata.sha256Checksum || metadata.md5Checksum || '').toLowerCase();
        const actual = await computeFileHash(partPath, algorithm);
        if (actual !== expected) {
          throw new BadRequestError(
            'Downloaded Google Drive video failed checksum verification. Retry the import.',
            'GOOGLE_DRIVE_INTEGRITY_MISMATCH'
          );
        }
        checksumVerified = true;
      }

      report(97, 'Validating downloaded Google Drive video with FFprobe...');
      const probe = await probeMediaFile(partPath);
      if (probe.width <= 0 || probe.height <= 0) {
        throw new BadRequestError(
          'Downloaded Google Drive file does not contain a valid decodable video stream.',
          'GOOGLE_DRIVE_INVALID_STREAM'
        );
      }
      if (probe.durationSec > maxDurationSec + 5) {
        throw new BadRequestError(
          `Video duration (${Math.round(probe.durationSec / 3600)}h) exceeds the ${Math.round(maxDurationSec / 3600)}-hour maximum.`,
          'VIDEO_DURATION_LIMIT_EXCEEDED'
        );
      }
      if (probe.sizeBytes !== stat.size) {
        throw new BadRequestError(
          'Downloaded file size changed during validation. Retry the import.',
          'GOOGLE_DRIVE_INTEGRITY_MISMATCH'
        );
      }

      const ext = inferExtension(metadata.name, metadata.mimeType);
      const finalPath = options.destPath.endsWith(ext)
        ? options.destPath
        : `${options.destPath}${ext}`;
      fs.renameSync(partPath, finalPath);
      fs.rmSync(resumeMetaPath, { force: true });
      report(100, 'Google Drive video downloaded, verified and ready for processing.');

      return {
        localFilePath: finalPath,
        mimeType: metadata.mimeType,
        sizeBytes: stat.size,
        probe,
        metadata,
        checksumVerified,
      };
    } catch (err) {
      // Preserve .part so a retry can resume at the last verified byte; the worker
      // removes the whole per-job temp directory in its finally block after processing.
      logger.warn('Google Drive download verification failed', {
        fileId,
        err: (err as any)?.message,
      });
      throw err;
    }
  }
}

let singleton: GoogleDriveMediaProvider | null = null;

export function getGoogleDriveMediaProvider(): GoogleDriveMediaProvider {
  if (!singleton) {
    singleton = new GoogleDriveMediaProvider(getGoogleDriveOAuthService());
  }
  return singleton;
}
