import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { env } from '../config/env';
import {
  Clip,
  Notification,
  ProcessingJob,
  Project,
  Video,
  getOrCreateSystemConfig,
  type IVideo,
} from '../models';
import { getStorageAdapter } from '../services/storageService';
import { getMediaAcquisitionService } from '../services/mediaAcquisition';
import { getGoogleDriveImportService } from '../services/googleDrive/GoogleDriveImportService';
import {
  calculateJobCreditCost,
  releaseReservedCredits,
  settleReservedCredits,
} from '../services/walletService';
import {
  generateClipMetadataWithGracefulFallback,
  getAIProvider,
} from '../services/aiService';
import { logger } from '../utils/logger';

const activeSubprocesses = new Map<string, ChildProcess>();
const activeAcquireControllers = new Map<string, AbortController>();
const cancelledJobIds = new Set<string>();

// Testing hook allowing deterministic one-shot worker interruption on a given chunk
const oneShotInterruptChunkByJob = new Map<string, number>();
let oneShotInterruptNextJobChunk: number | null = null;

export function scheduleSimulatedWorkerInterruptForTesting(
  jobId: string,
  afterChunkCount: number
): void {
  oneShotInterruptChunkByJob.set(jobId, afterChunkCount);
}

export function scheduleNextWorkerInterruptForTesting(afterChunkCount: number): void {
  oneShotInterruptNextJobChunk = afterChunkCount;
}

export function cancelRunningSubprocess(jobId: string): void {
  cancelledJobIds.add(jobId);
  const ac = activeAcquireControllers.get(jobId);
  if (ac) {
    ac.abort();
  }
  const child = activeSubprocesses.get(jobId);
  if (child && !child.killed) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000);
  }
}

function removeDirSafe(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup error
  }
}

function removeFileSafe(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup error
  }
}

export function getJobCheckpointPath(jobId: string): string {
  return path.join(env.TEMP_WORKING_DIR, 'checkpoints', `job_${jobId}.json`);
}

const NON_RETRYABLE_ERROR_CODES = new Set([
  'YOUTUBE_VIDEO_PRIVATE',
  'YOUTUBE_VIDEO_UNAVAILABLE',
  'YOUTUBE_MEDIA_NOT_VIDEO',
  'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED',
  'YOUTUBE_MEDIA_ACCESS_FAILED',
  'VIDEO_DURATION_LIMIT_EXCEEDED',
  'INVALID_MEDIA_CONTAINER',
  'MISSING_PROJECT_OR_VIDEO',
  'GOOGLE_DRIVE_NOT_VIDEO',
  'GOOGLE_DRIVE_ACCESS_DENIED',
  'GOOGLE_DRIVE_FILE_NOT_FOUND',
  'GOOGLE_DRIVE_FILE_TOO_LARGE',
  'GOOGLE_DRIVE_SELECTION_EXPIRED',
  'GOOGLE_DRIVE_SELECTION_NOT_FOUND',
  'GOOGLE_DRIVE_REAUTH_REQUIRED',
  'GOOGLE_DRIVE_SCOPE_NOT_GRANTED',
  'GOOGLE_DRIVE_INVALID_FILE_ID',
  'GOOGLE_DRIVE_INVALID_SELECTION',
  'GOOGLE_DRIVE_INVALID_STREAM',
]);

