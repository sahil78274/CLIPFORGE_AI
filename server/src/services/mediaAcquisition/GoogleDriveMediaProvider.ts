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
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors';
import { probeMediaFile } from '../mediaProbeService';
import {
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleOAuthProvider,
} from './GoogleOAuthProvider';
import type { AcquiredMediaResult, MediaAcquireOptions } from './types';

const DRIVE_FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,description,appProperties,videoMediaMetadata(width,height,durationMillis)';

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

  // Title token similarity
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

  // Duration comparison
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

function mapRawDriveFile(
  raw: any,
  targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>
): GoogleDriveVideoFile {
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

  const baseFile = {
    id: String(raw.id),
    name: String(raw.name || `drive_video_${raw.id}.mp4`),
    mimeType: String(raw.mimeType || 'video/mp4'),
    sizeBytes,
    durationSec,
    width: raw?.videoMediaMetadata?.width ? Number(raw.videoMediaMetadata.width) : null,
    height: raw?.videoMediaMetadata?.height ? Number(raw.videoMediaMetadata.height) : null,
    thumbnailUrl: raw?.thumbnailLink ? String(raw.thumbnailLink) : undefined,
    modifiedTime: raw?.modifiedTime ? String(raw.modifiedTime) : undefined,
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

export class GoogleDriveMediaProvider {
  readonly name = 'google_drive';

  constructor(private readonly googleOAuthProvider: GoogleOAuthProvider) {}

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
    const { accessToken } = await this.googleOAuthProvider.getValidAccessToken(
      userId,
      GOOGLE_DRIVE_READONLY_SCOPE
    );

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

    const res = await fetch(listUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401) {
      throw new ForbiddenError(
        'Google Drive session expired or access was revoked. Reconnect your Google account and approve Google Drive read access.',
        'GOOGLE_DRIVE_UNAUTHORIZED'
      );
    }
    if (res.status === 403) {
      throw new ForbiddenError(
        'Google Drive API denied access. Ensure Google Drive read permission is granted for your Google account.',
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
      .filter((f: any) => f?.id && String(f.mimeType || '').startsWith('video/'))
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
    // First search directly by YouTube videoId in filename, then fall back to recent Drive videos
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
  ): Promise<GoogleDriveVideoFile> {
    if (!fileId || !/^[A-Za-z0-9_-]{3,128}$/.test(fileId.trim())) {
      throw new BadRequestError('Invalid Google Drive file ID.', 'INVALID_GOOGLE_DRIVE_FILE_ID');
    }

    const { accessToken } = await this.googleOAuthProvider.getValidAccessToken(
      userId,
      GOOGLE_DRIVE_READONLY_SCOPE
    );

    const base = env.GOOGLE_DRIVE_API_BASE_URL.replace(/\/+$/, '');
    const metaUrl = new URL(`${base}/files/${encodeURIComponent(fileId.trim())}`);
    metaUrl.searchParams.set('supportsAllDrives', 'true');
    metaUrl.searchParams.set('fields', DRIVE_FILE_FIELDS);

    const res = await fetch(metaUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.status === 404) {
      throw new NotFoundError(
        'Selected Google Drive video file was not found or is no longer shared with your connected Google account.',
        'GOOGLE_DRIVE_FILE_NOT_FOUND'
      );
    }
    if (res.status === 403 || res.status === 401) {
      throw new ForbiddenError(
        'Your connected Google account does not have permission to read this Google Drive file.',
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
    const mimeType = String(raw?.mimeType || '').toLowerCase();
    if (!mimeType.startsWith('video/')) {
      throw new BadRequestError(
        `Selected Google Drive item "${raw?.name || fileId}" has MIME type "${raw?.mimeType || 'unknown'}" and is not a video file. Please select an MP4, MOV, WebM, or MKV video export.`,
        'GOOGLE_DRIVE_NOT_VIDEO'
      );
    }

    return mapRawDriveFile(raw, targetVideo);
  }

  async acquireDriveFileToDisk(
    videoId: string,
    destDir: string,
    options: Required<Pick<MediaAcquireOptions, 'userId' | 'googleDriveFileId'>> &
      MediaAcquireOptions & {
        targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>;
      }
  ): Promise<AcquiredMediaResult> {
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

    const maxBytes = 20 * 1024 * 1024 * 1024; // 20 GB streamed ceiling for up to 10-hour exports
    if (driveFile.sizeBytes && driveFile.sizeBytes > maxBytes) {
      throw new BadRequestError(
        `Selected Google Drive video file exceeds the maximum allowed size (${Math.round(
          maxBytes / (1024 * 1024 * 1024)
        )} GB).`,
        'REMOTE_FILE_TOO_LARGE'
      );
    }

    const { accessToken } = await this.googleOAuthProvider.getValidAccessToken(
      options.userId,
      GOOGLE_DRIVE_READONLY_SCOPE
    );

    fs.mkdirSync(destDir, { recursive: true });
    const ext = inferExtensionFromNameOrMime(driveFile.name, driveFile.mimeType);
    const destPath = path.join(destDir, `yt_drive_${videoId}${ext}`);

    options.onProgress?.(
      10,
      `Streaming "${driveFile.name}" from Google Drive...`
    );

    const base = env.GOOGLE_DRIVE_API_BASE_URL.replace(/\/+$/, '');
    const downloadUrl = new URL(
      `${base}/files/${encodeURIComponent(driveFile.id)}`
    );
    downloadUrl.searchParams.set('alt', 'media');
    downloadUrl.searchParams.set('supportsAllDrives', 'true');

    const res = await fetch(downloadUrl.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'video/*,application/octet-stream,*/*;q=0.8',
      },
      signal: options.signal,
    });

    if (res.status === 403 || res.status === 401) {
      throw new ForbiddenError(
        'Google Drive denied media download for this file (check download permissions or Drive quota).',
        'GOOGLE_DRIVE_DOWNLOAD_DENIED'
      );
    }
    if (res.status === 404) {
      throw new NotFoundError(
        'Google Drive video file could not be downloaded because it no longer exists.',
        'GOOGLE_DRIVE_FILE_NOT_FOUND'
      );
    }
    if (!res.ok || !res.body) {
      throw new AppError(
        `Google Drive media stream returned HTTP ${res.status}.`,
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
        `Google Drive returned "${contentType}" instead of binary video media. Ensure the selected file is a downloadable video export.`,
        'YOUTUBE_MEDIA_NOT_VIDEO'
      );
    }

    const totalExpected =
      driveFile.sizeBytes || Number(res.headers.get('content-length') || 0);
    let downloadedBytes = 0;
    let lastReportedPct = 10;

    const progressTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxBytes) {
          callback(
            new BadRequestError(
              'Google Drive video stream exceeded maximum permitted file size.',
              'REMOTE_FILE_TOO_LARGE'
            )
          );
          return;
        }
        if (totalExpected > 0) {
          const pct = Math.min(
            90,
            10 + Math.round((downloadedBytes / totalExpected) * 80)
          );
          if (pct >= lastReportedPct + 5) {
            lastReportedPct = pct;
            options.onProgress?.(
              pct,
              `Downloading "${driveFile.name}" from Google Drive (${Math.round(
                (downloadedBytes / totalExpected) * 100
              )}%)...`
            );
          }
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(res.body as any),
        progressTransform,
        fs.createWriteStream(destPath),
        { signal: options.signal }
      );

      options.onProgress?.(94, 'Validating Google Drive video container via FFprobe...');
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
        mimeType: contentType.startsWith('video/') ? contentType : driveFile.mimeType,
        probe,
        matchedDriveFile: driveFile,
        cleanupAfterStore: true,
      };
    } catch (err) {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }
  }
}
