import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type {
  DriveMatchConfidence,
  DriveVideoMatchInfo,
  GoogleDriveVideoFile,
  YouTubeVideoMetadata,
} from '@clipforge/shared';
import { env } from '../../config/env';
import { UserGoogleIntegration } from '../../models';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';
import { probeMediaFile } from '../mediaProbeService';
import {
  GoogleOAuthProvider,
  SUPPORTED_DRIVE_VIDEO_MIME_TYPES,
} from './GoogleOAuthProvider';
import type { AcquiredMediaResult, MediaAcquireOptions } from './types';

const DRIVE_FILE_FIELDS =
  'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,thumbnailLink,iconLink,description,appProperties,capabilities(canDownload),videoMediaMetadata(width,height,durationMillis)';

const SUPPORTED_MIME_SET = new Set<string>(SUPPORTED_DRIVE_VIDEO_MIME_TYPES);

/**
 * Hard streaming ceiling (25 GB) supporting up to 10-hour (36,000s) 1080p/4K exports
 * streamed directly to disk with constant bounded RAM.
 */
const MAX_DRIVE_VIDEO_BYTES = 25 * 1024 * 1024 * 1024;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'your',
  'youtube',
  'video',
  'final',
  'export',
  'render',
  'master',
  '1080p',
  '2160p',
  '720p',
  '4k',
  'hd',
  'mp4',
  'mov',
  'mkv',
  'webm',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeTitle(raw: string): string[] {
  const withoutExt = raw.replace(/\.[a-z0-9]{2,5}$/i, '');
  return withoutExt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok));
}

