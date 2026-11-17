import { Types } from 'mongoose';
import {
  DEFAULT_CHUNK_DURATION_SEC,
  DEFAULT_CHUNK_OVERLAP_SEC,
  type GoogleOAuthStatus,
  type ProjectProcessingSettings,
  type YouTubeVideoMetadata,
} from '@clipforge/shared';
import { env } from '../config/env';
import {
  ProcessingJob,
  Project,
  getOrCreateSystemConfig,
} from '../models';
import {
  getMediaAcquisitionService,
  parseIso8601DurationSec,
  parseYouTubeVideoUrl,
  type MediaAccessEvaluation,
} from './mediaAcquisition';
import {
  calculateJobCreditCost,
  ensureUserWallet,
  reserveCreditsForJob,
} from './walletService';
import { enqueueProcessingJob, getActiveQueueMode } from '../queues/videoQueue';
import { assertClipCountWithinSystemLimit } from './processingSettingsService';
import { AppError } from '../utils/errors';

/**
 * Validates any supported YouTube URL format and extracts the canonical 11-char Video ID.
 */
export function parseAndValidateYouTubeUrl(rawUrl: string): {
  videoId: string;
  canonicalUrl: string;
} {
  const parsed = parseYouTubeVideoUrl(rawUrl);
  return {
    videoId: parsed.videoId,
    canonicalUrl: parsed.canonicalUrl,
  };
}

/**
 * Parses ISO-8601 duration strings from YouTube Data API v3 (e.g. "PT10H0M0S" -> 36000).
 */
export function parseIso8601DurationToSeconds(isoDuration: string): number {
  return parseIso8601DurationSec(isoDuration) ?? 0;
}

export interface YouTubeFetchReport {
  video: YouTubeVideoMetadata;
  mediaAccess: MediaAccessEvaluation;
  googleAuth?: GoogleOAuthStatus;
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
 * Dedicated YouTube Metadata & Media Readiness Inspection Service.
 * Strictly separates metadata discovery (YouTubeMetadataProvider) from video media acquisition
 * (GoogleDriveMediaProvider / AuthorizedDirectMediaProvider). Never treats oEmbed or Data API JSON
 * as an actual video file.
 */
export async function fetchYouTubeVideoMetadataAndAccess(
  rawUrl: string,
  options?: {
    userId?: string;
    googleDriveFileId?: string;
    authorizedMediaUrl?: string;
    clipCount?: number;
  }
): Promise<YouTubeFetchReport> {
  const cfg = await getOrCreateSystemConfig();
  const acquisitionService = getMediaAcquisitionService();

  const inspection = await acquisitionService.inspectYouTubeSource({
    url: rawUrl,
    userId: options?.userId,
    googleDriveFileId: options?.googleDriveFileId,
    authorizedMediaUrl: options?.authorizedMediaUrl,
    clipCount: options?.clipCount,
  });

  const maxSupportedDurationSec = Math.min(
    env.MAX_VIDEO_DURATION_SEC,
    cfg.maxVideoDurationSec || 36000
  );
  const chunkDurationSec =
    cfg.chunkDurationSec || env.VIDEO_CHUNK_DURATION_SEC || DEFAULT_CHUNK_DURATION_SEC;
  const chunkOverlapSec =
    cfg.chunkOverlapSec ?? env.VIDEO_CHUNK_OVERLAP_SEC ?? DEFAULT_CHUNK_OVERLAP_SEC;
  const effectiveDurationForEstimate = inspection.metadata.durationSec ?? 600;

  // Match Python chunk_manager tail-merging rule (<= 15s remainder merges into final chunk)
  const fullChunks = Math.max(
    1,
    Math.floor(effectiveDurationForEstimate / chunkDurationSec)
  );
  const tailRemainderSec =
    effectiveDurationForEstimate - fullChunks * chunkDurationSec;
  const estimatedChunks =
    effectiveDurationForEstimate <= chunkDurationSec
      ? 1
      : tailRemainderSec > 15
        ? fullChunks + 1
        : fullChunks;

  return {
    video: inspection.metadata,
    mediaAccess: inspection.mediaAccess,
    googleAuth: inspection.googleAuth,
    chunkPlan: {
      enabled: effectiveDurationForEstimate > chunkDurationSec,
      chunkDurationSec,
      chunkOverlapSec,
      estimatedChunks,
      maxSupportedDurationSec,
    },
    estimatedCredits: inspection.estimatedCredits,
  };
}

/**
 * Initiates an authenticated YouTube URL-to-Clips background job:
 * 1. Validates URL & fetches separated YouTube metadata (with Google OAuth channel ownership check if connected)
 * 2. Verifies an authorized media provider (Google Drive export, Direct Authorized Media URL, local owner export, or configured bridge) can access actual video media
 * 3. Atomically reserves user credits before background processing begins
 * 4. Creates Project + recoverable chunked ProcessingJob and dispatches worker
 */
export async function initiateYouTubeClipGeneration(params: {
  userId: Types.ObjectId;
  url: string;
  title?: string;
  googleDriveFileId?: string;
  authorizedMediaUrl?: string;
  settings: ProjectProcessingSettings;
  autoStart?: boolean;
}) {
  const cfg = await getOrCreateSystemConfig();
  const settings: ProjectProcessingSettings = { ...params.settings };
  assertClipCountWithinSystemLimit(settings.clipCount, cfg.maxClipsPerJob);

  const fetchReport = await fetchYouTubeVideoMetadataAndAccess(params.url, {
    userId: String(params.userId),
    googleDriveFileId: params.googleDriveFileId,
    authorizedMediaUrl: params.authorizedMediaUrl,
    clipCount: settings.clipCount,
  });

  if (!fetchReport.mediaAccess.available) {
    throw new AppError(
      fetchReport.mediaAccess.reason ||
        fetchReport.mediaAccess.guidance ||
        'Actual video media could not be accessed through any configured authorized media-source provider.',
      fetchReport.mediaAccess.configured ? 422 : 503,
      fetchReport.mediaAccess.configured
        ? 'YOUTUBE_MEDIA_ACCESS_FAILED'
        : 'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED',
      {
        videoId: fetchReport.video.videoId,
        setupInstructions: fetchReport.mediaAccess.setupInstructions,
        resolutionOptions: fetchReport.mediaAccess.resolutionOptions,
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

  const resolvedDriveFile = fetchReport.mediaAccess.matchedDriveFile;
  const effectiveDriveFileId =
    params.googleDriveFileId?.trim() || resolvedDriveFile?.id || undefined;

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
      channelId: fetchReport.video.channelId,
      channelName: fetchReport.video.channelName,
      channelOwnershipVerified: fetchReport.video.channelOwnershipVerified,
      thumbnailUrl: fetchReport.video.thumbnailUrl,
      durationSec: fetchReport.video.durationSec,
      metadataSource: fetchReport.video.metadataSource,
      mediaAdapterUsed: fetchReport.mediaAccess.adapterName,
      googleDriveFileId: effectiveDriveFileId,
      googleDriveFileName: resolvedDriveFile?.name,
      driveMatchConfidence: resolvedDriveFile?.match?.confidence,
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
        authorizedMediaUrl: params.authorizedMediaUrl?.trim() || undefined,
        googleDriveFileId: effectiveDriveFileId,
        googleDriveFileName: resolvedDriveFile?.name,
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
    mediaAccess: fetchReport.mediaAccess,
    chunkPlan: fetchReport.chunkPlan,
  };
}
