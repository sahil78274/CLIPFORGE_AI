import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load root .env then server/.env if present
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer?.path && fs.existsSync(installer.path)) {
      return installer.path;
    }
  } catch {
    // fall back to PATH
  }
  return 'ffmpeg';
}

function resolveFfprobePath(): string {
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return process.env.FFPROBE_PATH;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installer = require('@ffprobe-installer/ffprobe');
    if (installer?.path && fs.existsSync(installer.path)) {
      return installer.path;
    }
  } catch {
    // fall back to PATH
  }
  return 'ffprobe';
}

function resolvePythonBin(): string {
  const repoRootVenv = path.resolve(__dirname, '../../../.venv/bin/python');
  const winVenv = path.resolve(__dirname, '../../../.venv/Scripts/python.exe');
  if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) {
    return process.env.PYTHON_BIN;
  }
  if (fs.existsSync(repoRootVenv)) return repoRootVenv;
  if (fs.existsSync(winVenv)) return winVenv;
  return process.env.PYTHON_BIN || 'python3';
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),

  MONGODB_URI: z
    .string()
    .min(10)
    .default('mongodb://127.0.0.1:27017/clipforge_ai?directConnection=true'),
  ENABLE_EMBEDDED_MONGO_FALLBACK: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  DOWNLOAD_SIGNING_SECRET: z.string().optional(),

  ADMIN_BOOTSTRAP_EMAIL: z.string().email().default('admin@clipforge.local'),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().default('ChangeMeImmediately!2026'),

  REDIS_URL: z.string().optional().default(''),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  JOB_TIMEOUT_MS: z.coerce.number().int().min(30000).default(7200000),

  VIDEO_CHUNK_DURATION_SEC: z.coerce.number().int().min(15).max(3600).default(600),
  VIDEO_CHUNK_OVERLAP_SEC: z.coerce.number().min(0).max(30).default(5),
  MAX_VIDEO_DURATION_SEC: z.coerce.number().int().min(60).max(43200).default(36000),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default(path.resolve(__dirname, '../../storage')),
  TEMP_WORKING_DIR: z.string().default(path.resolve(__dirname, '../../temp')),

  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_PUBLIC_BASE_URL: z.string().optional().default(''),

  WHISPER_MODEL_SIZE: z.string().default('base'),
  WHISPER_MODEL_PATH: z.string().optional().default(''),
  WHISPER_DEVICE: z.string().default('cpu'),
  WHISPER_COMPUTE_TYPE: z.string().default('int8'),

  AI_PROVIDER: z.enum(['gemini', 'openai_compatible']).default('gemini'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  YOUTUBE_DATA_API_KEY: z.string().optional().default(''),
  YOUTUBE_OEMBED_ENDPOINT: z.string().default('https://www.youtube.com/oembed'),
  YOUTUBE_MEDIA_ADAPTER: z
    .enum(['composite', 'owner_export_dir', 'authorized_http_provider', 'custom_command'])
    .default('composite'),
  YOUTUBE_AUTHORIZED_EXPORTS_DIR: z
    .string()
    .default(path.resolve(__dirname, '../../authorized_youtube_exports')),
  YOUTUBE_MEDIA_PROVIDER_URL: z.string().optional().default(''),
  YOUTUBE_MEDIA_PROVIDER_TOKEN: z.string().optional().default(''),
  YOUTUBE_MEDIA_COMMAND_BIN: z.string().optional().default(''),
  YOUTUBE_MEDIA_COMMAND_ARGS_JSON: z.string().optional().default(''),
  ALLOW_DIRECT_MEDIA_URL_IMPORT: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  PAYMENT_SANDBOX_SIMULATOR: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PAYMENT_SANDBOX_SECRET: z
    .string()
    .default('dev-only-sandbox-hmac-secret-do-not-use-in-prod'),
});

const parsed = envSchema.parse(process.env);

const isProd = parsed.NODE_ENV === 'production';

if (
  isProd &&
  (!parsed.JWT_ACCESS_SECRET ||
    parsed.JWT_ACCESS_SECRET.length < 32 ||
    parsed.JWT_ACCESS_SECRET.includes('replace-with'))
) {
  throw new Error(
    'FATAL CONFIG ERROR: JWT_ACCESS_SECRET must be a strong >=32-character secret in production.'
  );
}

const resolvedJwtSecret =
  parsed.JWT_ACCESS_SECRET &&
  parsed.JWT_ACCESS_SECRET.length >= 32 &&
  !parsed.JWT_ACCESS_SECRET.includes('replace-with')
    ? parsed.JWT_ACCESS_SECRET
    : crypto
        .createHash('sha256')
        .update(`clipforge-dev-secret-${path.resolve(__dirname, '../../..')}`)
        .digest('hex');

const resolvedDownloadSecret =
  parsed.DOWNLOAD_SIGNING_SECRET &&
  parsed.DOWNLOAD_SIGNING_SECRET.length >= 32 &&
  !parsed.DOWNLOAD_SIGNING_SECRET.includes('replace-with')
    ? parsed.DOWNLOAD_SIGNING_SECRET
    : crypto
        .createHash('sha256')
        .update(`clipforge-download-secret-${resolvedJwtSecret}`)
        .digest('hex');

export const env = {
  ...parsed,
  JWT_ACCESS_SECRET: resolvedJwtSecret,
  DOWNLOAD_SIGNING_SECRET: resolvedDownloadSecret,
  FFMPEG_PATH: resolveFfmpegPath(),
  FFPROBE_PATH: resolveFfprobePath(),
  PYTHON_BIN: resolvePythonBin(),
  PROCESSOR_MAIN_PY: path.resolve(__dirname, '../../../processor/main.py'),
  LOCAL_STORAGE_DIR: path.isAbsolute(parsed.LOCAL_STORAGE_DIR)
    ? parsed.LOCAL_STORAGE_DIR
    : path.resolve(__dirname, '../..', parsed.LOCAL_STORAGE_DIR),
  TEMP_WORKING_DIR: path.isAbsolute(parsed.TEMP_WORKING_DIR)
    ? parsed.TEMP_WORKING_DIR
    : path.resolve(__dirname, '../..', parsed.TEMP_WORKING_DIR),
  YOUTUBE_AUTHORIZED_EXPORTS_DIR: path.isAbsolute(parsed.YOUTUBE_AUTHORIZED_EXPORTS_DIR)
    ? parsed.YOUTUBE_AUTHORIZED_EXPORTS_DIR
    : path.resolve(__dirname, '../..', parsed.YOUTUBE_AUTHORIZED_EXPORTS_DIR),
};
