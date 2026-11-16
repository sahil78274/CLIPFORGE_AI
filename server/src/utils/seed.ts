import { connectDatabase, disconnectDatabase } from '../config/database';
import { ensureSystemBootstrap } from '../models';
import { logger } from './logger';

async function runSeed() {
  await connectDatabase();
  await ensureSystemBootstrap();
  logger.info('Database bootstrap and seed completed successfully');
  await disconnectDatabase();
}

runSeed().catch((err) => {
  logger.error('Seed script failed', { err });
  process.exit(1);
});
