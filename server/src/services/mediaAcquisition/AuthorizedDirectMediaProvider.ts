import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AuthorizedMediaSourceType } from '@clipforge/shared';
import { env } from '../../config/env';
import { AppError, BadRequestError } from '../../utils/errors';
import { probeMediaFile, type MediaProbeInfo } from '../mediaProbeService';
import { assertUrlSafeFromSsrf } from '../urlSafetyService';
import { isYouTubeWebUrl } from './YouTubeMetadataProvider';
import type { AcquiredMediaResult, MediaAcquireOptions } from './types';

const execFileAsync = promisify(execFile);

const SUPPORTED_EXPORT_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];

/**
 * Explicit test-only origin allowlist so automated tests can serve real MP4 streams
 * from an ephemeral local port while keeping SSRF blocking 100% active for all other
 * loopback, RFC1918, and cloud-metadata addresses.
 */
const allowedTestMediaOrigins = new Set<string>();

export function registerAllowedTestMediaOrigin(origin: string): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error('registerAllowedTestMediaOrigin is restricted to NODE_ENV=test');
  }
  allowedTestMediaOrigins.add(new URL(origin).origin);
}

export function clearAllowedTestMediaOrigins(): void {
  allowedTestMediaOrigins.clear();
}

async function assertSafeAuthorizedMediaUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new BadRequestError(
      'Invalid Direct Authorized Media URL format.',
      'INVALID_AUTHORIZED_MEDIA_URL'
    );
  }

  if (isYouTubeWebUrl(parsed.toString())) {
    throw new BadRequestError(
      'A YouTube watch/shorts webpage URL is an HTML page, not a direct authorized video file. Provide a presigned MP4/MOV/WebM stream URL (e.g., S3, GCS, R2, CDN) or connect Google Drive to select your original export.',
      'YOUTUBE_WATCH_URL_NOT_DIRECT_MEDIA'
    );
  }

  if (env.NODE_ENV === 'test' && allowedTestMediaOrigins.has(parsed.origin)) {
    return parsed;
  }

  return assertUrlSafeFromSsrf(parsed.toString());
}

function inferExtensionFromContentTypeOrUrl(contentType: string, rawUrl: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('quicktime')) return '.mov';
  if (lower.includes('matroska') || lower.includes('mkv')) return '.mkv';
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    for (const ext of SUPPORTED_EXPORT_EXTENSIONS) {
      if (pathname.endsWith(ext)) return ext;
    }
  } catch {
    // ignore
  }
  return '.mp4';
}

function inferMimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    default:
      return 'video/mp4';
  }
}

function assertNotHtmlOrJsonContentType(contentType: string, contextLabel: string): void {
  const clean = contentType.split(';')[0].trim().toLowerCase();
  if (
    clean.startsWith('text/html') ||
    clean.startsWith('text/plain') ||
    clean === 'application/json' ||
    clean === 'application/xml' ||
    clean.startsWith('image/')
  ) {
    throw new BadRequestError(
      `${contextLabel} returned "${clean}" instead of an actual video media stream. Metadata, JSON, or HTML pages are never accepted as video files.`,
      'YOUTUBE_MEDIA_NOT_VIDEO'
    );
  }
}

export class AuthorizedDirectMediaProvider {
  readonly name = 'authorized_direct_media';

