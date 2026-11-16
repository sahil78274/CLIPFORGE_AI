import net from 'net';
import { Types } from 'mongoose';
import {
  DEFAULT_CHUNK_DURATION_SEC,
  DEFAULT_CHUNK_OVERLAP_SEC,
  type ProjectProcessingSettings,
  type YouTubeVideoMetadata,
} from '@clipforge/shared';
import { env } from '../config/env';
import {
  ProcessingJob,
  Project,
  getOrCreateSystemConfig,
} from '../models';
import { isPrivateOrReservedIp } from './urlSafetyService';
import {
  OwnerAuthorizedExportAdapter,
  getYouTubeMediaSourceAdapter,
  type MediaAvailabilityReport,
} from './youtubeMediaSourceAdapter';
import {
  calculateJobCreditCost,
  ensureUserWallet,
  reserveCreditsForJob,
} from './walletService';
import { enqueueProcessingJob, getActiveQueueMode } from '../queues/videoQueue';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

/**
 * Validates any supported YouTube URL format and extracts the canonical 11-char Video ID.
 */
export function parseAndValidateYouTubeUrl(rawUrl: string): {
  videoId: string;
  canonicalUrl: string;
} {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new BadRequestError('Please enter a YouTube video URL.', 'INVALID_YOUTUBE_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new BadRequestError(
      'Invalid URL syntax. Example: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'INVALID_YOUTUBE_URL'
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestError(
      'Only HTTP and HTTPS YouTube URLs are supported.',
      'INVALID_YOUTUBE_URL'
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (net.isIP(host) && isPrivateOrReservedIp(host))
  ) {
    throw new ForbiddenError(
      'Private, loopback, and internal network addresses are blocked (SSRF protection).',
      'SSRF_BLOCKED'
    );
  }

  if (!YOUTUBE_HOSTS.has(host)) {
    throw new BadRequestError(
      `Unsupported domain "${host}". Paste a valid youtube.com or youtu.be video link.`,
      'INVALID_YOUTUBE_URL'
    );
  }

  let candidateId: string | null = null;
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    candidateId = segments[0] || null;
  } else if (parsed.pathname === '/watch') {
    candidateId = parsed.searchParams.get('v');
  } else if (
    segments.length >= 2 &&
    ['shorts', 'live', 'embed', 'v'].includes(segments[0].toLowerCase())
  ) {
    candidateId = segments[1];
  }

  if (!candidateId || !VIDEO_ID_REGEX.test(candidateId)) {
    throw new BadRequestError(
      'Could not detect a valid 11-character YouTube video ID in this URL. Channel and playlist-only URLs without a video ID are not supported.',
      'MISSING_YOUTUBE_VIDEO_ID'
    );
  }

  return {
    videoId: candidateId,
    canonicalUrl: `https://www.youtube.com/watch?v=${candidateId}`,
  };
}

/**
 * Parses ISO-8601 duration strings from YouTube Data API v3 (e.g. "PT10H0M0S" -> 36000).
 */
export function parseIso8601DurationToSeconds(isoDuration: string): number {
  if (!isoDuration || typeof isoDuration !== 'string') return 0;
  const match = isoDuration.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
  );
  if (!match) return 0;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const mins = Number(match[3] || 0);
  const secs = Number(match[4] || 0);
  return Math.round(days * 86400 + hours * 3600 + mins * 60 + secs);
}

export interface YouTubeFetchReport {
  video: YouTubeVideoMetadata;
  mediaAccess: MediaAvailabilityReport;
  chunkPlan: {
    enabled: boolean;
    chunkDurationSec: number;
    chunkOverlapSec: number;
    estimatedChunks: number;
    maxSupportedDurationSec: number;
  };
  estimatedCredits: number;
}

/**
 * Dedicated YouTube Metadata Extraction Service.
 * Strictly separated from video file acquisition: never treats oEmbed JSON or thumbnails as video media.
 */
