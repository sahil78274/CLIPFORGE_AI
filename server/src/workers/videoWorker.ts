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
} from '../models';
import { getStorageAdapter } from '../services/storageService';
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
const cancelledJobIds = new Set<string>();

export function cancelRunningSubprocess(jobId: string): void {
  cancelledJobIds.add(jobId);
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

export async function executeProcessingJob(jobId: string): Promise<void> {
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
  const video = claimed.videoId ? await Video.findById(claimed.videoId) : null;

  if (!project || !video) {
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
  fs.mkdirSync(outputDir, { recursive: true });

  const storage = getStorageAdapter();
  const aiProvider = getAIProvider();

  try {
    const localVideoPath = await storage.resolveLocalPathForProcessing(
      video.storageKey,
      path.join(tempJobDir, 'source')
    );

    const effectiveSettings = {
      ...project.settings,
      ...(claimed.overrides || {}),
    };

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
        };
      }
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

    let lastStage = 'importing';
    let stderrAccumulator = '';

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
        reject(new Error(`Processing job timed out after ${Math.round(env.JOB_TIMEOUT_MS / 1000)}s`));
      }, env.JOB_TIMEOUT_MS);

      let stdoutBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('CF_EVENT:')) {
            try {
              const evt = JSON.parse(trimmed.slice('CF_EVENT:'.length));
              lastStage = evt.stage || lastStage;
              void ProcessingJob.findByIdAndUpdate(jobId, {
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
              }).exec();
            } catch {
              // ignore malformed log line
            }
          }
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
          reject(new Error(`Processor exited with code ${code}: ${stderrAccumulator.slice(-300)}`));
          return;
        }
        resolve();
      });
    });

    if (!fs.existsSync(outputJsonPath)) {
      throw new Error('Processor finished without emitting job_result.json');
    }

    const result = JSON.parse(fs.readFileSync(outputJsonPath, 'utf8'));

    // Persist analyzed transcript & scene metadata onto Video
    video.transcript = result.transcript || [];
    video.scenes = result.scenes || [];
    video.transcriptionEngine = result.transcriptionEngine;
    video.detectedLanguage = result.detectedLanguage || 'en';
    video.status = 'analyzed';
    await video.save();

    // Save rendered clips & thumbnails to configured StorageAdapter + create Clip documents
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
          editingApplied: rc.editingApplied || [],
          metadata,
        });
        createdClipIds.push(String(clipDoc._id));
      }
    }

    // Calculate actual credit cost and settle reserved wallet credits
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
    const isCancelled =
      cancelledJobIds.has(jobId) || String(err?.message || '').includes('JOB_CANCELLED_BY_USER');

    if (isCancelled) {
      cancelledJobIds.delete(jobId);
      await handleJobCancellationCleanup(jobId, String(project._id));
    } else {
      await failAndReleaseJob(
        jobId,
        'PIPELINE_EXECUTION_ERROR',
        err?.message || 'Video processing pipeline failed',
        'rendering'
      );
    }
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