  findLocalOwnerExportFile(videoId: string): string | null {
    const baseDir = path.resolve(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR);
    if (!fs.existsSync(baseDir)) return null;
    for (const ext of SUPPORTED_EXPORT_EXTENSIONS) {
      const candidate = path.join(baseDir, `${videoId}${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  async probeLocalOwnerExportIfPresent(videoId: string): Promise<MediaProbeInfo | null> {
    const found = this.findLocalOwnerExportFile(videoId);
    if (!found) return null;
    try {
      return await probeMediaFile(found);
    } catch {
      return null;
    }
  }

  hasExternalBridgeConfigured(): {
    configured: boolean;
    sourceType: AuthorizedMediaSourceType;
    adapterName: string;
  } {
    const mode = env.YOUTUBE_MEDIA_ADAPTER;
    if (
      (mode === 'composite' || mode === 'authorized_http_provider') &&
      Boolean(env.YOUTUBE_MEDIA_PROVIDER_URL && env.YOUTUBE_MEDIA_PROVIDER_URL.trim())
    ) {
      return {
        configured: true,
        sourceType: 'authorized_http_provider',
        adapterName: 'authorized_http_provider',
      };
    }
    if (
      (mode === 'composite' || mode === 'custom_command') &&
      Boolean(env.YOUTUBE_MEDIA_COMMAND_BIN && env.YOUTUBE_MEDIA_COMMAND_BIN.trim())
    ) {
      return {
        configured: true,
        sourceType: 'custom_command',
        adapterName: 'custom_command',
      };
    }
    return {
      configured: false,
      sourceType: 'unavailable',
      adapterName: 'unavailable',
    };
  }

  async preflightAuthorizedMediaUrl(rawUrl: string): Promise<{
    verifiedUrl: string;
    contentType: string;
    contentLength: number | null;
  }> {
    if (!env.ALLOW_DIRECT_MEDIA_URL_IMPORT) {
      throw new BadRequestError(
        'Direct authorized media URL imports are disabled by server policy.',
        'DIRECT_MEDIA_URL_DISABLED'
      );
    }

    const safeUrl = await assertSafeAuthorizedMediaUrl(rawUrl);

    let res: Response | null = null;
    try {
      res = await fetch(safeUrl.toString(), {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': 'ClipForgeAI-AuthorizedMediaVerifier/1.0',
          Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      res = null;
    }

    // Presigned S3/GCS/R2 GET-only URLs frequently reject HEAD with 403/405 -> probe first 1KB via GET Range
    if (!res || res.status === 403 || res.status === 405 || res.status === 501) {
      const rangeAbort = new AbortController();
      const timeout = setTimeout(() => rangeAbort.abort(), 10000);
      try {
        res = await fetch(safeUrl.toString(), {
          method: 'GET',
          redirect: 'follow',
          headers: {
            Range: 'bytes=0-1023',
            'User-Agent': 'ClipForgeAI-AuthorizedMediaVerifier/1.0',
            Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5',
          },
          signal: rangeAbort.signal,
        });
        // Cancel body read immediately once headers are inspected
        await res.body?.cancel().catch(() => undefined);
      } catch (err: any) {
        throw new BadRequestError(
          `Unable to reach the Direct Authorized Media URL (${err?.message || 'connection failed'}). Ensure the presigned link is active and publicly reachable over HTTPS.`,
          'AUTHORIZED_MEDIA_URL_UNREACHABLE'
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    if (res.url && isYouTubeWebUrl(res.url)) {
      throw new BadRequestError(
        'Direct Authorized Media URL redirected to a YouTube webpage instead of a video stream.',
        'YOUTUBE_WATCH_URL_NOT_DIRECT_MEDIA'
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new BadRequestError(
        `Direct Authorized Media URL returned HTTP ${res.status} (expired or unauthorized presigned URL). Generate a fresh signed URL and try again.`,
        'AUTHORIZED_MEDIA_URL_FORBIDDEN'
      );
    }

    if (!res.ok && res.status !== 206) {
      throw new BadRequestError(
        `Direct Authorized Media URL returned HTTP ${res.status}. Verify the link points to an accessible MP4, MOV, or WebM stream.`,
        'AUTHORIZED_MEDIA_URL_FAILED'
      );
    }

    const contentType = (res.headers.get('content-type') || 'video/mp4')
      .split(';')[0]
      .trim()
      .toLowerCase();
    assertNotHtmlOrJsonContentType(contentType, 'Direct Authorized Media URL');

    const lenHeader = res.headers.get('content-length');
    const contentLength =
      lenHeader && Number.isFinite(Number(lenHeader)) ? Number(lenHeader) : null;

    return {
      verifiedUrl: safeUrl.toString(),
      contentType,
      contentLength,
    };
  }

  async acquireFromDirectUrl(
    videoId: string,
    rawUrl: string,
    destDir: string,
    options?: MediaAcquireOptions
  ): Promise<AcquiredMediaResult> {
    if (!env.ALLOW_DIRECT_MEDIA_URL_IMPORT) {
      throw new BadRequestError(
        'Direct authorized media URL imports are disabled on this server.',
        'DIRECT_MEDIA_URL_DISABLED'
      );
    }

    const safeUrl = await assertSafeAuthorizedMediaUrl(rawUrl);
    fs.mkdirSync(destDir, { recursive: true });
    options?.onProgress?.(10, 'Connecting to direct authorized media stream...');

    const res = await fetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'ClipForgeAI-AuthorizedMediaImporter/1.0',
        Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5',
      },
      signal: options?.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new BadRequestError(
        `Direct Authorized Media URL denied access (HTTP ${res.status}). Your signed URL may have expired.`,
        'AUTHORIZED_MEDIA_URL_FORBIDDEN'
      );
    }
    if (!res.ok || !res.body) {
      throw new AppError(
        `Authorized media URL returned HTTP ${res.status}. Ensure the link is an active MP4, MOV, or WebM stream.`,
        502,
        'YOUTUBE_MEDIA_FETCH_FAILED'
      );
    }

    if (res.url && res.url !== safeUrl.toString()) {
      await assertSafeAuthorizedMediaUrl(res.url);
    }

    const contentType = (res.headers.get('content-type') || 'video/mp4')
      .split(';')[0]
      .trim()
      .toLowerCase();
    assertNotHtmlOrJsonContentType(contentType, 'Direct Authorized Media URL');

    const maxBytes = 20 * 1024 * 1024 * 1024; // 20 GB streamed ceiling for up to 10-hour exports
    const declaredLength = Number(res.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) {
      throw new BadRequestError(
        `Authorized media stream exceeds maximum allowed size (${Math.round(
          maxBytes / (1024 * 1024 * 1024)
        )} GB).`,
        'REMOTE_FILE_TOO_LARGE'
      );
    }

    const ext = inferExtensionFromContentTypeOrUrl(contentType, res.url || safeUrl.toString());
    const destPath = path.join(destDir, `yt_direct_${videoId}${ext}`);
    let bytesWritten = 0;
    let lastReportedPct = 10;

    const progressTransform = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytesWritten += chunk.length;
        if (bytesWritten > maxBytes) {
          cb(
            new BadRequestError(
              'Authorized media stream exceeded maximum permitted file size.',
              'REMOTE_FILE_TOO_LARGE'
            )
          );
          return;
        }
        if (declaredLength > 0) {
          const pct = Math.min(90, 10 + Math.round((bytesWritten / declaredLength) * 80));
          if (pct >= lastReportedPct + 5) {
            lastReportedPct = pct;
            options?.onProgress?.(
              pct,
              `Streaming authorized video media (${Math.round(
                (bytesWritten / declaredLength) * 100
              )}%)...`
            );
          }
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(res.body as any),
        progressTransform,
        fs.createWriteStream(destPath),
        { signal: options?.signal }
      );

      options?.onProgress?.(94, 'Validating acquired video container via FFprobe...');
      const probe = await probeMediaFile(destPath);
      if (probe.width <= 0 || probe.height <= 0) {
        throw new BadRequestError(
          'Downloaded file does not contain a valid decodable video stream.',
          'YOUTUBE_MEDIA_INVALID_STREAM'
        );
      }

      const maxDur = options?.maxDurationSec || env.MAX_VIDEO_DURATION_SEC;
      if (probe.durationSec > maxDur + 5) {
        throw new BadRequestError(
          `Video duration (${Math.round(
            probe.durationSec / 60
          )} min) exceeds maximum allowed (${Math.round(maxDur / 60)} min).`,
          'VIDEO_DURATION_LIMIT_EXCEEDED'
        );
      }

      options?.onProgress?.(100, 'Direct authorized media verified and ready.');
      return {
        localFilePath: destPath,
        adapterName: 'direct_authorized_url',
        sourceType: 'direct_authorized_url',
        mimeType: contentType.startsWith('video/') ? contentType : inferMimeFromExt(ext),
        probe,
        cleanupAfterStore: true,
      };
    } catch (err) {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }

  async acquireFromLocalOwnerExport(
    videoId: string,
    options?: MediaAcquireOptions
  ): Promise<AcquiredMediaResult> {
    const found = this.findLocalOwnerExportFile(videoId);
    if (!found) {
      throw new AppError(
        `No owner-authorized export file found for YouTube video "${videoId}".`,
        422,
        'YOUTUBE_MEDIA_UNAVAILABLE'
      );
    }

    options?.onProgress?.(35, 'Found owner-authorized video export; validating container...');
    const probe = await probeMediaFile(found);
    if (probe.width <= 0 || probe.height <= 0) {
      throw new BadRequestError(
        'Authorized export file contains no valid video stream.',
        'YOUTUBE_MEDIA_INVALID_STREAM'
      );
    }

    const maxDur = options?.maxDurationSec || env.MAX_VIDEO_DURATION_SEC;
    if (probe.durationSec > maxDur + 5) {
      throw new BadRequestError(
        `Video duration (${Math.round(
          probe.durationSec / 60
        )} min) exceeds maximum allowed (${Math.round(maxDur / 60)} min).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    const ext = path.extname(found);
    options?.onProgress?.(100, 'Owner-authorized video verified.');
    return {
      localFilePath: found,
      adapterName: 'owner_export_dir',
      sourceType: 'owner_export_dir',
      mimeType: inferMimeFromExt(ext),
      probe,
      cleanupAfterStore: false,
    };
  }

  async acquireFromConfiguredBridge(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAcquireOptions
  ): Promise<AcquiredMediaResult> {
    const mode = env.YOUTUBE_MEDIA_ADAPTER;

    if (
      (mode === 'composite' || mode === 'authorized_http_provider') &&
      env.YOUTUBE_MEDIA_PROVIDER_URL &&
      env.YOUTUBE_MEDIA_PROVIDER_URL.trim()
    ) {
      fs.mkdirSync(destDir, { recursive: true });
      options?.onProgress?.(10, 'Requesting video stream from authorized media provider...');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'video/*,application/json',
      };
      if (env.YOUTUBE_MEDIA_PROVIDER_TOKEN) {
        headers.Authorization = `Bearer ${env.YOUTUBE_MEDIA_PROVIDER_TOKEN}`;
      }

      const res = await fetch(env.YOUTUBE_MEDIA_PROVIDER_URL.trim(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ videoId, url: canonicalUrl }),
        signal: options?.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new AppError(
          `Authorized media provider returned HTTP ${res.status}${
            errBody ? `: ${errBody.slice(0, 200)}` : ''
          }`,
          502,
          'YOUTUBE_PROVIDER_ERROR'
        );
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const payload: any = await res.json();
        if (!payload?.mediaUrl || typeof payload.mediaUrl !== 'string') {
          throw new AppError(
            'Authorized media provider JSON response did not include a mediaUrl.',
            502,
            'YOUTUBE_PROVIDER_INVALID_RESPONSE'
          );
        }
        const acquired = await this.acquireFromDirectUrl(
          videoId,
          payload.mediaUrl,
          destDir,
          options
        );
        return {
          ...acquired,
          adapterName: 'authorized_http_provider',
          sourceType: 'authorized_http_provider',
        };
      }

      assertNotHtmlOrJsonContentType(contentType, 'Authorized HTTP Media Provider');
      if (!res.body) {
        throw new AppError(
          'Authorized media provider returned an empty response body.',
          502,
          'YOUTUBE_PROVIDER_EMPTY_BODY'
        );
      }

      const ext = inferExtensionFromContentTypeOrUrl(contentType, canonicalUrl);
      const destPath = path.join(destDir, `yt_provider_${videoId}${ext}`);
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(destPath), {
        signal: options?.signal,
      });

      const probe = await probeMediaFile(destPath);
      if (probe.width <= 0 || probe.height <= 0) {
        fs.unlinkSync(destPath);
        throw new BadRequestError(
          'Provider stream contains no decodable video track.',
          'YOUTUBE_MEDIA_INVALID_STREAM'
        );
      }

      return {
        localFilePath: destPath,
        adapterName: 'authorized_http_provider',
        sourceType: 'authorized_http_provider',
        mimeType: contentType.split(';')[0].trim() || 'video/mp4',
        probe,
        cleanupAfterStore: true,
      };
    }