export async function executeProcessingJob(
  jobId: string,
  options?: { disableAutoRetry?: boolean }
): Promise<void> {
  // Atomic claim so duplicate workers never process the same job simultaneously
  const claimed = await ProcessingJob.findOneAndUpdate(
    { _id: jobId, status: 'queued' },
    {
      $set: {
        status: 'processing',
        startedAt: new Date(),
        currentMessage: 'Starting media worker pipeline...',
      },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  if (!claimed) {
    return;
  }

  const project = await Project.findById(claimed.projectId);
  let video: IVideo | null = claimed.videoId ? await Video.findById(claimed.videoId) : null;

  if (!project || (!video && !claimed.youtubeImport && !claimed.driveImport)) {
    removeFileSafe(getJobCheckpointPath(jobId));
    await failAndReleaseJob(
      claimed._id.toString(),
      'MISSING_PROJECT_OR_VIDEO',
      'Source project or video record could not be found',
      'importing'
    );
    return;
  }

  project.status = 'processing';
  await project.save();

  const tempJobDir = path.join(env.TEMP_WORKING_DIR, `job_${jobId}`);
  const outputDir = path.join(tempJobDir, 'outputs');
  const checkpointPath = getJobCheckpointPath(jobId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });

  const storage = getStorageAdapter();
  const aiProvider = getAIProvider();
  const cfg = await getOrCreateSystemConfig();

  let lastStage = claimed.stage || 'importing';

  try {
    // Stage 1a: Acquire actual source media (Google Drive import or YouTube import).
    // Both are recoverable: reservations are released on failure and the whole per-job
    // temp directory (including streamed .part files) is removed in the finally block.
    let directAcquiredPathForRun: string | null = null;

    if (!video && claimed.driveImport) {
      lastStage = 'importing';
      const di = claimed.driveImport;
      await ProcessingJob.findByIdAndUpdate(jobId, {
        $set: {
          stage: 'importing',
          progressPercent: 4,
          currentMessage: `Verifying and streaming "${di.fileName}" from Google Drive...`,
        },
        $push: {
          stageHistory: {
            stage: 'importing',
            startedAt: new Date(),
            message: `Starting verified Google Drive media acquisition (selection ${di.selectionId})`,
          },
        },
      });

      const acquireController = new AbortController();
      activeAcquireControllers.set(jobId, acquireController);

      let acquiredDrive;
      try {
        acquiredDrive = await getGoogleDriveImportService().acquireForJob({
          userId: String(claimed.userId),
          selectionId: di.selectionId,
          destDir: path.join(tempJobDir, 'drive_source'),
          maxDurationSec: Math.min(
            env.MAX_VIDEO_DURATION_SEC,
            cfg.maxVideoDurationSec || 36000
          ),
          signal: acquireController.signal,
          onProgress: (pct, msg) => {
            const mapped = Math.min(9, 4 + Math.floor(pct / 20));
            void ProcessingJob.findByIdAndUpdate(jobId, {
              $set: { stage: 'importing', progressPercent: mapped, currentMessage: msg },
            }).exec();
          },
        });
      } finally {
        activeAcquireControllers.delete(jobId);
      }

      if (cancelledJobIds.has(jobId)) {
        throw new Error('JOB_CANCELLED_BY_USER');
      }

      const ext = path.extname(acquiredDrive.localFilePath) || '.mp4';
      const storageKey = `sources/${String(claimed.userId)}/${String(project._id)}/drive_${di.fileId}${ext}`;
      await storage.saveFromLocalFile(
        acquiredDrive.localFilePath,
        storageKey,
        acquiredDrive.mimeType
      );
      // Streamed temporary video is deleted immediately after being stored.
      removeFileSafe(acquiredDrive.localFilePath);

      video = await Video.create({
        userId: claimed.userId,
        projectId: project._id,
        originalFilename: di.fileName,
        storageKey,
        storageProvider: storage.provider,
        mimeType: acquiredDrive.mimeType,
        sizeBytes: acquiredDrive.probe.sizeBytes,
        durationSec: acquiredDrive.probe.durationSec,
        width: acquiredDrive.probe.width,
        height: acquiredDrive.probe.height,
        fps: acquiredDrive.probe.fps,
        codec: acquiredDrive.probe.codec,
        audioCodec: acquiredDrive.probe.audioCodec,
        hasAudio: acquiredDrive.probe.hasAudio,
        status: 'validated',
      });

      project.videoId = video._id;
      if (project.googleDriveMetadata) {
        project.googleDriveMetadata = {
          ...project.googleDriveMetadata,
          durationSec: acquiredDrive.probe.durationSec,
          sizeBytes: acquiredDrive.sizeBytes,
        };
        project.markModified('googleDriveMetadata');
      }
      await project.save();

      claimed.videoId = video._id;
      await ProcessingJob.findByIdAndUpdate(jobId, {
        $set: { videoId: video._id },
      });
    }

    if (!video && claimed.youtubeImport) {
      lastStage = 'importing';
      const yt = claimed.youtubeImport;
      await ProcessingJob.findByIdAndUpdate(jobId, {
        $set: {
          stage: 'importing',
          progressPercent: 4,
          currentMessage: `Acquiring authorized video media for YouTube ID ${yt.videoId}...`,
        },
        $push: {
          stageHistory: {
            stage: 'importing',
            startedAt: new Date(),
            message: `Starting authorized media acquisition (${yt.videoId})`,
          },
        },
      });

      const acquireController = new AbortController();
      activeAcquireControllers.set(jobId, acquireController);

      let acquired;
      try {
        const mediaAcquisition = getMediaAcquisitionService();
        const ytMeta = yt.metadata as Record<string, any> | undefined;
        acquired = await mediaAcquisition.acquireMedia(
          yt.videoId,
          yt.canonicalUrl,
          path.join(tempJobDir, 'yt_source'),
          {
            userId: String(claimed.userId),
            googleDriveFileId: yt.googleDriveFileId,
            authorizedMediaUrl: yt.authorizedMediaUrl,
            targetVideo: {
              videoId: yt.videoId,
              title: String(ytMeta?.title || project.title || `YouTube Video ${yt.videoId}`),
              durationSec:
                typeof ytMeta?.durationSec === 'number' ? ytMeta.durationSec : null,
            },
            maxDurationSec: Math.min(
              env.MAX_VIDEO_DURATION_SEC,
              cfg.maxVideoDurationSec || 36000
            ),
            signal: acquireController.signal,
            onProgress: (pct, msg) => {
              const mapped = Math.min(9, 4 + Math.floor(pct / 20));
              void ProcessingJob.findByIdAndUpdate(jobId, {
                $set: { stage: 'importing', progressPercent: mapped, currentMessage: msg },
              }).exec();
            },
          }
        );
      } finally {
        activeAcquireControllers.delete(jobId);
      }

      if (cancelledJobIds.has(jobId)) {
        throw new Error('JOB_CANCELLED_BY_USER');
      }

      const ext = path.extname(acquired.localFilePath) || '.mp4';
      const storageKey = `sources/${String(claimed.userId)}/${String(project._id)}/yt_${yt.videoId}${ext}`;

      // When using local storage and a persistent owner-authorized export file, copy to project storage
      await storage.saveFromLocalFile(acquired.localFilePath, storageKey, acquired.mimeType);
      if (acquired.cleanupAfterStore) {
        removeFileSafe(acquired.localFilePath);
      } else {
        directAcquiredPathForRun = acquired.localFilePath;
      }

      video = await Video.create({
        userId: claimed.userId,
        projectId: project._id,
        originalFilename: `youtube_${yt.videoId}${ext}`,
        storageKey,
        storageProvider: storage.provider,
        mimeType: acquired.mimeType,
        sizeBytes: acquired.probe.sizeBytes,
        durationSec: acquired.probe.durationSec,
        width: acquired.probe.width,
        height: acquired.probe.height,
        fps: acquired.probe.fps,
        codec: acquired.probe.codec,
        audioCodec: acquired.probe.audioCodec,
        hasAudio: acquired.probe.hasAudio,
        status: 'validated',
      });

      project.videoId = video._id;
      if (project.youtubeMetadata) {
        project.youtubeMetadata = {
          ...project.youtubeMetadata,
          durationSec: acquired.probe.durationSec,
          mediaAdapterUsed: acquired.adapterName,
        };
        project.markModified('youtubeMetadata');
      }
      await project.save();

      claimed.videoId = video._id;
      await ProcessingJob.findByIdAndUpdate(jobId, {
        $set: { videoId: video._id },
      });
    }

    if (!video) {
      throw new Error('Source video missing after importing stage');
    }

    const localVideoPath =
      directAcquiredPathForRun && fs.existsSync(directAcquiredPathForRun)
        ? directAcquiredPathForRun
        : await storage.resolveLocalPathForProcessing(
            video.storageKey,
            path.join(tempJobDir, 'source')
          );

    const effectiveSettings = {
      ...project.settings,
      ...(claimed.overrides || {}),
    };

    const chunkDurationSec =
      effectiveSettings.chunkDurationSec ||
      claimed.chunkProgress?.chunkDurationSec ||
      cfg.chunkDurationSec ||
      env.VIDEO_CHUNK_DURATION_SEC;
    const chunkOverlapSec =
      claimed.chunkProgress?.chunkOverlapSec ??
      cfg.chunkOverlapSec ??
      env.VIDEO_CHUNK_OVERLAP_SEC;

    let regenerateSpec: Record<string, unknown> | undefined;
    if (claimed.type === 'regenerate_clip' && claimed.targetClipId) {
      const existingClip = await Clip.findById(claimed.targetClipId);
      if (existingClip) {
        regenerateSpec = {
          startSec: existingClip.startSec,
          endSec: existingClip.endSec,
          transcript: existingClip.transcript,
          title: existingClip.title,
          category: existingClip.category,
          selectionReason: existingClip.selectionReason,
          engagementScore: existingClip.engagementScore,
          // Edited caption cues (if any) are re-burned by the same ASS generator.
          ...(Array.isArray(claimed.overrides?.captionCues)
            ? { captionCues: claimed.overrides?.captionCues }
            : {}),
        };
      }
    }

    let simulateInterruptAfterChunk = oneShotInterruptChunkByJob.get(jobId);
    if (simulateInterruptAfterChunk !== undefined) {
      oneShotInterruptChunkByJob.delete(jobId);
    } else if (oneShotInterruptNextJobChunk !== null) {
      simulateInterruptAfterChunk = oneShotInterruptNextJobChunk;
      oneShotInterruptNextJobChunk = null;
    }

    const inputJsonPath = path.join(tempJobDir, 'job_input.json');
    const outputJsonPath = path.join(tempJobDir, 'job_result.json');

    fs.writeFileSync(
      inputJsonPath,
      JSON.stringify({
        jobId,
        mode: claimed.type,
        sourceVideoPath: localVideoPath,
        outputDir,
        checkpointPath,
        maxDurationSec: Math.min(env.MAX_VIDEO_DURATION_SEC, cfg.maxVideoDurationSec || 36000),
        chunkDurationSec,
        chunkOverlapSec,
        simulateInterruptAfterChunk:
          simulateInterruptAfterChunk !== undefined ? simulateInterruptAfterChunk : -1,
        ffmpegPath: env.FFMPEG_PATH,
        ffprobePath: env.FFPROBE_PATH,
        whisperModelSize: env.WHISPER_MODEL_SIZE,
        whisperModelPath: env.WHISPER_MODEL_PATH,
        whisperDevice: env.WHISPER_DEVICE,
        whisperComputeType: env.WHISPER_COMPUTE_TYPE,
        aiProvider: aiProvider.providerName,
        geminiApiKey: env.GEMINI_API_KEY,
        geminiModel: env.GEMINI_MODEL,
        openaiApiKey: env.OPENAI_API_KEY,
        openaiBaseUrl: env.OPENAI_BASE_URL,
        openaiModel: env.OPENAI_MODEL,
        projectTitle: project.title,
        settings: effectiveSettings,
        regenerateSpec,
      }),
      'utf8'
    );

    let stderrAccumulator = '';
    // Scale timeout dynamically with video length (at least JOB_TIMEOUT_MS, up to 4 hours for 10h video)
    const dynamicTimeoutMs = Math.max(
      env.JOB_TIMEOUT_MS,
      Math.min(4 * 3600 * 1000, Math.round(video.durationSec * 400) + 300000)
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        env.PYTHON_BIN,
        [env.PROCESSOR_MAIN_PY, '--input', inputJsonPath, '--output', outputJsonPath],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      activeSubprocesses.set(jobId, child);

      const timeoutTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(`Processing job timed out after ${Math.round(dynamicTimeoutMs / 1000)}s`)
        );
      }, dynamicTimeoutMs);

      let stdoutBuf = '';
      let pendingProgressChain: Promise<unknown> = Promise.resolve();

      const processStdoutLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('CF_EVENT:')) {
          try {
            const evt = JSON.parse(trimmed.slice('CF_EVENT:'.length));
            lastStage = evt.stage || lastStage;
            pendingProgressChain = pendingProgressChain
              .then(() =>
                ProcessingJob.findByIdAndUpdate(jobId, {
                  $set: {
                    stage: evt.stage,
                    progressPercent: evt.percent,
                    currentMessage: evt.message,
                  },
                  $push: {
                    stageHistory: {
                      stage: evt.stage,
                      startedAt: new Date(),
                      message: evt.message,
                    },
                  },
                }).exec()
              )
              .catch(() => undefined);
          } catch {
            // ignore malformed log line
          }
        } else if (trimmed.startsWith('CF_CHECKPOINT:')) {
          try {
            const cp = JSON.parse(trimmed.slice('CF_CHECKPOINT:'.length));
            pendingProgressChain = pendingProgressChain
              .then(() =>
                ProcessingJob.findByIdAndUpdate(jobId, {
                  $set: {
                    chunkProgress: {
                      enabled: Boolean(cp.enabled),
                      chunkDurationSec: Number(cp.chunkDurationSec || chunkDurationSec),
                      chunkOverlapSec: Number(cp.chunkOverlapSec || chunkOverlapSec),
                      totalChunks: Number(cp.totalChunks || 1),
                      completedChunks: Number(cp.completedChunks || 0),
                      currentChunkIndex: Number(cp.currentChunkIndex || 0),
                      checkpointPath,
                    },
                  },
                }).exec()
              )
              .catch(() => undefined);
          } catch {
            // ignore malformed checkpoint line
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          processStdoutLine(line);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrAccumulator = (stderrAccumulator + chunk.toString('utf8')).slice(-3000);
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        activeSubprocesses.delete(jobId);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        activeSubprocesses.delete(jobId);
        if (stdoutBuf.trim()) {
          processStdoutLine(stdoutBuf);
          stdoutBuf = '';
        }

        void pendingProgressChain.finally(() => {
          if (cancelledJobIds.has(jobId)) {
            reject(new Error('JOB_CANCELLED_BY_USER'));
            return;
          }
          if (code !== 0) {
            const cfErrMatch = stderrAccumulator.match(/CF_ERROR:(\{.*\})/);
            if (cfErrMatch) {
              try {
                const parsedErr = JSON.parse(cfErrMatch[1]);
                reject(new Error(`${lastStage}: ${parsedErr.error}`));
                return;
              } catch {
                // fall through
              }
            }
            reject(
              new Error(`Processor exited with code ${code}: ${stderrAccumulator.slice(-300)}`)
            );
            return;
          }
          resolve();
        });
      });
    });

    if (!fs.existsSync(outputJsonPath)) {
      throw new Error('Processor finished without emitting job_result.json');
    }

    const result = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));

    video.transcript = result.transcript || [];
    video.scenes = result.scenes || [];
    video.transcriptionEngine = result.transcriptionEngine;
    video.detectedLanguage = result.detectedLanguage || 'en';
    video.status = 'analyzed';
    await video.save();

    const createdClipIds: string[] = [];
    const renderedClips: any[] = result.clips || [];

    if (renderedClips.length === 0) {
      throw new Error('Processor produced 0 rendered clips');
    }

    for (let i = 0; i < renderedClips.length; i++) {
      const rc = renderedClips[i];
      const clipKeyPrefix = `clips/${String(claimed.userId)}/${String(project._id)}/${jobId}_${i + 1}`;
      const videoStorageKey = `${clipKeyPrefix}.mp4`;
      await storage.saveFromLocalFile(rc.localVideoPath, videoStorageKey, 'video/mp4');

      let thumbStorageKey: string | undefined;
      if (rc.localThumbPath && fs.existsSync(rc.localThumbPath)) {
        thumbStorageKey = `${clipKeyPrefix}.jpg`;
        await storage.saveFromLocalFile(rc.localThumbPath, thumbStorageKey, 'image/jpeg');
      }

      const { metadata } = await generateClipMetadataWithGracefulFallback({
        projectTitle: project.title,
        clipTranscript: rc.transcript || project.title,
        category: rc.category || 'insight',
        durationSec: rc.durationSec || 15,
      });

      if (claimed.type === 'regenerate_clip' && claimed.targetClipId && i === 0) {
        const updatedClip = await Clip.findByIdAndUpdate(
          claimed.targetClipId,
          {
            $set: {
              jobId: claimed._id,
              aspectRatio: rc.aspectRatio,
              storageKey: videoStorageKey,
              storageProvider: storage.provider,
              thumbnailKey: thumbStorageKey,
              fileSizeBytes: rc.fileSizeBytes,
              width: rc.width,
              height: rc.height,
              durationSec: rc.durationSec,
              editingApplied: rc.editingApplied || [],
              captionStyle: effectiveSettings.captionStyle,
              captions: rc.captions || [],
              captionSource: rc.captionSource,
              status: 'ready',
            },
          },
          { new: true }
        );
        if (updatedClip) createdClipIds.push(String(updatedClip._id));
      } else {
        const clipDoc = await Clip.create({
          userId: claimed.userId,
          projectId: project._id,
          videoId: video._id,
          jobId: claimed._id,
          title: metadata.titleOptions[0] || rc.title || `Clip ${i + 1}`,
          startSec: rc.startSec,
          endSec: rc.endSec,
          durationSec: rc.durationSec,
          aspectRatio: rc.aspectRatio,
          transcript: rc.transcript || '',
          selectionReason: rc.selectionReason || 'Complete highlight moment.',
          category: rc.category || 'insight',
          engagementScore: rc.engagementScore || 75,
          storageKey: videoStorageKey,
          storageProvider: storage.provider,
          thumbnailKey: thumbStorageKey,
          fileSizeBytes: rc.fileSizeBytes,
          width: rc.width,
          height: rc.height,
          status: 'ready',
          captionStyle: effectiveSettings.captionStyle,
          captions: rc.captions || [],
          captionSource: rc.captionSource,
          editingApplied: rc.editingApplied || [],
          metadata,
        });
        createdClipIds.push(String(clipDoc._id));
      }
    }

    // Deduct credits ONLY after successful rendering & validation
    const actualCost =
      claimed.type === 'regenerate_clip'
        ? Math.min(claimed.creditsReserved, 5)
        : await calculateJobCreditCost(video.durationSec, renderedClips.length);

    const { deducted } = await settleReservedCredits({
      userId: claimed.userId,
      jobId: String(claimed._id),
      reservedAmount: claimed.creditsReserved,
      actualAmount: Math.min(claimed.creditsReserved, actualCost),
      description: `Completed video processing for "${project.title}" (${renderedClips.length} clips)`,
    });

    const totalProjectClips = await Clip.countDocuments({
      projectId: project._id,
      status: 'ready',
    });

    project.status = 'completed';
    project.clipsCount = totalProjectClips;
    project.creditsConsumed = (project.creditsConsumed || 0) + deducted;
    await project.save();

    await ProcessingJob.findByIdAndUpdate(jobId, {
      $set: {
        stage: 'completed',
        status: 'completed',
        progressPercent: 100,
        currentMessage: `Generated and validated ${renderedClips.length} short clip(s).`,
        creditsDeducted: deducted,
        completedAt: new Date(),
        diagnostics: {
          aiProvider: aiProvider.providerName,
          aiConfigured: aiProvider.isConfigured(),
          whisperStatus: result.diagnostics?.whisperStatus || result.transcriptionEngine,
          ffmpegAvailable: true,
          warnings: result.diagnostics?.warnings || [],
        },
      },
    });

    removeFileSafe(checkpointPath);

    await Notification.create({
      userId: claimed.userId,
      type: 'job_completed',
      title: 'Clips Ready for Download',
      message: `"${project.title}" finished rendering ${renderedClips.length} short clip(s).`,
      actionUrl: `/dashboard/projects/${String(project._id)}`,
    });

    logger.info('Processing job completed successfully', {
      jobId,
      clipsRendered: createdClipIds.length,
      creditsDeducted: deducted,
    });
  } catch (err: any) {
    const errCode = String(err?.code || 'PIPELINE_EXECUTION_ERROR');
    const errMessage = String(err?.message || 'Video processing pipeline failed');
    const isCancelled =
      cancelledJobIds.has(jobId) ||
      errCode === 'JOB_CANCELLED' ||
      errMessage.includes('JOB_CANCELLED_BY_USER');

    if (isCancelled) {
      cancelledJobIds.delete(jobId);
      removeFileSafe(checkpointPath);
      await handleJobCancellationCleanup(jobId, String(project._id));
      return;
    }

    const canAutoRetry =
      !options?.disableAutoRetry &&
      !NON_RETRYABLE_ERROR_CODES.has(errCode) &&
      claimed.attempts < (claimed.maxAttempts || 3) &&
      fs.existsSync(checkpointPath);

    if (canAutoRetry) {
      logger.warn('Transient worker interruption; re-queueing job from saved chunk checkpoint', {
        jobId,
        attempt: claimed.attempts,
        maxAttempts: claimed.maxAttempts,
        errMessage,
      });
      await ProcessingJob.findByIdAndUpdate(jobId, {
        $set: {
          status: 'queued',
          currentMessage: `Interrupted during chunk processing (attempt ${claimed.attempts}/${claimed.maxAttempts}) — resuming from saved checkpoint...`,
        },
        $push: {
          stageHistory: {
            stage: lastStage,
            startedAt: new Date(),
            message: `Auto-resuming from checkpoint after interruption: ${errMessage.slice(0, 140)}`,
          },
        },
      });
      const { enqueueProcessingJob } = await import('../queues/videoQueue');
      await enqueueProcessingJob(jobId);
      return;
    }

    removeFileSafe(checkpointPath);
    await failAndReleaseJob(jobId, errCode, errMessage, lastStage);
  } finally {
    removeDirSafe(tempJobDir);
  }
}