export async function fetchYouTubeVideoMetadataAndAccess(
  rawUrl: string,
  options?: { authorizedMediaUrl?: string; clipCount?: number }
): Promise<YouTubeFetchReport> {
  const { videoId, canonicalUrl } = parseAndValidateYouTubeUrl(rawUrl);
  const cfg = await getOrCreateSystemConfig();

  if (cfg.supportedPlatforms?.youtube?.enabled === false) {
    throw new ForbiddenError(
      'YouTube importing is currently disabled by the platform administrator.',
      'PLATFORM_DISABLED'
    );
  }

  const mediaAdapter = getYouTubeMediaSourceAdapter();
  const ownerHelper = new OwnerAuthorizedExportAdapter();
  const sidecar = ownerHelper.readSidecarMeta(videoId);

  // Check explicit sidecar privacy status first (used by owner export catalogs & offline environments)
  if (sidecar?.privacyStatus === 'private') {
    throw new ForbiddenError(
      'This YouTube video is private and cannot be imported.',
      'YOUTUBE_VIDEO_PRIVATE'
    );
  }
  if (sidecar?.privacyStatus === 'unavailable') {
    throw new NotFoundError(
      'This YouTube video is unavailable, deleted, or restricted.',
      'YOUTUBE_VIDEO_UNAVAILABLE'
    );
  }

  let metadata: YouTubeVideoMetadata | null = null;

  // 1. Primary Metadata Source: Official YouTube Data API v3 (when YOUTUBE_DATA_API_KEY is configured)
  if (env.YOUTUBE_DATA_API_KEY && env.YOUTUBE_DATA_API_KEY.trim().length > 8) {
    const apiEndpoint =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status` +
      `&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(env.YOUTUBE_DATA_API_KEY)}`;

    try {
      const res = await fetch(apiEndpoint);
      if (res.ok) {
        const payload: any = await res.json();
        const item = payload?.items?.[0];
        if (!item) {
          throw new NotFoundError(
            'YouTube video was not found. It may be private, deleted, or unavailable.',
            'YOUTUBE_VIDEO_UNAVAILABLE'
          );
        }
        const privacy = item?.status?.privacyStatus;
        if (privacy === 'private') {
          throw new ForbiddenError(
            'This YouTube video is private and cannot be processed.',
            'YOUTUBE_VIDEO_PRIVATE'
          );
        }

        const durationSec = parseIso8601DurationToSeconds(
          item?.contentDetails?.duration || ''
        );
        const liveState = item?.snippet?.liveBroadcastContent;
        if (liveState === 'live' && durationSec === 0) {
          throw new BadRequestError(
            'Ongoing live streams without a bounded VOD duration cannot be clipped until the stream finishes.',
            'YOUTUBE_LIVE_UNSUPPORTED'
          );
        }

        const thumbs = item?.snippet?.thumbnails || {};
        const bestThumb =
          thumbs.maxres?.url ||
          thumbs.standard?.url ||
          thumbs.high?.url ||
          thumbs.medium?.url ||
          thumbs.default?.url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        metadata = {
          videoId,
          canonicalUrl,
          title: String(item?.snippet?.title || `YouTube Video (${videoId})`),
          channelName: String(item?.snippet?.channelTitle || 'YouTube Creator'),
          thumbnailUrl: String(bestThumb),
          durationSec: durationSec > 0 ? durationSec : null,
          privacyStatus: privacy === 'unlisted' ? 'unlisted' : 'public',
          isLiveStream: liveState === 'live',
          metadataSource: 'youtube_data_api',
        };
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Fall through to oEmbed / authorized manifest if network to googleapis is unreachable
    }
  }

  // 2. Check media-source adapter availability (which also probes real container duration if local/manifest exists)
  const mediaAccess = await mediaAdapter.checkAvailability(videoId, canonicalUrl, {
    authorizedMediaUrl: options?.authorizedMediaUrl,
  });

  // 3. Secondary Metadata Source: YouTube oEmbed (public title, channel, thumbnail; NEVER treated as video media)
  if (!metadata && env.YOUTUBE_OEMBED_ENDPOINT) {
    try {
      const oembedUrl = `${env.YOUTUBE_OEMBED_ENDPOINT}?url=${encodeURIComponent(
        canonicalUrl
      )}&format=json`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(oembedUrl, { signal: controller.signal }).finally(() =>
        clearTimeout(timer)
      );

      if (res.status === 401 || res.status === 403) {
        throw new ForbiddenError(
          'This YouTube video is private or embedding/access is restricted by the owner.',
          'YOUTUBE_VIDEO_PRIVATE'
        );
      }
      if (res.status === 404) {
        throw new NotFoundError(
          'This YouTube video is unavailable or does not exist.',
          'YOUTUBE_VIDEO_UNAVAILABLE'
        );
      }
      if (res.ok) {
        const oem: any = await res.json();
        metadata = {
          videoId,
          canonicalUrl,
          title: String(sidecar?.title || oem.title || `YouTube Video (${videoId})`),
          channelName: String(
            sidecar?.channelName || oem.author_name || 'YouTube Channel'
          ),
          thumbnailUrl: String(
            sidecar?.thumbnailUrl ||
              oem.thumbnail_url ||
              `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          ),
          durationSec: mediaAccess.probedDurationSec ?? sidecar?.durationSec ?? null,
          privacyStatus: 'public',
          metadataSource: 'youtube_oembed',
        };
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Network offline or oEmbed unreachable -> fall back to authorized export manifest if available
    }
  }

  // 4. Tertiary Metadata Source: Authorized Export Manifest / Probed Media Container
  const manifestMeta = mediaAccess.sidecarMeta || sidecar;
  if (!metadata) {
    if (manifestMeta || mediaAccess.available) {
      metadata = {
        videoId,
        canonicalUrl,
        title: manifestMeta?.title || `YouTube Export (${videoId})`,
        channelName: manifestMeta?.channelName || 'Authorized Channel Export',
        thumbnailUrl:
          manifestMeta?.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        durationSec: mediaAccess.probedDurationSec ?? manifestMeta?.durationSec ?? null,
        privacyStatus: manifestMeta?.privacyStatus || 'public',
        metadataSource: 'authorized_export_manifest',
      };
    } else {
      throw new AppError(
        `Unable to fetch YouTube metadata for video "${videoId}" (external YouTube API/oEmbed unreachable and no authorized export manifest found).`,
        503,
        'YOUTUBE_METADATA_UNAVAILABLE'
      );
    }
  } else if (metadata.durationSec === null && mediaAccess.probedDurationSec) {
    metadata.durationSec = mediaAccess.probedDurationSec;
  }

  const maxSupportedDurationSec = Math.min(
    env.MAX_VIDEO_DURATION_SEC,
    cfg.maxVideoDurationSec || 36000
  );

  if (metadata.durationSec !== null && metadata.durationSec > maxSupportedDurationSec + 5) {
    throw new BadRequestError(
      `YouTube video duration (${Math.round(
        metadata.durationSec / 3600
      )}h ${Math.round((metadata.durationSec % 3600) / 60)}m) exceeds the maximum supported length of ${Math.round(
        maxSupportedDurationSec / 3600
      )} hours (${maxSupportedDurationSec}s).`,
      'VIDEO_DURATION_LIMIT_EXCEEDED'
    );
  }

  const chunkDurationSec = cfg.chunkDurationSec || env.VIDEO_CHUNK_DURATION_SEC || DEFAULT_CHUNK_DURATION_SEC;
  const chunkOverlapSec = cfg.chunkOverlapSec ?? env.VIDEO_CHUNK_OVERLAP_SEC ?? DEFAULT_CHUNK_OVERLAP_SEC;
  const effectiveDurationForEstimate = metadata.durationSec ?? 600;
  // Match Python chunk_manager tail-merging rule (<= 15s remainder merges into final chunk)
  const fullChunks = Math.max(1, Math.floor(effectiveDurationForEstimate / chunkDurationSec));
  const tailRemainderSec = effectiveDurationForEstimate - fullChunks * chunkDurationSec;
  const estimatedChunks =
    effectiveDurationForEstimate <= chunkDurationSec
      ? 1
      : tailRemainderSec > 15
      ? fullChunks + 1
      : fullChunks;

  const estimatedCredits = await calculateJobCreditCost(
    effectiveDurationForEstimate,
    options?.clipCount ?? 3
  );

  return {
    video: metadata,
    mediaAccess,
    chunkPlan: {
      enabled: effectiveDurationForEstimate > chunkDurationSec,
      chunkDurationSec,
      chunkOverlapSec,
      estimatedChunks,
      maxSupportedDurationSec,
    },
    estimatedCredits,
  };
}