    if (
      (mode === 'composite' || mode === 'custom_command') &&
      env.YOUTUBE_MEDIA_COMMAND_BIN &&
      env.YOUTUBE_MEDIA_COMMAND_BIN.trim()
    ) {
      fs.mkdirSync(destDir, { recursive: true });
      const outputTemplate = path.join(destDir, `yt_cmd_${videoId}.mp4`);

      let argsTemplate: string[] = ['--output', '{outputPath}', '{canonicalUrl}'];
      if (env.YOUTUBE_MEDIA_COMMAND_ARGS_JSON && env.YOUTUBE_MEDIA_COMMAND_ARGS_JSON.trim()) {
        try {
          const parsed = JSON.parse(env.YOUTUBE_MEDIA_COMMAND_ARGS_JSON);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            argsTemplate = parsed;
          }
        } catch {
          throw new AppError(
            'Invalid YOUTUBE_MEDIA_COMMAND_ARGS_JSON configuration (expected JSON string array).',
            500,
            'YOUTUBE_ADAPTER_MISCONFIGURED'
          );
        }
      }

      const finalArgs = argsTemplate.map((arg) =>
        arg
          .replace(/\{videoId\}/g, videoId)
          .replace(/\{canonicalUrl\}/g, canonicalUrl)
          .replace(/\{outputPath\}/g, outputTemplate)
          .replace(/\{outputDir\}/g, destDir)
      );

