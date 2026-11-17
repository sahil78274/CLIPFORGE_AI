import path from 'path';
import { Readable } from 'stream';
import { Types } from 'mongoose';
import type {
  GoogleDriveSelectedFile,
  ProjectProcessingSettings,
} from '@clipforge/shared';
import { env } from '../../config/env';
import {
  GoogleDriveFileSelection,
  ProcessingJob,
  Project,
  getOrCreateSystemConfig,
  type IGoogleDriveFileSelection,
} from '../../models';
import { enqueueProcessingJob, getActiveQueueMode } from '../../queues/videoQueue';
import {
  calculateJobCreditCost,
  ensureUserWallet,
  reserveCreditsForJob,
} from '../walletService';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors';
import { assertClipCountWithinSystemLimit } from '../processingSettingsService';
import { getGoogleDriveMediaProvider } from './GoogleDriveMediaProvider';
import { getGoogleDriveOAuthService } from './GoogleDriveOAuthService';
import type {
  AcquiredDriveMedia,
  DriveFileMetadata,
} from './GoogleDriveMediaProvider';

const THUMBNAIL_HOSTS = new Set([
  'lh3.googleusercontent.com',
  'lh4.googleusercontent.com',
  'lh5.googleusercontent.com',
  'lh6.googleusercontent.com',
  'drive.google.com',
  'drive.usercontent.google.com',
  'www.googleapis.com',
  '127.0.0.1',
  'localhost',
  '::1',
]);

function toPublicSelection(doc: IGoogleDriveFileSelection): GoogleDriveSelectedFile {
  return {
    selectionId: String(doc._id),
    fileId: doc.fileId,
    name: doc.name,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes ?? null,
    durationSec: doc.durationSec ?? null,
    width: doc.width ?? null,
    height: doc.height ?? null,
    thumbnailUrl: doc.thumbnailLink
      ? `/api/v1/google-drive/selections/${String(doc._id)}/thumbnail`
      : null,
    modifiedTime: doc.driveModifiedTime ?? null,
    expiresAt: doc.expiresAt.toISOString(),
  };
}

function metadataToSelectionFields(meta: DriveFileMetadata) {
  return {
    name: meta.name,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    thumbnailLink: meta.thumbnailLink || undefined,
    md5Checksum: meta.md5Checksum || undefined,
    sha256Checksum: meta.sha256Checksum || undefined,
    driveModifiedTime: meta.driveModifiedTime || undefined,
  };
}

/**
 * Orchestrates the "Import from Google Drive" workflow:
 * Picker selection -> backend verification -> opaque selection record ->
 * credit reservation -> recoverable chunked processing job -> streamed acquisition.
 */
export class GoogleDriveImportService {
  private get oauth() {
    return getGoogleDriveOAuthService();
  }

  private get provider() {
    return getGoogleDriveMediaProvider();
  }

  /**
   * The client sends ONLY a Drive file ID from the Picker. We independently
   * verify it with this user's OAuth token before creating a server-side selection.
   */
  async registerSelection(userId: string, fileId: string): Promise<GoogleDriveSelectedFile> {
    const connection = await this.oauth.getConnectionRecord(userId);
    if (!connection || connection.status !== 'active') {
      throw new ForbiddenError(
        'Connect Google Drive before selecting a video.',
        'GOOGLE_DRIVE_NOT_CONNECTED'
      );
    }

    const meta = await this.provider.fetchFileMetadata(userId, fileId.trim());
    const selection = await GoogleDriveFileSelection.create({
      userId: new Types.ObjectId(userId),
      connectionGoogleAccountId: connection.googleAccountId,
      fileId: meta.id,
      ...metadataToSelectionFields(meta),
      expiresAt: new Date(Date.now() + env.GOOGLE_DRIVE_SELECTION_TTL_SEC * 1000),
      lastVerifiedAt: new Date(),
    });
    return toPublicSelection(selection);
  }