function formatDurationBrief(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function containsYouTubeVideoId(text: string | undefined, videoId: string): boolean {
  if (!text || !videoId) return false;
  const trimmed = text.trim();
  const withoutExt = trimmed.replace(/\.[a-z0-9]{2,5}$/i, '');
  if (withoutExt === videoId) return true;

  const nonAlphaNumBoundary = new RegExp(
    `(^|[^A-Za-z0-9])${escapeRegex(videoId)}([^A-Za-z0-9]|$)`
  );
  if (nonAlphaNumBoundary.test(withoutExt)) return true;

  return (
    withoutExt.endsWith(`_${videoId}`) ||
    withoutExt.endsWith(`-${videoId}`) ||
    withoutExt.startsWith(`${videoId}_`) ||
    withoutExt.startsWith(`${videoId}-`) ||
    withoutExt.includes(`_${videoId}_`) ||
    withoutExt.includes(`-${videoId}-`) ||
    withoutExt.includes(`[${videoId}]`) ||
    withoutExt.includes(`(${videoId})`)
  );
}

export function matchDriveFileToYouTubeVideo(
  file: {
    id: string;
    name: string;
    durationSec: number | null;
    description?: string;
    appProperties?: Record<string, string>;
  },
  targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>
): DriveVideoMatchInfo {
  if (!targetVideo) {
    return {
      confidence: 'none',
      score: 0,
      matchedByVideoId: false,
      matchedByTitle: false,
      matchedByDuration: false,
      durationDeltaSec: null,
    };
  }

  const propVideoId =
    file.appProperties?.youtubeVideoId || file.appProperties?.videoId || '';
  const matchedByVideoId =
    propVideoId === targetVideo.videoId ||
    containsYouTubeVideoId(file.name, targetVideo.videoId) ||
    containsYouTubeVideoId(file.description, targetVideo.videoId);

  const ytTokens = tokenizeTitle(targetVideo.title || '').filter(
    (tok) => tok !== targetVideo.videoId.toLowerCase()
  );
  const fileTokens = new Set(
    tokenizeTitle(file.name || '').filter(
      (tok) => tok !== targetVideo.videoId.toLowerCase()
    )
  );

  let titleOverlapRatio = 0;
  if (ytTokens.length > 0 && fileTokens.size > 0) {
    let hits = 0;
    for (const tok of ytTokens) {
      if (fileTokens.has(tok)) hits += 1;
    }
    titleOverlapRatio = hits / ytTokens.length;
  }
  const matchedByTitle = titleOverlapRatio >= 0.5;

  let durationDeltaSec: number | null = null;
  let matchedByDuration = false;
  let warning: string | undefined;

  if (
    typeof targetVideo.durationSec === 'number' &&
    targetVideo.durationSec > 0 &&
    typeof file.durationSec === 'number' &&
    file.durationSec > 0
  ) {
    durationDeltaSec = Math.round(Math.abs(file.durationSec - targetVideo.durationSec));
    const closeTolerance = Math.max(4, Math.round(targetVideo.durationSec * 0.025));
    matchedByDuration = durationDeltaSec <= closeTolerance;

    const warningTolerance = Math.max(15, Math.round(targetVideo.durationSec * 0.1));
    if (durationDeltaSec > warningTolerance) {
      warning = `Drive file duration (${formatDurationBrief(
        file.durationSec
      )}) differs from YouTube video duration (${formatDurationBrief(
        targetVideo.durationSec
      )}). Verify this is the matching export.`;
    }
  }

  let confidence: DriveMatchConfidence = 'none';
  let score = 0;

  if (matchedByVideoId) {
    confidence = 'exact';
    score = warning ? 88 : 100;
  } else if (titleOverlapRatio >= 0.6 && (matchedByDuration || targetVideo.durationSec === null)) {
    confidence = 'high';
    score = matchedByDuration ? 86 : 80;
  } else if (titleOverlapRatio >= 0.75 && !warning) {
    confidence = 'high';
    score = 82;
  } else if (
    titleOverlapRatio >= 0.4 ||
    (matchedByDuration && (targetVideo.durationSec || 0) >= 20)
  ) {
    confidence = 'medium';
    score = Math.round(45 + titleOverlapRatio * 25 + (matchedByDuration ? 15 : 0));
  }

  return {
    confidence,
    score,
    matchedByVideoId,
    matchedByTitle,
    matchedByDuration,
    durationDeltaSec,
    warning,
  };
}

export interface DetailedDriveVideoFile extends GoogleDriveVideoFile {
  md5Checksum?: string;
  canDownload?: boolean;
}

function isSupportedVideoMime(mimeType: string, filename = ''): boolean {
  const lower = mimeType.trim().toLowerCase();
  if (SUPPORTED_MIME_SET.has(lower)) return true;
  if (lower.startsWith('video/')) return true;
  if (
    lower === 'application/octet-stream' &&
    /\.(mp4|mov|webm|mkv|m4v)$/i.test(filename)
  ) {
    return true;
  }
  return false;
}

function mapRawDriveFile(
  raw: any,
  targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>
): DetailedDriveVideoFile {
  const durationMillis = raw?.videoMediaMetadata?.durationMillis
    ? Number(raw.videoMediaMetadata.durationMillis)
    : null;
  const durationSec =
    durationMillis && Number.isFinite(durationMillis) && durationMillis > 0
      ? Math.round(durationMillis / 1000)
      : null;
  const sizeBytes =
    raw?.size !== undefined && raw?.size !== null && Number.isFinite(Number(raw.size))
      ? Number(raw.size)
      : null;

  const baseFile: DetailedDriveVideoFile = {
    id: String(raw.id),
    name: String(raw.name || `drive_video_${raw.id}.mp4`),
    mimeType: String(raw.mimeType || 'video/mp4'),
    sizeBytes,
    durationSec,
    width: raw?.videoMediaMetadata?.width ? Number(raw.videoMediaMetadata.width) : null,
    height: raw?.videoMediaMetadata?.height ? Number(raw.videoMediaMetadata.height) : null,
    thumbnailUrl: raw?.thumbnailLink ? String(raw.thumbnailLink) : undefined,
    modifiedTime: raw?.modifiedTime ? String(raw.modifiedTime) : undefined,
    md5Checksum:
      typeof raw?.md5Checksum === 'string' && raw.md5Checksum.trim()
        ? raw.md5Checksum.trim().toLowerCase()
        : undefined,
    canDownload:
      raw?.capabilities?.canDownload !== undefined
        ? Boolean(raw.capabilities.canDownload)
        : true,
  };

  const match = matchDriveFileToYouTubeVideo(
    {
      id: baseFile.id,
      name: baseFile.name,
      durationSec: baseFile.durationSec,
      description: typeof raw?.description === 'string' ? raw.description : undefined,
      appProperties:
        raw?.appProperties && typeof raw.appProperties === 'object'
          ? raw.appProperties
          : undefined,
    },
    targetVideo
  );

  return {
    ...baseFile,
    match,
  };
}

function inferExtensionFromNameOrMime(name: string, mimeType: string): string {
  const ext = path.extname(name).toLowerCase();
  if (['.mp4', '.mov', '.webm', '.mkv', '.m4v'].includes(ext)) return ext;
  const lower = mimeType.toLowerCase();
  if (lower.includes('quicktime')) return '.mov';
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('matroska')) return '.mkv';
  return '.mp4';
}

