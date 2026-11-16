import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27109/clipforge_upload_limits_test?directConnection=true';
process.env.ENABLE_EMBEDDED_MONGO_FALLBACK = 'true';

import { connectDatabase, disconnectDatabase } from '../config/database';
import { getOrCreateSystemConfig, SystemConfig } from '../models';

const dbFile = path.resolve(__dirname, '../../.data/embedded-mongo/clipforge_upload_limits_test.ejson');

describe('upload limit migration', () => {
  beforeAll(async () => {
    fs.rmSync(dbFile, { force: true });
    await connectDatabase(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await disconnectDatabase();
    fs.rmSync(dbFile, { force: true });
  });

  it('uses 10 GiB for new configs, migrates the old default once, and preserves custom limits', async () => {
    const cfg = await getOrCreateSystemConfig();
    expect(cfg.maxUploadSizeMb).toBe(10240);
    await SystemConfig.updateOne({ _id: cfg._id }, { $set: { maxUploadSizeMb: 250, uploadLimitMigrated: false } });
    expect((await getOrCreateSystemConfig()).maxUploadSizeMb).toBe(10240);
    await SystemConfig.updateOne({ _id: cfg._id }, { $set: { maxUploadSizeMb: 250 } });
    expect((await getOrCreateSystemConfig()).maxUploadSizeMb).toBe(250);
    await SystemConfig.updateOne({ _id: cfg._id }, { $set: { maxUploadSizeMb: 500, uploadLimitMigrated: false } });
    expect((await getOrCreateSystemConfig()).maxUploadSizeMb).toBe(500);
  });
});