  async getSelectionForUser(
    userId: string,
    selectionId: string
  ): Promise<IGoogleDriveFileSelection> {
    if (!Types.ObjectId.isValid(selectionId)) {
      throw new BadRequestError('Invalid Google Drive selection.', 'GOOGLE_DRIVE_INVALID_SELECTION');
    }
    const selection = await GoogleDriveFileSelection.findOne({
      _id: selectionId,
      userId: new Types.ObjectId(userId),
    });
    if (!selection) {
      // Deliberately identical response for missing and another user's selection.
      throw new NotFoundError(
        'Google Drive selection was not found. Re-select the video in the Google Picker.',
        'GOOGLE_DRIVE_SELECTION_NOT_FOUND'
      );
    }
    if (selection.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestError(
        'Your Google Drive video selection expired. Click Select Video from Drive again.',
        'GOOGLE_DRIVE_SELECTION_EXPIRED'
      );
    }
    return selection;
  }

  async getSelectionPublic(
    userId: string,
    selectionId: string
  ): Promise<GoogleDriveSelectedFile> {
    return toPublicSelection(await this.getSelectionForUser(userId, selectionId));
  }

  /** Re-verify access with the user's own credentials and refresh cached metadata. */
  async reverifySelection(
    userId: string,
    selection: IGoogleDriveFileSelection
  ): Promise<DriveFileMetadata> {
    const meta = await this.provider.fetchFileMetadata(userId, selection.fileId);
    if (meta.id !== selection.fileId) {
      throw new BadRequestError(
        'Google Drive file identity changed. Re-select the video.',
        'GOOGLE_DRIVE_FILE_ID_MISMATCH'
      );
    }
    Object.assign(selection, metadataToSelectionFields(meta), { lastVerifiedAt: new Date() });
    await selection.save();
    return meta;
  }

  /** Same-origin thumbnail proxy so access tokens are never placed in <img> URLs. */
  async getThumbnailStream(
    userId: string,
    selectionId: string
  ): Promise<{ stream: Readable; contentType: string }> {
    const selection = await this.getSelectionForUser(userId, selectionId);
    if (!selection.thumbnailLink) {
      throw new NotFoundError(
        'Google Drive did not provide a thumbnail for this video.',
        'GOOGLE_DRIVE_THUMBNAIL_NOT_AVAILABLE'
      );
    }
    let target: URL;
    try {
      target = new URL(selection.thumbnailLink);
    } catch {
      throw new NotFoundError('Invalid Google Drive thumbnail URL.', 'GOOGLE_DRIVE_THUMBNAIL_NOT_AVAILABLE');
    }
    if (
      target.protocol !== 'https:' &&
      !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    ) {
      throw new NotFoundError('Invalid Google Drive thumbnail URL.', 'GOOGLE_DRIVE_THUMBNAIL_NOT_AVAILABLE');
    }
    if (!THUMBNAIL_HOSTS.has(target.hostname)) {
      throw new NotFoundError('Untrusted Google Drive thumbnail host.', 'GOOGLE_DRIVE_THUMBNAIL_NOT_AVAILABLE');
    }

    const { accessToken } = await this.oauth.getValidAccessToken(userId);
    const res = await fetch(target.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'image/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !res.body) {
      throw new NotFoundError(
        'Google Drive thumbnail could not be loaded.',
        'GOOGLE_DRIVE_THUMBNAIL_NOT_AVAILABLE'
      );
    }
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return { stream: Readable.fromWeb(res.body as any), contentType };
  }