async function computeFileMd5Hex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

function removeFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup errors
  }
}

export class GoogleDriveMediaProvider {
  readonly name = 'google_drive';

  constructor(private readonly googleOAuthProvider: GoogleOAuthProvider) {}

  private async fetchDriveApiWithTokenRetry(
    userId: string,
    buildRequest: (accessToken: string) => Promise<Response>
  ): Promise<Response> {
    const firstToken = await this.googleOAuthProvider.getValidAccessToken(userId, {
      requiredScope: 'drive',
    });
    const firstRes = await buildRequest(firstToken.accessToken);
    if (firstRes.status !== 401) {
      return firstRes;
    }
    await firstRes.body?.cancel().catch(() => undefined);

    // Access token was rejected upstream (expired early or revoked) -> force refresh once
    const refreshed = await this.googleOAuthProvider.getValidAccessToken(userId, {
      requiredScope: 'drive',
      forceRefresh: true,
    });
    return buildRequest(refreshed.accessToken);
  }

  async listUserVideoFiles(
    userId: string,
    options?: {
      query?: string;
      pageToken?: string;
      pageSize?: number;
      targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>;
    }
  ): Promise<{
    files: GoogleDriveVideoFile[];
    nextPageToken?: string;
    autoMatchedFile?: GoogleDriveVideoFile;
  }> {
    const clauses = ["mimeType contains 'video/'", 'trashed = false'];
    if (options?.query && options.query.trim()) {
      const escapedQuery = options.query
        .trim()
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
      clauses.push(`name contains '${escapedQuery}'`);
    }

    const pageSize = Math.min(Math.max(options?.pageSize || 25, 1), 50);
    const base = env.GOOGLE_DRIVE_API_BASE_URL.replace(/\/+$/, '');
    const listUrl = new URL(`${base}/files`);
    listUrl.searchParams.set('q', clauses.join(' and '));
    listUrl.searchParams.set('pageSize', String(pageSize));
    listUrl.searchParams.set('orderBy', 'modifiedTime desc');
    listUrl.searchParams.set('supportsAllDrives', 'true');
    listUrl.searchParams.set('includeItemsFromAllDrives', 'true');
    listUrl.searchParams.set('fields', `nextPageToken,files(${DRIVE_FILE_FIELDS})`);
    if (options?.pageToken) {
      listUrl.searchParams.set('pageToken', options.pageToken);
    }

    const res = await this.fetchDriveApiWithTokenRetry(userId, (accessToken) =>
      fetch(listUrl.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      })
    );

    if (res.status === 401) {
      throw new ForbiddenError(
        'Google Drive session expired or access was revoked. Reconnect Google Drive.',
        'GOOGLE_DRIVE_UNAUTHORIZED'
      );
    }
    if (res.status === 403) {
      throw new ForbiddenError(
        'Google Drive API denied access. Ensure Google Drive file permission is granted for your Google account.',
        'GOOGLE_DRIVE_ACCESS_DENIED'
      );
    }
    if (!res.ok) {
      throw new AppError(
        `Failed to list video files from Google Drive (HTTP ${res.status}).`,
        502,
        'GOOGLE_DRIVE_LIST_FAILED'
      );
    }

    const data: any = await res.json();
    const rawFiles = Array.isArray(data?.files) ? data.files : [];
    const mapped = rawFiles
      .filter(
        (f: any) =>
          f?.id && isSupportedVideoMime(String(f.mimeType || ''), String(f.name || ''))
      )
      .map((f: any) => mapRawDriveFile(f, options?.targetVideo));

