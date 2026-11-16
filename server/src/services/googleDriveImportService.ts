import { Types } from 'mongoose';
import {
  DEFAULT_CHUNK_DURATION_SEC,
  DEFAULT_CHUNK_OVERLAP_SEC,
  type GoogleDriveVideoFile,
  type ProjectProcessingSettings,
} from '@clipforge/shared';
import { env } from '../config/env';
import {
  ProcessingJob,
  Project,
  getOrCreateSystemConfig,
} from '../models';
import { enqueueProcessingJob, getActiveQueueMode } from '../queues/videoQueue';
import { BadRequestError } from '../utils/errors';
import { getMediaAcquisitionService } from './mediaAcquisition';
import {
  calculateJobCreditCost,
  ensureUserWallet,
  reserveCreditsForJob,
} from './walletService';

export async function verifyAndSelectGoogleDriveVideo(params: {
  userId: Types.ObjectId;
  fileId: string;
  clipCount?: number;
}): Promise<{
  file: GoogleDriveVideoFile;
  estimatedCredits: number;
  chunkPlan: {
    enabled: boolean;
    chunkDurationSec: number;
    chunkOverlapSec: number;
    estimatedChunks: number;
    maxSupportedDurationSec: number;
  };
}> {
  const cfg = await getOrCreateSystemConfig();
  const maxSupportedDurationSec = Math.min(
    env.MAX_VIDEO_DURATION_SEC,
    cfg.maxVideoDurationSec || 36000
  );

  const mediaService = getMediaAcquisitionService();
  const file = await mediaService.googleDriveMediaProvider.verifyAndRegisterSelectedFile(
    String(params.userId),
    params.fileId,
    maxSupportedDurationSec
  );

  const chunkDurationSec =
    cfg.chunkDurationSec || env.VIDEO_CHUNK_DURATION_SEC || DEFAULT_CHUNK_DURATION_SEC;
  const chunkOverlapSec =
    cfg.chunkOverlapSec ?? env.VIDEO_CHUNK_OVERLAP_SEC ?? DEFAULT_CHUNK_OVERLAP_SEC;

  const effectiveDurationSec = file.durationSec ?? 60;
  const fullChunks = Math.max(1, Math.floor(effectiveDurationSec / chunkDurationSec));
  const tailRemainderSec = effectiveDurationSec - fullChunks * chunkDurationSec;
  const estimatedChunks =
    effectiveDurationSec <= chunkDurationSec
      ? 1
      : tailRemainderSec > 15
        ? fullChunks + 1
        : fullChunks;

  const estimatedCredits = await calculateJobCreditCost(
    effectiveDurationSec,
    params.clipCount ?? 3
  );

  return {
    file,
    estimatedCredits,
    chunkPlan: {
      enabled: effectiveDurationSec > chunkDurationSec,
      chunkDurationSec,
      chunkOverlapSec,
      estimatedChunks,
      maxSupportedDurationSec,
    },
  };
}

export async function initiateGoogleDriveClipGeneration(params: {
  userId: Types.ObjectId;
  fileId: string;
  title?: string;
  settings: ProjectProcessingSettings;
  autoStart?: boolean;
}) {
  const cfg = await getOrCreateSystemConfig();
  const maxSupportedDurationSec = Math.min(
    env.MAX_VIDEO_DURATION_SEC,
    cfg.maxVideoDurationSec || 36000
  );

  const settings: ProjectProcessingSettings = {
    ...params.settings,
    clipCount: Math.min(params.settings.clipCount, cfg.maxClipsPerJob || 10),
  };

  const mediaService = getMediaAcquisitionService();

  // 1. Validate that this fileId belongs to the authenticated user's authorized Picker selections
  await mediaService.googleDriveMediaProvider.assertFileAuthorizedForUser(
    String(params.userId),
    params.fileId
  );

  // 2. Re-verify live Drive file access, MIME type, size, and duration using user's OAuth credentials
  const verifiedFile = await mediaService.googleDriveMediaProvider.inspectDriveFile(
    String(params.userId),
    params.fileId
  );

  if (verifiedFile.durationSec && verifiedFile.durationSec > maxSupportedDurationSec + 5) {
    throw new BadRequestError(
      `Selected Google Drive video duration (${Math.round(
        verifiedFile.durationSec / 60
      )} min) exceeds the maximum supported length of ${Math.round(
        maxSupportedDurationSec / 3600
      )} hours (${maxSupportedDurationSec}s).`,
      'VIDEO_DURATION_LIMIT_EXCEEDED'
    );
  }

  await ensureUserWallet(params.userId, false);

  const chunkDurationSec =
    settings.chunkDurationSec ||
    cfg.chunkDurationSec ||
    env.VIDEO_CHUNK_DURATION_SEC ||
    DEFAULT_CHUNK_DURATION_SEC;
  const chunkOverlapSec =
    cfg.chunkOverlapSec ?? env.VIDEO_CHUNK_OVERLAP_SEC ?? DEFAULT_CHUNK_OVERLAP_SEC;

  const estimatedDurationSec = verifiedFile.durationSec ?? 60;
  const estimatedCredits = await calculateJobCreditCost(
    estimatedDurationSec,
    settings.clipCount
  );

  const defaultTitle = verifiedFile.name.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Google Drive Video';
  const projectTitle = (params.title?.trim() || defaultTitle).slice(0, 180);
  const autoStart = params.autoStart !== false;

  const project = await Project.create({
    userId: params.userId,
    title: projectTitle,
    sourceType: 'google_drive',
    sourcePlatform: 'google_drive',
    googleDriveMetadata: {
      fileId: verifiedFile.id,
      name: verifiedFile.name,
      mimeType: verifiedFile.mimeType,
      sizeBytes: verifiedFile.sizeBytes,
      durationSec: verifiedFile.durationSec,
      thumbnailUrl: verifiedFile.thumbnailUrl,
    },
    settings,
    status: autoStart ? 'queued' : 'draft',
  });

  const fullChunks = Math.max(1, Math.floor(estimatedDurationSec / chunkDurationSec));
  const tailRemainderSec = estimatedDurationSec - fullChunks * chunkDurationSec;
  const totalChunksEstimate =
    estimatedDurationSec <= chunkDurationSec
      ? 1
      : tailRemainderSec > 15
        ? fullChunks + 1
        : fullChunks;

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
      currentMessage: `Queued Google Drive video "${verifiedFile.name}" for AI clip generation...`,
      chunkProgress: {
        enabled: totalChunksEstimate > 1,
        chunkDurationSec,
        chunkOverlapSec,
        totalChunks: totalChunksEstimate,
        completedChunks: 0,
        currentChunkIndex: 0,
      },
      googleDriveImport: {
        fileId: verifiedFile.id,
        name: verifiedFile.name,
        mimeType: verifiedFile.mimeType,
        sizeBytes: verifiedFile.sizeBytes,
        durationSec: verifiedFile.durationSec,
        thumbnailUrl: verifiedFile.thumbnailUrl,
      },
      maxAttempts: 3,
      creditsReserved: estimatedCredits,
      idempotencyKey: `job:gdrive:${String(project._id)}:${Date.now()}`,
    });

    try {
      await reserveCreditsForJob({
        userId: params.userId,
        jobId: jobDoc._id,
        amount: estimatedCredits,
        description: `Reserved ${estimatedCredits} credits for Google Drive import "${project.title}"`,
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
    file: verifiedFile,
    chunkPlan: {
      enabled: totalChunksEstimate > 1,
      chunkDurationSec,
      chunkOverlapSec,
      estimatedChunks: totalChunksEstimate,
      maxSupportedDurationSec,
    },
  };
}