  async createGenerationJob(params: {
    userId: Types.ObjectId;
    selectionId: string;
    title?: string;
    settings: ProjectProcessingSettings;
    autoStart?: boolean;
  }): Promise<{
    project: InstanceType<typeof Project>;
    job?: InstanceType<typeof ProcessingJob>;
    file: GoogleDriveSelectedFile;
    estimatedCredits: number;
    chunkPlan: {
      enabled: boolean;
      chunkDurationSec: number;
      chunkOverlapSec: number;
      estimatedChunks: number;
      maxSupportedDurationSec: number;
    };
  }> {
    const userIdStr = String(params.userId);
    const selection = await this.getSelectionForUser(userIdStr, params.selectionId);
    const meta = await this.reverifySelection(userIdStr, selection);
    const publicFile = toPublicSelection(selection);

    const cfg = await getOrCreateSystemConfig();
    const maxDurationSec = Math.min(env.MAX_VIDEO_DURATION_SEC, cfg.maxVideoDurationSec || 36000);
    const settings: ProjectProcessingSettings = { ...params.settings };
    assertClipCountWithinSystemLimit(settings.clipCount, cfg.maxClipsPerJob);
    const estimatedDurationSec = meta.durationSec ?? 600;
    const chunkDurationSec =
      settings.chunkDurationSec || cfg.chunkDurationSec || env.VIDEO_CHUNK_DURATION_SEC;
    const chunkOverlapSec = cfg.chunkOverlapSec ?? env.VIDEO_CHUNK_OVERLAP_SEC;
    const estimatedChunks = Math.max(1, Math.ceil(estimatedDurationSec / chunkDurationSec));
    const estimatedCredits = await calculateJobCreditCost(
      estimatedDurationSec,
      settings.clipCount
    );

    await ensureUserWallet(params.userId, false);

    const projectTitle = (params.title?.trim() || meta.name.replace(/\.[^.]+$/, '')).slice(0, 180);
    const autoStart = params.autoStart !== false;

    const project = await Project.create({
      userId: params.userId,
      title: projectTitle,
      sourceType: 'upload',
      sourcePlatform: 'google_drive',
      googleDriveMetadata: {
        selectionId: String(selection._id),
        fileId: meta.id,
        fileName: meta.name,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
        durationSec: meta.durationSec,
        thumbnailUrl: publicFile.thumbnailUrl,
      },
      settings,
      status: autoStart ? 'queued' : 'draft',
    });

    let job: InstanceType<typeof ProcessingJob> | undefined;
    if (autoStart) {
      job = await ProcessingJob.create({
        userId: params.userId,
        projectId: project._id,
        type: 'full_pipeline',
        queueMode: getActiveQueueMode(),
        stage: 'importing',
        status: 'queued',
        progressPercent: 2,
        currentMessage: `Queued Google Drive import "${meta.name}" for chunked AI processing...`,
        chunkProgress: {
          enabled: estimatedChunks > 1,
          chunkDurationSec,
          chunkOverlapSec,
          totalChunks: estimatedChunks,
          completedChunks: 0,
          currentChunkIndex: 0,
        },
        driveImport: {
          selectionId: String(selection._id),
          fileId: meta.id,
          fileName: meta.name,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes,
          durationSec: meta.durationSec,
          estimatedDurationSec,
        },
        maxAttempts: 3,
        creditsReserved: estimatedCredits,
        idempotencyKey: `job:drive:${String(project._id)}:${Date.now()}`,
      });

      try {
        await reserveCreditsForJob({
          userId: params.userId,
          jobId: job._id,
          amount: estimatedCredits,
          description: `Reserved ${estimatedCredits} credits for Google Drive import "${project.title}"`,
        });
      } catch (err) {
        await ProcessingJob.deleteOne({ _id: job._id });
        await Project.deleteOne({ _id: project._id });
        throw err;
      }

      project.latestJobId = job._id;
      project.creditsReserved = estimatedCredits;
      await project.save();
      await enqueueProcessingJob(String(job._id));
    }

    return {
      project,
      job,
      file: publicFile,
      estimatedCredits,
      chunkPlan: {
        enabled: estimatedChunks > 1,
        chunkDurationSec,
        chunkOverlapSec,
        estimatedChunks,
        maxSupportedDurationSec: maxDurationSec,
      },
    };
  }

  /**
   * Worker entry point: re-verify the selection's access, then stream the actual
   * video bytes to temporary storage and validate them with FFprobe before the
   * existing FFmpeg + Faster-Whisper chunked pipeline takes over.
   */
  async acquireForJob(params: {
    userId: string;
    selectionId: string;
    destDir: string;
    maxDurationSec?: number;
    signal?: AbortSignal;
    onProgress?: (percent: number, message: string) => void;
  }): Promise<AcquiredDriveMedia> {
    const selection = await this.getSelectionForUser(params.userId, params.selectionId);
    const meta = await this.reverifySelection(params.userId, selection);
    const destPath = path.join(params.destDir, `drive_${String(selection._id)}`);
    return this.provider.downloadFileToDisk({
      userId: params.userId,
      fileId: selection.fileId,
      metadata: meta,
      destPath,
      maxDurationSec: params.maxDurationSec,
      signal: params.signal,
      onProgress: params.onProgress,
    });
  }
}

let singleton: GoogleDriveImportService | null = null;

export function getGoogleDriveImportService(): GoogleDriveImportService {
  if (!singleton) singleton = new GoogleDriveImportService();
  return singleton;
}

export { toPublicSelection };