/**
 * Initiates an authenticated YouTube URL-to-Clips background job:
 * 1. Validates URL & fetches separated metadata
 * 2. Verifies that an authorized media-source adapter can access actual video media (never fakes clips from oEmbed!)
 * 3. Atomically reserves user credits before background processing begins
 * 4. Creates Project + recoverable chunked ProcessingJob and dispatches worker
 */
export async function initiateYouTubeClipGeneration(params: {
  userId: Types.ObjectId;
  url: string;
  title?: string;
  authorizedMediaUrl?: string;
  settings: ProjectProcessingSettings;
  autoStart?: boolean;
}) {
  const cfg = await getOrCreateSystemConfig();
  const settings: ProjectProcessingSettings = {
    ...params.settings,
    clipCount: Math.min(params.settings.clipCount, cfg.maxClipsPerJob || 10),
  };

  const fetchReport = await fetchYouTubeVideoMetadataAndAccess(params.url, {
    authorizedMediaUrl: params.authorizedMediaUrl,
    clipCount: settings.clipCount,
  });

  if (!fetchReport.mediaAccess.available) {
    throw new AppError(
      fetchReport.mediaAccess.reason ||
        'Actual video media could not be accessed through any configured authorized media-source adapter.',
      fetchReport.mediaAccess.configured ? 422 : 503,
      fetchReport.mediaAccess.configured
        ? 'YOUTUBE_MEDIA_ACCESS_FAILED'
        : 'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED',
      {
        videoId: fetchReport.video.videoId,
        setupInstructions: fetchReport.mediaAccess.setupInstructions,
      }
    );
  }

  await ensureUserWallet(params.userId, false);

  const chunkDurationSec =
    settings.chunkDurationSec ||
    fetchReport.chunkPlan.chunkDurationSec ||
    DEFAULT_CHUNK_DURATION_SEC;
  const chunkOverlapSec = fetchReport.chunkPlan.chunkOverlapSec;

  const estimatedDurationSec = fetchReport.video.durationSec ?? 600;
  const estimatedCredits = await calculateJobCreditCost(
    estimatedDurationSec,
    settings.clipCount
  );

  const projectTitle = (
    params.title?.trim() ||
    fetchReport.video.title ||
    `YouTube Clips (${fetchReport.video.videoId})`
  ).slice(0, 180);

  const autoStart = params.autoStart !== false;

  const project = await Project.create({
    userId: params.userId,
    title: projectTitle,
    sourceType: 'url',
    sourceUrl: fetchReport.video.canonicalUrl,
    sourcePlatform: 'youtube',
    youtubeVideoId: fetchReport.video.videoId,
    youtubeMetadata: {
      videoId: fetchReport.video.videoId,
      canonicalUrl: fetchReport.video.canonicalUrl,
      title: fetchReport.video.title,
      channelName: fetchReport.video.channelName,
      thumbnailUrl: fetchReport.video.thumbnailUrl,
      durationSec: fetchReport.video.durationSec,
      metadataSource: fetchReport.video.metadataSource,
      mediaAdapterUsed: fetchReport.mediaAccess.adapterName,
    },
    settings,
    status: autoStart ? 'queued' : 'draft',
  });

  const totalChunksEstimate = Math.max(
    1,
    Math.ceil(estimatedDurationSec / chunkDurationSec)
  );

  let jobDoc = undefined;
  if (autoStart) {
    jobDoc = await ProcessingJob.create({
      userId: params.userId,
      projectId: project._id,
      type: 'full_pipeline',
      queueMode: getActiveQueueMode(),
      stage: 'importing',
      status: 'queued',
      progressPercent: 2,
      currentMessage: `Queued YouTube import (${fetchReport.video.videoId}) for chunked AI processing...`,
      chunkProgress: {
        enabled: totalChunksEstimate > 1,
        chunkDurationSec,
        chunkOverlapSec,
        totalChunks: totalChunksEstimate,
        completedChunks: 0,
        currentChunkIndex: 0,
      },
      youtubeImport: {
        videoId: fetchReport.video.videoId,
        canonicalUrl: fetchReport.video.canonicalUrl,
        authorizedMediaUrl: params.authorizedMediaUrl,
        metadata: fetchReport.video as unknown as Record<string, unknown>,
      },
      maxAttempts: 3,
      creditsReserved: estimatedCredits,
      idempotencyKey: `job:yt:${String(project._id)}:${Date.now()}`,
    });

    try {
      await reserveCreditsForJob({
        userId: params.userId,
        jobId: jobDoc._id,
        amount: estimatedCredits,
        description: `Reserved ${estimatedCredits} credits for YouTube import "${project.title}"`,
      });
    } catch (err) {
      await ProcessingJob.deleteOne({ _id: jobDoc._id });
      await Project.deleteOne({ _id: project._id });
      throw err;
    }

    project.latestJobId = jobDoc._id;
    project.creditsReserved = estimatedCredits;
    await project.save();

    await enqueueProcessingJob(String(jobDoc._id));
  } else {
    await project.save();
  }

  return {
    project,
    job: jobDoc,
    youtube: fetchReport.video,
    chunkPlan: fetchReport.chunkPlan,
  };
}
