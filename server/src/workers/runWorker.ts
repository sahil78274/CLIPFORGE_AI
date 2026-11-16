import { Worker } from 'bullmq';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import { ensureSystemBootstrap } from '../models';
import {
  BULL_QUEUE_NAME,
  getRedisConnection,
  initializeQueueSystem,
} from '../queues/videoQueue';
import { executeProcessingJob } from './videoWorker';
import { logger } from '../utils/logger';

async function startStandaloneWorker() {
  await connectDatabase();
  await ensureSystemBootstrap();
  const mode = await initializeQueueSystem();

  if (mode === 'bullmq') {
    const conn = getRedisConnection();
    const worker = new Worker(
      BULL_QUEUE_NAME,
      async (bullJob) => {
        await executeProcessingJob(String(bullJob.data.jobId));
      },
      {
        connection: conn as any,
        concurrency: env.WORKER_CONCURRENCY,
      }
    );
    logger.info('BullMQ standalone video worker running', {
      concurrency: env.WORKER_CONCURRENCY,
    });

    process.on('SIGTERM', async () => {
      await worker.close();
      await disconnectDatabase();
      process.exit(0);
    });
  } else {
    logger.info(
      'Standalone worker started in local_worker mode. Note: When REDIS_URL is not configured, the API server also processes local queue jobs directly.'
    );
  }
}

if (require.main === module) {
  startStandaloneWorker().catch((err) => {
    logger.error('Fatal worker startup error', { err });
    process.exit(1);
  });
}
