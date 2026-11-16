import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 90000,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27099/clipforge_e2e_test?directConnection=true',
      ENABLE_EMBEDDED_MONGO_FALLBACK: 'true',
      PAYMENT_SANDBOX_SIMULATOR: 'true',
      PAYMENT_SANDBOX_SECRET: 'test-sandbox-hmac-secret-key-2026-clipforge',
      LOCAL_STORAGE_DIR: path.resolve(__dirname, 'temp/test_storage'),
      TEMP_WORKING_DIR: path.resolve(__dirname, 'temp/test_work'),
    },
  },
});