    if (options?.targetVideo) {
      mapped.sort((a: GoogleDriveVideoFile, b: GoogleDriveVideoFile) => {
        const scoreDiff = (b.match?.score || 0) - (a.match?.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''));
      });
    }

    const autoMatchedFile = mapped.find(
      (f: GoogleDriveVideoFile) =>
        f.match?.confidence === 'exact' && !f.match?.warning
    );

    return {
      files: mapped,
      nextPageToken: data?.nextPageToken ? String(data.nextPageToken) : undefined,
      autoMatchedFile,
    };
  }

  async findCandidateMatchesForYouTubeVideo(
    userId: string,
    targetVideo: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>
  ): Promise<{
    autoMatchedFile?: GoogleDriveVideoFile;
    candidates: GoogleDriveVideoFile[];
  }> {
    const byIdResult = await this.listUserVideoFiles(userId, {
      query: targetVideo.videoId,
      pageSize: 10,
      targetVideo,
    });

    if (byIdResult.autoMatchedFile) {
      return {
        autoMatchedFile: byIdResult.autoMatchedFile,
        candidates: byIdResult.files.slice(0, 8),
      };
    }

    const recentResult = await this.listUserVideoFiles(userId, {
      pageSize: 20,
      targetVideo,
    });

    const combinedMap = new Map<string, GoogleDriveVideoFile>();
    for (const f of [...byIdResult.files, ...recentResult.files]) {
      combinedMap.set(f.id, f);
    }
    const merged = Array.from(combinedMap.values()).sort(
      (a, b) => (b.match?.score || 0) - (a.match?.score || 0)
    );

    const exact = merged.find(
      (f) => f.match?.confidence === 'exact' && !f.match?.warning
    );

    return {
      autoMatchedFile: exact,
      candidates: merged.slice(0, 8),
    };
  }

  async inspectDriveFile(
    userId: string,
    fileId: string,
    targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>
  ): Promise<DetailedDriveVideoFile> {
    if (!fileId || !/^[A-Za-z0-9_-]{3,128}$/.test(fileId.trim())) {
      throw new BadRequestError(
        'Invalid Google Drive file ID.',
        'INVALID_GOOGLE_DRIVE_FILE_ID'
      );
    }

    const base = env.GOOGLE_DRIVE_API_BASE_URL.replace(/\/+$/, '');
    const metaUrl = new URL(`${base}/files/${encodeURIComponent(fileId.trim())}`);
    metaUrl.searchParams.set('supportsAllDrives', 'true');
    metaUrl.searchParams.set('fields', DRIVE_FILE_FIELDS);

    const res = await this.fetchDriveApiWithTokenRetry(userId, (accessToken) =>
      fetch(metaUrl.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12000),
      })
    );

    if (res.status === 404) {
      throw new NotFoundError(
        'Selected Google Drive video file was not found or is not accessible to your connected Google account.',
        'GOOGLE_DRIVE_FILE_NOT_FOUND'
      );
    }
    if (res.status === 403 || res.status === 401) {
      throw new ForbiddenError(
        'Your connected Google account does not have permission to access this Google Drive file.',
        'GOOGLE_DRIVE_ACCESS_DENIED'
      );
    }
    if (!res.ok) {
      throw new AppError(
        `Unable to inspect Google Drive file metadata (HTTP ${res.status}).`,
        502,
        'GOOGLE_DRIVE_INSPECT_FAILED'
      );
    }

    const raw: any = await res.json();
    const mimeType = String(raw?.mimeType || '');
    const name = String(raw?.name || fileId);

    if (!isSupportedVideoMime(mimeType, name)) {
      throw new BadRequestError(
        `Selected Google Drive item "${name}" has MIME type "${mimeType || 'unknown'}" and is not a supported video file. Select an MP4, MOV, WebM, or MKV video.`,
        'GOOGLE_DRIVE_NOT_VIDEO'
      );
    }

    const mapped = mapRawDriveFile(raw, targetVideo);
    if (mapped.canDownload === false) {
      throw new ForbiddenError(
        `Google Drive download is restricted by file owner permissions for "${mapped.name}".`,
        'GOOGLE_DRIVE_DOWNLOAD_DENIED'
      );
    }

    if (mapped.sizeBytes !== null && mapped.sizeBytes <= 0) {
      throw new BadRequestError(
        `Selected Google Drive file "${mapped.name}" is empty (0 bytes).`,
        'EMPTY_VIDEO_FILE'
      );
    }

    if (mapped.sizeBytes !== null && mapped.sizeBytes > MAX_DRIVE_VIDEO_BYTES) {
      throw new BadRequestError(
        `Selected Google Drive video exceeds maximum supported file size (${Math.round(
          MAX_DRIVE_VIDEO_BYTES / (1024 * 1024 * 1024)
        )} GB).`,
        'REMOTE_FILE_TOO_LARGE'
      );
    }

    return mapped;
  }

  /**
   * Verifies a Picker-selected Google Drive file using the authenticated user's OAuth credentials,
   * validates MIME type / size / duration, and registers the file in that user's authorized selection list.
   */
  async verifyAndRegisterSelectedFile(
    userId: string,
    fileId: string,
    maxDurationSec = env.MAX_VIDEO_DURATION_SEC
  ): Promise<GoogleDriveVideoFile> {
    const verified = await this.inspectDriveFile(userId, fileId);

    if (verified.durationSec && verified.durationSec > maxDurationSec + 5) {
      throw new BadRequestError(
        `Selected Google Drive video duration (${Math.round(
          verified.durationSec / 60
        )} min) exceeds maximum allowed duration (${Math.round(maxDurationSec / 60)} min).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    const integration = await UserGoogleIntegration.findOne({ userId });
    if (!integration) {
      throw new ForbiddenError(
        'Google Drive is not connected for this account.',
        'GOOGLE_OAUTH_NOT_CONNECTED'
      );
    }

    const filtered = (integration.authorizedFiles || []).filter(
      (entry) => entry.fileId !== verified.id
    );
    filtered.unshift({
      fileId: verified.id,
      name: verified.name,
      mimeType: verified.mimeType,
      sizeBytes: verified.sizeBytes,
      durationSec: verified.durationSec,
      width: verified.width ?? null,
      height: verified.height ?? null,
      thumbnailUrl: verified.thumbnailUrl,
      selectedAt: new Date(),
    });
    integration.authorizedFiles = filtered.slice(0, 100);
    await integration.save();

    return {
      id: verified.id,
      name: verified.name,
      mimeType: verified.mimeType,
      sizeBytes: verified.sizeBytes,
      durationSec: verified.durationSec,
      width: verified.width,
      height: verified.height,
      thumbnailUrl: verified.thumbnailUrl,
      modifiedTime: verified.modifiedTime,
      match: verified.match,
    };
  }

  /**
   * Validates that `fileId` was explicitly selected and authorized by this ClipForge user.
   */
  async assertFileAuthorizedForUser(userId: string, fileId: string): Promise<void> {
    const cleanId = fileId.trim();
    const integration = await UserGoogleIntegration.findOne({ userId }).lean();
    if (!integration) {
      throw new ForbiddenError(
        'Google Drive is not connected for this user.',
        'GOOGLE_OAUTH_NOT_CONNECTED'
      );
    }
    const found = (integration.authorizedFiles || []).some(
      (entry) => entry.fileId === cleanId
    );
    if (!found) {
      throw new ForbiddenError(
        'This Google Drive file has not been selected via Google Picker for your account. Click "Select Video from Drive" to authorize the file first.',
        'GOOGLE_DRIVE_FILE_NOT_AUTHORIZED'
      );
    }
  }

  /**
   * Streams the selected Google Drive video to temporary disk storage with constant RAM,
   * resumable Byte-Range retries for large files, size + MD5 checksum integrity verification,
   * and FFprobe media container validation.
   */
  async acquireDriveFileToDisk(
    referenceId: string,
    destDir: string,
    options: Required<Pick<MediaAcquireOptions, 'userId' | 'googleDriveFileId'>> &
      MediaAcquireOptions & {
        requireAuthorizedSelection?: boolean;
        maxDownloadRetries?: number;
        targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>;
      }
  ): Promise<AcquiredMediaResult> {
    if (options.requireAuthorizedSelection) {
      await this.assertFileAuthorizedForUser(options.userId, options.googleDriveFileId);
    }

    const driveFile = await this.inspectDriveFile(
      options.userId,
      options.googleDriveFileId,
      options.targetVideo
    );

    const maxDurationSec = options.maxDurationSec || env.MAX_VIDEO_DURATION_SEC;
    if (driveFile.durationSec && driveFile.durationSec > maxDurationSec + 5) {
      throw new BadRequestError(
        `Selected Google Drive video duration (${Math.round(
          driveFile.durationSec / 60
        )} min) exceeds maximum allowed duration (${Math.round(maxDurationSec / 60)} min).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    fs.mkdirSync(destDir, { recursive: true });
    const ext = inferExtensionFromNameOrMime(driveFile.name, driveFile.mimeType);
    const safeRef = referenceId.replace(/[^A-Za-z0-9_-]/g, '_');
    const destPath = path.join(destDir, `gdrive_${safeRef}${ext}`);
    const partPath = `${destPath}.part`;

    removeFileIfExists(destPath);
    removeFileIfExists(partPath);

    options.onProgress?.(10, `Streaming "${driveFile.name}" from Google Drive...`);

    const base = env.GOOGLE_DRIVE_API_BASE_URL.replace(/\/+$/, '');
    const downloadUrl = new URL(
      `${base}/files/${encodeURIComponent(driveFile.id)}`
    );
    downloadUrl.searchParams.set('alt', 'media');
    downloadUrl.searchParams.set('supportsAllDrives', 'true');

    const maxAttempts = Math.max(1, options.maxDownloadRetries ?? 3);
    const expectedTotalBytes = driveFile.sizeBytes || 0;
    let finalContentType = driveFile.mimeType || 'video/mp4';

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (options.signal?.aborted) {
          throw new AppError('Download aborted by user.', 499, 'JOB_CANCELLED');
        }

        const existingOffset = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
        if (expectedTotalBytes > 0 && existingOffset === expectedTotalBytes) {
          break;
        }

        try {
          const res = await this.fetchDriveApiWithTokenRetry(
            options.userId,
            (accessToken) => {
              const headers: Record<string, string> = {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'video/*,application/octet-stream,*/*;q=0.8',
              };
              if (existingOffset > 0) {
                headers.Range = `bytes=${existingOffset}-`;
              }
              return fetch(downloadUrl.toString(), {
                method: 'GET',
                headers,
                signal: options.signal,
              });
            }
          );

          if (res.status === 403 || res.status === 401) {
            throw new ForbiddenError(
              'Google Drive denied media download for this file (check permissions or Drive quota).',
              'GOOGLE_DRIVE_DOWNLOAD_DENIED'
            );
          }
          if (res.status === 404) {
            throw new NotFoundError(
              'Google Drive video file could not be downloaded because it no longer exists.',
              'GOOGLE_DRIVE_FILE_NOT_FOUND'
            );
          }
          if (!res.ok && res.status !== 206) {
            throw new AppError(
              `Google Drive media stream returned HTTP ${res.status}.`,
              502,
              'GOOGLE_DRIVE_DOWNLOAD_FAILED'
            );
          }
          if (!res.body) {
            throw new AppError(
              'Google Drive returned an empty media stream body.',
              502,
              'GOOGLE_DRIVE_DOWNLOAD_FAILED'
            );
          }

          const contentType = (
            res.headers.get('content-type') ||
            driveFile.mimeType ||
            'video/mp4'
          )
            .split(';')[0]
            .trim()
            .toLowerCase();

          if (contentType.startsWith('text/') || contentType === 'application/json') {
            throw new BadRequestError(
              `Google Drive returned "${contentType}" instead of binary video media.`,
              'YOUTUBE_MEDIA_NOT_VIDEO'
            );
          }
          finalContentType = contentType;

          // Append only when upstream honored our byte-range request with HTTP 206
          const isResumedPartial = existingOffset > 0 && res.status === 206;
          const startBytes = isResumedPartial ? existingOffset : 0;
          const totalBytes =
            expectedTotalBytes ||
            startBytes + Number(res.headers.get('content-length') || 0);

          let currentBytes = startBytes;
          let lastReportedPct = 10;

          const progressTransform = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              currentBytes += chunk.length;
              if (currentBytes > MAX_DRIVE_VIDEO_BYTES) {
                callback(
                  new BadRequestError(
                    'Google Drive video stream exceeded maximum permitted file size.',
                    'REMOTE_FILE_TOO_LARGE'
                  )
                );
                return;
              }
              if (totalBytes > 0) {
                const pct = Math.min(
                  90,
                  10 + Math.round((currentBytes / totalBytes) * 80)
                );
                if (pct >= lastReportedPct + 5) {
                  lastReportedPct = pct;
                  options.onProgress?.(
                    pct,
                    `Downloading "${driveFile.name}" from Google Drive (${Math.round(
                      (currentBytes / totalBytes) * 100
                    )}%)...`
                  );
                }
              }
              callback(null, chunk);
            },
          });

          await pipeline(
            Readable.fromWeb(res.body as any),
            progressTransform,
            fs.createWriteStream(partPath, { flags: isResumedPartial ? 'a' : 'w' }),
            { signal: options.signal }
          );

          const diskBytesAfterAttempt = fs.existsSync(partPath)
            ? fs.statSync(partPath).size
            : 0;
          if (expectedTotalBytes > 0 && diskBytesAfterAttempt < expectedTotalBytes) {
            throw new AppError(
              `Incomplete Google Drive stream (${diskBytesAfterAttempt}/${expectedTotalBytes} bytes received).`,
              502,
              'GOOGLE_DRIVE_STREAM_INTERRUPTED'
            );
          }

          break;
        } catch (attemptErr: any) {
          const nonRetryable =
            attemptErr instanceof BadRequestError ||
            attemptErr instanceof ForbiddenError ||
            attemptErr instanceof NotFoundError ||
            options.signal?.aborted ||
            attemptErr?.code === 'GOOGLE_OAUTH_REVOKED' ||
            attemptErr?.code === 'GOOGLE_OAUTH_NOT_CONNECTED';

          if (nonRetryable || attempt >= maxAttempts) {
            throw attemptErr;
          }

          const partialSaved = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
          logger.warn('Transient Google Drive stream error; resuming download', {
            fileId: driveFile.id,
            attempt,
            maxAttempts,
            partialSavedBytes: partialSaved,
            err: attemptErr?.message,
          });
          options.onProgress?.(
            15,
            `Connection interrupted at ${Math.round(
              partialSaved / 1024
            )} KB — resuming Google Drive download (attempt ${attempt + 1}/${maxAttempts})...`
          );
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }

      // Verify downloaded file byte-length & MD5 checksum integrity before FFprobe
      if (!fs.existsSync(partPath)) {
        throw new AppError(
          'Google Drive download did not write temporary video file.',
          502,
          'GOOGLE_DRIVE_DOWNLOAD_FAILED'
        );
      }

      const finalSize = fs.statSync(partPath).size;
      if (expectedTotalBytes > 0 && finalSize !== expectedTotalBytes) {
        throw new AppError(
          `Downloaded Google Drive file size (${finalSize} bytes) did not match expected size (${expectedTotalBytes} bytes).`,
          502,
          'GOOGLE_DRIVE_INTEGRITY_MISMATCH'
        );
      }

      if (driveFile.md5Checksum && /^[a-f0-9]{32}$/i.test(driveFile.md5Checksum)) {
        options.onProgress?.(92, 'Verifying Google Drive file MD5 checksum integrity...');
        const computedMd5 = await computeFileMd5Hex(partPath);
        if (computedMd5 !== driveFile.md5Checksum.toLowerCase()) {
          throw new BadRequestError(
            'Downloaded Google Drive video failed MD5 checksum integrity verification (corrupted transfer).',
            'GOOGLE_DRIVE_CHECKSUM_MISMATCH'
          );
        }
      }

      fs.renameSync(partPath, destPath);

      options.onProgress?.(95, 'Validating Google Drive video container via FFprobe...');
      const probe = await probeMediaFile(destPath);
      if (probe.width <= 0 || probe.height <= 0) {
        throw new BadRequestError(
          'Downloaded Google Drive file does not contain a valid decodable video stream.',
          'YOUTUBE_MEDIA_INVALID_STREAM'
        );
      }
      if (probe.durationSec > maxDurationSec + 5) {
        throw new BadRequestError(
          `Video duration (${Math.round(
            probe.durationSec / 60
          )} min) exceeds maximum allowed (${Math.round(maxDurationSec / 60)} min).`,
          'VIDEO_DURATION_LIMIT_EXCEEDED'
        );
      }

      options.onProgress?.(100, 'Google Drive source video verified and ready.');
      return {
        localFilePath: destPath,
        adapterName: this.name,
        sourceType: 'google_drive',
        mimeType: finalContentType.startsWith('video/')
          ? finalContentType
          : driveFile.mimeType,
        probe,
        matchedDriveFile: driveFile,
        cleanupAfterStore: true,
      };
    } catch (err) {
      removeFileIfExists(partPath);
      removeFileIfExists(destPath);
      throw err;
    }
  }
}
