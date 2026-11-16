import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { env } from './config/env';
import { ensureSystemBootstrap } from './models';
import { initializeQueueSystem } from './queues/videoQueue';
import { logger } from './utils/logger';

async function bootstrap() {
  await connectDatabase();
  await ensureSystemBootstrap();
  const queueMode = await initializeQueueSystem();

  const app = createApp();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info('ClipForge AI API Server listening', {
      host: '0.0.0.0',
      port: env.PORT,
      env: env.NODE_ENV,
      queueMode,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}; shutting down gracefully...`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error('Fatal server bootstrap error', { err });
    process.exit(1);
  });
}
