import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '../config/env';
import { ProcessingJob } from '../models';
import { logger } from '../utils/logger';
import { cancelRunningSubprocess, executeProcessingJob } from '../workers/videoWorker';
import { releaseReservedCredits } from '../services/walletService';

export const BULL_QUEUE_NAME = 'clipforge-video-processing';

let redisConnection: IORedis | null = null;
let bullQueue: Queue | null = null;
let queueMode: 'bullmq' | 'local_worker' = 'local_worker';

// Local in-process FIFO worker queue when Redis is not configured
const localPendingIds: string[] = [];
let activeLocalCount = 0;
let localPumpScheduled = false;

export async function initializeQueueSystem(): Promise<'bullmq' | 'local_worker'> {
  if (env.REDIS_URL && env.REDIS_URL.trim().length > 0) {
    try {
      const conn = new IORedis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        connectTimeout: 2500,
        lazyConnect: true,
      });
      await conn.connect();
      await conn.ping();
      redisConnection = conn;
      bullQueue = new Queue(BULL_QUEUE_NAME, { connection: conn as any });
      queueMode = 'bullmq';
      logger.info('Initialized BullMQ + Redis queue', { queue: BULL_QUEUE_NAME });
      return 'bullmq';
    } catch (err) {
      logger.warn('Redis unavailable; falling back to persistent local background worker queue', {
        err,
      });
    }
  }

  queueMode = 'local_worker';
  await recoverOrphanedJobsOnStartup();
  return 'local_worker';
}

export function getActiveQueueMode(): 'bullmq' | 'local_worker' {
  return queueMode;
}

export function getRedisConnection(): IORedis | null {
  return redisConnection;
}

function scheduleLocalPump(): void {
  if (localPumpScheduled) return;
  localPumpScheduled = true;
  setImmediate(() => {
    localPumpScheduled = false;
    void pumpLocalWorker();
  });
}

async function pumpLocalWorker(): Promise<void> {
  while (activeLocalCount < env.WORKER_CONCURRENCY && localPendingIds.length > 0) {
    const nextId = localPendingIds.shift();
    if (!nextId) break;
    activeLocalCount += 1;
    executeProcessingJob(nextId)
      .catch((err) => {
        logger.error('Local worker execution error', { jobId: nextId, err });
      })
      .finally(() => {
        activeLocalCount = Math.max(0, activeLocalCount - 1);
        scheduleLocalPump();
      });
  }
}

export async function enqueueProcessingJob(jobId: string): Promise<void> {
  if (queueMode === 'bullmq' && bullQueue) {
    const bJob = await bullQueue.add(
      'process-video',
      { jobId },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      }
    );
    await ProcessingJob.findByIdAndUpdate(jobId, {
      $set: { bullJobId: String(bJob.id), queueMode: 'bullmq' },
    });
    return;
  }

  if (!localPendingIds.includes(jobId)) {
    localPendingIds.push(jobId);
  }
  scheduleLocalPump();
}

export async function cancelQueuedOrRunningJob(jobId: string): Promise<void> {
  const idx = localPendingIds.indexOf(jobId);
  if (idx >= 0) {
    localPendingIds.splice(idx, 1);
  }
  if (queueMode === 'bullmq' && bullQueue) {
    try {
      const bJob = await bullQueue.getJob(jobId);
      if (bJob) await bJob.remove();
    } catch {
      // ignore if already active in bull worker
    }
  }
  cancelRunningSubprocess(jobId);
}

export async function recoverOrphanedJobsOnStartup(): Promise<void> {
  // Crash recovery: resume interrupted 'processing' jobs from saved chunk checkpoints
  // when retry attempts remain; otherwise fail safely and release reserved credits.
  const interrupted = await ProcessingJob.find({ status: 'processing' });
  for (const job of interrupted) {
    const attempts = job.attempts || 0;
    const maxAttempts = job.maxAttempts || 3;
    if (attempts < maxAttempts) {
      job.status = 'queued';
      job.currentMessage = `Server restarted — resuming processing from saved checkpoint (attempt ${
        attempts + 1
      }/${maxAttempts})...`;
      job.stageHistory.push({
        stage: job.stage,
        startedAt: new Date(),
        message: 'Recovered after server restart; re-queued to resume from chunk checkpoint.',
      });
      await job.save();
    } else {
      job.status = 'failed';
      job.stage = 'failed';
      job.error = {
        code: 'WORKER_RESTART_MAX_ATTEMPTS',
        message:
          'Worker restarted after maximum retry attempts. Reserved credits released automatically.',
        stage: job.stage,
      };
      if (!job.creditReservationReleased && job.creditsReserved > 0) {
        await releaseReservedCredits({
          userId: job.userId,
          jobId: String(job._id),
          reservedAmount: job.creditsReserved,
          reason: 'Worker crash recovery release after max attempts',
        });
        job.creditReservationReleased = true;
      }
      await job.save();
    }
  }

  const waiting = await ProcessingJob.find({ status: 'queued' }).sort({ createdAt: 1 });
  for (const job of waiting) {
    if (queueMode === 'local_worker') {
      if (!localPendingIds.includes(String(job._id))) {
        localPendingIds.push(String(job._id));
      }
    }
  }
  if (localPendingIds.length > 0) {
    scheduleLocalPump();
  }
}

export async function getQueueHealth() {
  const [queuedCount, processingCount, failedCount] = await Promise.all([
    ProcessingJob.countDocuments({ status: 'queued' }),
    ProcessingJob.countDocuments({ status: 'processing' }),
    ProcessingJob.countDocuments({ status: 'failed' }),
  ]);

  return {
    mode: queueMode,
    redisConnected: Boolean(redisConnection && redisConnection.status === 'ready'),
    queuedCount,
    processingCount,
    failedCount,
  };
}