async function handleJobCancellationCleanup(jobId: string, projectId: string): Promise<void> {
  const job = await ProcessingJob.findById(jobId);
  if (!job) return;

  if (!job.creditReservationReleased && job.creditsReserved > 0) {
    await releaseReservedCredits({
      userId: job.userId,
      jobId: String(job._id),
      reservedAmount: job.creditsReserved,
      reason: 'Job cancelled by user',
    });
    job.creditReservationReleased = true;
  }

  job.status = 'cancelled';
  job.stage = 'cancelled';
  job.cancelledAt = new Date();
  job.currentMessage = 'Cancelled by user. Reserved credits returned to wallet.';
  await job.save();

  await Project.findByIdAndUpdate(projectId, { $set: { status: 'cancelled' } });
}

export async function failAndReleaseJob(
  jobId: string,
  code: string,
  message: string,
  stage: string
): Promise<void> {
  const job = await ProcessingJob.findById(jobId);
  if (!job) return;

  removeFileSafe(getJobCheckpointPath(jobId));

  if (!job.creditReservationReleased && job.creditsReserved > 0) {
    await releaseReservedCredits({
      userId: job.userId,
      jobId: String(job._id),
      reservedAmount: job.creditsReserved,
      reason: `Job failed (${code})`,
    });
    job.creditReservationReleased = true;
  }

  job.status = 'failed';
  job.stage = 'failed';
  job.currentMessage = message.slice(0, 300);
  job.error = {
    code,
    message: message.slice(0, 500),
    stage,
  };
  await job.save();

  await Project.findByIdAndUpdate(job.projectId, { $set: { status: 'failed' } });

  await Notification.create({
    userId: job.userId,
    type: 'job_failed',
    title: 'Video Processing Failed',
    message: `Job failed (${message.slice(0, 140)}). Reserved credits were automatically returned to your wallet.`,
    actionUrl: '/dashboard/queue',
  });

  logger.error('Processing job marked failed and reserved credits released', {
    jobId,
    code,
    message,
  });
}
