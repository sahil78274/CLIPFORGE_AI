import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { ForbiddenError, NotConfiguredError, NotFoundError } from '../utils/errors';

export interface StorageAdapter {
  provider: 'local' | 's3';
  saveFromLocalFile(localFilePath: string, key: string, contentType: string): Promise<void>;
  resolveLocalPathForProcessing(key: string, destTempDir: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
  getSignedReadUrl(key: string, expiresInSec?: number): Promise<string | null>;
}

class LocalStorageAdapter implements StorageAdapter {
  public readonly provider = 'local' as const;
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private safeFullPath(key: string): string {
    const normalized = key.replace(/^\/+/, '');
    const full = path.resolve(this.baseDir, normalized);
    if (!full.startsWith(path.resolve(this.baseDir))) {
      throw new ForbiddenError('Unsafe storage key traversal blocked');
    }
    return full;
  }

  async saveFromLocalFile(localFilePath: string, key: string): Promise<void> {
    const target = this.safeFullPath(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (path.resolve(localFilePath) !== target) {
      fs.copyFileSync(localFilePath, target);
    }
  }

  async resolveLocalPathForProcessing(key: string): Promise<string> {
    const target = this.safeFullPath(key);
    if (!fs.existsSync(target)) {
      throw new NotFoundError('Media file missing from storage');
    }
    return target;
  }

  async deleteObject(key: string): Promise<void> {
    try {
      const target = this.safeFullPath(key);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    } catch {
      // ignore already deleted file
    }
  }

  async getSignedReadUrl(): Promise<string | null> {
    return null;
  }

  public getSafeReadPath(key: string): string {
    const target = this.safeFullPath(key);
    if (!fs.existsSync(target)) {
      throw new NotFoundError('Requested media file does not exist');
    }
    return target;
  }
}

class S3StorageAdapter implements StorageAdapter {
  public readonly provider = 's3' as const;
  private client: S3Client;
  private bucket: string;

  constructor() {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new NotConfiguredError(
        'STORAGE_PROVIDER is set to s3, but S3_BUCKET, S3_ACCESS_KEY_ID, or S3_SECRET_ACCESS_KEY is missing.'
      );
    }
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION || 'auto',
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async saveFromLocalFile(localFilePath: string, key: string, contentType: string): Promise<void> {
    const stream = fs.createReadStream(localFilePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: contentType,
      })
    );
  }

  async resolveLocalPathForProcessing(key: string, destTempDir: string): Promise<string> {
    fs.mkdirSync(destTempDir, { recursive: true });
    const outPath = path.join(destTempDir, path.basename(key));
    const resp = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    if (!resp.Body) throw new NotFoundError('S3 object body empty');
    const bytes = await resp.Body.transformToByteArray();
    fs.writeFileSync(outPath, Buffer.from(bytes));
    return outPath;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getSignedReadUrl(key: string, expiresInSec = 3600): Promise<string | null> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSec });
  }
}

export const localStorage = new LocalStorageAdapter(env.LOCAL_STORAGE_DIR);

export function getStorageAdapter(): StorageAdapter {
  if (env.STORAGE_PROVIDER === 's3') {
    return new S3StorageAdapter();
  }
  return localStorage;
}

/* ---------------- SIGNED MEDIA ACCESS TOKENS ---------------- */
export function createMediaAccessToken(params: {
  userId: string;
  resourceType: 'clip_video' | 'clip_thumb' | 'clip_download' | 'bulk_zip';
  resourceId: string;
  ttlSeconds?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (params.ttlSeconds || 3600);
  const payload = `${params.userId}:${params.resourceType}:${params.resourceId}:${exp}`;
  const sig = crypto
    .createHmac('sha256', env.DOWNLOAD_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

export function verifyMediaAccessToken(
  token: string,
  expectedType: 'clip_video' | 'clip_thumb' | 'clip_download' | 'bulk_zip',
  expectedResourceId?: string
): { userId: string; resourceId: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new ForbiddenError('Malformed media access token', 'INVALID_MEDIA_TOKEN');
  }

  const parts = decoded.split(':');
  if (parts.length !== 5) {
    throw new ForbiddenError('Invalid media access token', 'INVALID_MEDIA_TOKEN');
  }

  const [userId, resourceType, resourceId, expStr, providedSig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    throw new ForbiddenError('Media download link has expired', 'EXPIRED_MEDIA_TOKEN');
  }
  if (resourceType !== expectedType) {
    throw new ForbiddenError('Media token scope mismatch', 'INVALID_MEDIA_TOKEN');
  }
  if (expectedResourceId && resourceId !== expectedResourceId) {
    throw new ForbiddenError('Media token resource mismatch', 'INVALID_MEDIA_TOKEN');
  }

  const expectedSig = crypto
    .createHmac('sha256', env.DOWNLOAD_SIGNING_SECRET)
    .update(`${userId}:${resourceType}:${resourceId}:${expStr}`)
    .digest('hex');

  if (
    providedSig.length !== expectedSig.length ||
    !/^[0-9a-f]+$/i.test(providedSig)
  ) {
    throw new ForbiddenError('Invalid media token signature', 'INVALID_MEDIA_TOKEN');
  }

  const bufA = Buffer.from(providedSig, 'hex');
  const bufB = Buffer.from(expectedSig, 'hex');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    throw new ForbiddenError('Invalid media token signature', 'INVALID_MEDIA_TOKEN');
  }

  return { userId, resourceId };
}