      options?.onProgress?.(20, 'Executing configured media acquisition command...');
      try {
        await execFileAsync(env.YOUTUBE_MEDIA_COMMAND_BIN.trim(), finalArgs, {
          timeout: 30 * 60 * 1000,
          maxBuffer: 16 * 1024 * 1024,
          signal: options?.signal,
        });
      } catch (err: any) {
        throw new AppError(
          `Configured media acquisition command failed: ${err?.stderr || err?.message || 'execution error'}`,
          502,
          'YOUTUBE_COMMAND_FAILED'
        );
      }

      let locatedFile: string | null = fs.existsSync(outputTemplate) ? outputTemplate : null;
      if (!locatedFile) {
        const files = fs.readdirSync(destDir);
        const match = files.find(
          (f) =>
            f.includes(videoId) &&
            SUPPORTED_EXPORT_EXTENSIONS.includes(path.extname(f).toLowerCase())
        );
        if (match) locatedFile = path.join(destDir, match);
      }

      if (!locatedFile || !fs.existsSync(locatedFile)) {
        throw new AppError(
          'Configured media command completed without producing a video file.',
          502,
          'YOUTUBE_COMMAND_NO_OUTPUT'
        );
      }

      const probe = await probeMediaFile(locatedFile);
      if (probe.width <= 0 || probe.height <= 0) {
        fs.unlinkSync(locatedFile);
        throw new BadRequestError(
          'Acquired media file contains no decodable video stream.',
          'YOUTUBE_MEDIA_INVALID_STREAM'
        );
      }

      return {
        localFilePath: locatedFile,
        adapterName: 'custom_command',
        sourceType: 'custom_command',
        mimeType: inferMimeFromExt(path.extname(locatedFile)),
        probe,
        cleanupAfterStore: true,
      };
    }

    throw new AppError(
      'No external authorized media bridge is configured on this server.',
      422,
      'YOUTUBE_MEDIA_UNAVAILABLE'
    );
  }
}
