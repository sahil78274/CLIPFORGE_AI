import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';

const TEST_ROOT = path.resolve(__dirname, '../../temp/google_drive_suite');
const STORAGE_DIR = path.join(TEST_ROOT, 'storage');
const WORK_DIR = path.join(TEST_ROOT, 'work');
const FIXTURES_DIR = path.join(TEST_ROOT, 'fixtures');
const UNIT_CACHE_MP4 = path.join(TEST_ROOT, 'unit_60s_cache.mp4');
const MONGO_EJSON = path.resolve(
  __dirname,
  '../../.data/embedded-mongo/clipforge_gdrive_suite.ejson'
);

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI =
  'mongodb://127.0.0.1:27114/clipforge_gdrive_suite?directConnection=true';
process.env.ENABLE_EMBEDDED_MONGO_FALLBACK = 'true';
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;
process.env.TEMP_WORKING_DIR = WORK_DIR;
process.env.MAX_VIDEO_DURATION_SEC = '36000';
process.env.VIDEO_CHUNK_DURATION_SEC = '600';
process.env.VIDEO_CHUNK_OVERLAP_SEC = '5';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY =
  'clipforge-test-aes-256-gcm-encryption-secret-key-2026';

import { createApp } from '../app';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import {
  Clip,
  CreditTransaction,
  CreditWallet,
  ProcessingJob,
  UserGoogleIntegration,
  ensureSystemBootstrap,
} from '../models';
import { initializeQueueSystem } from '../queues/videoQueue';
import { probeMediaFile } from '../services/mediaProbeService';
import {
  clearInMemoryAccessTokensForTesting,
  expireInMemoryAccessTokenForTesting,
  GOOGLE_DRIVE_FILE_SCOPE,
} from '../services/mediaAcquisition/GoogleOAuthProvider';

function computeMd5Hex(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

async function waitForJobTerminal(jobId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await ProcessingJob.findById(jobId).lean();
    if (
      job &&
      (job.status === 'completed' ||
        job.status === 'failed' ||
        job.status === 'cancelled')
    ) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

interface MockDriveEntry {
  id: string;
  ownerTokenPrefix: 'userA' | 'userB';
  name: string;
  mimeType: string;
  filePath?: string;
  sizeBytes: number;
  durationMillis?: number;
  width?: number;
  height?: number;
  md5Checksum?: string;
  thumbnailLink?: string;
  dropFirstStreamHalfway?: boolean;
  failDownloadCount?: number;
}

describe('ClipForge AI — Google OAuth 2.0 + Official Google Picker + Google Drive Import Suite', () => {
  const app = createApp();
  const fixtureScript = path.resolve(
    __dirname,
    '../../../scripts/generate-long-video-fixture.py'
  );

  let mockGoogleServer: http.Server;
  let mockBaseUrl = '';

  let userAAgent: ReturnType<typeof request.agent>;
  let userBAgent: ReturnType<typeof request.agent>;
  let userAId = '';

  let mp4FixturePath = '';
  let movFixturePath = '';
  let tenHourFixturePath = '';

  // Mutable state for simulated Google OAuth + Google Drive v3 upstream
  let tokenRefreshCount = 0;
  let revokeEndpointCalledCount = 0;
  let simulateRevokedRefreshToken = false;
  let rangeResumeObserved = false;
  const driveCatalog = new Map<string, MockDriveEntry>();

  beforeAll(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(MONGO_EJSON, { force: true });
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });

    mp4FixturePath = path.join(FIXTURES_DIR, 'Founder_Keynote_Master.mp4');
    movFixturePath = path.join(FIXTURES_DIR, 'Studio_Camera_Reel.mov');
    tenHourFixturePath = path.join(FIXTURES_DIR, 'Ten_Hour_Summit_Archive.mp4');

    // Generate genuine H.264 + AAC MP4 (36s), QuickTime MOV (36s), and 10-Hour (36,000s) MP4
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output',
      mp4FixturePath,
      '--ffmpeg',
      env.FFMPEG_PATH,
      '--duration',
      '36',
      '--unit-cache',
      UNIT_CACHE_MP4,
    ]);

    execFileSync(
      env.FFMPEG_PATH,
      ['-y', '-i', mp4FixturePath, '-c', 'copy', '-f', 'mov', movFixturePath],
      { stdio: 'ignore' }
    );

    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output',
      tenHourFixturePath,
      '--ffmpeg',
      env.FFMPEG_PATH,
      '--duration',
      '36000',
      '--unit-cache',
      UNIT_CACHE_MP4,
    ]);

    const mp4Size = fs.statSync(mp4FixturePath).size;
    const movSize = fs.statSync(movFixturePath).size;
    const tenHourSize = fs.statSync(tenHourFixturePath).size;

    driveCatalog.set('drv_mp4_valid_01', {
      id: 'drv_mp4_valid_01',
      ownerTokenPrefix: 'userA',
      name: 'Founder_Keynote_Master.mp4',
      mimeType: 'video/mp4',
      filePath: mp4FixturePath,
      sizeBytes: mp4Size,
      durationMillis: 36_000,
      width: 640,
      height: 360,
      md5Checksum: computeMd5Hex(mp4FixturePath),
      thumbnailLink: 'https://lh3.googleusercontent.com/d/drv_mp4_valid_01=s220',
    });

    driveCatalog.set('drv_mov_valid_02', {
      id: 'drv_mov_valid_02',
      ownerTokenPrefix: 'userA',
      name: 'Studio_Camera_Reel.mov',
      mimeType: 'video/quicktime',
      filePath: movFixturePath,
      sizeBytes: movSize,
      durationMillis: 36_000,
      width: 640,
      height: 360,
      md5Checksum: computeMd5Hex(movFixturePath),
      thumbnailLink: 'https://lh3.googleusercontent.com/d/drv_mov_valid_02=s220',
    });

    driveCatalog.set('drv_resumable_large_03', {
      id: 'drv_resumable_large_03',
      ownerTokenPrefix: 'userA',
      name: 'Large_Conference_Stream_Resumable.mp4',
      mimeType: 'video/mp4',
      filePath: mp4FixturePath,
      sizeBytes: mp4Size,
      durationMillis: 36_000,
      width: 640,
      height: 360,
      md5Checksum: computeMd5Hex(mp4FixturePath),
      dropFirstStreamHalfway: true,
    });

    driveCatalog.set('drv_corrupt_md5_04', {
      id: 'drv_corrupt_md5_04',
      ownerTokenPrefix: 'userA',
      name: 'Corrupted_Transfer_Test.mp4',
      mimeType: 'video/mp4',
      filePath: mp4FixturePath,
      sizeBytes: mp4Size,
      durationMillis: 36_000,
      width: 640,
      height: 360,
      md5Checksum: 'ffffffffffffffffffffffffffffffff',
    });

    driveCatalog.set('drv_pdf_doc_05', {
      id: 'drv_pdf_doc_05',
      ownerTokenPrefix: 'userA',
      name: 'Slide_Deck_Notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 24_000,
    });

    driveCatalog.set('drv_userB_private_06', {
      id: 'drv_userB_private_06',
      ownerTokenPrefix: 'userB',
      name: 'Other_Users_Confidential_Video.mp4',
      mimeType: 'video/mp4',
      filePath: mp4FixturePath,
      sizeBytes: mp4Size,
      durationMillis: 36_000,
      width: 640,
      height: 360,
      md5Checksum: computeMd5Hex(mp4FixturePath),
    });

    driveCatalog.set('drv_flaky_retry_07', {
      id: 'drv_flaky_retry_07',
      ownerTokenPrefix: 'userA',
      name: 'Transient_Failure_Then_Retry.mp4',
      mimeType: 'video/mp4',
      filePath: mp4FixturePath,
      sizeBytes: mp4Size,
      durationMillis: 36_000,
      width: 640,
      height: 360,
      md5Checksum: computeMd5Hex(mp4FixturePath),
      failDownloadCount: 3,
    });

    driveCatalog.set('drv_10h_marathon_08', {
      id: 'drv_10h_marathon_08',
      ownerTokenPrefix: 'userA',
      name: 'Ten_Hour_Summit_Archive.mp4',
      mimeType: 'video/mp4',
      filePath: tenHourFixturePath,
      sizeBytes: tenHourSize,
      durationMillis: 36_000_000,
      width: 640,
      height: 360,
      md5Checksum: computeMd5Hex(tenHourFixturePath),
    });

    driveCatalog.set('drv_11h_overlimit_09', {
      id: 'drv_11h_overlimit_09',
      ownerTokenPrefix: 'userA',
      name: 'Eleven_Hour_Over_Limit.mp4',
      mimeType: 'video/mp4',
      filePath: mp4FixturePath,
      sizeBytes: mp4Size,
      durationMillis: 39_600_000,
      width: 640,
      height: 360,
    });

    mockGoogleServer = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const authHeader = String(req.headers.authorization || '');

      // 1. OAuth Token Exchange & Refresh Endpoint
      if (parsed.pathname === '/oauth2/token' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (c) => (rawBody += c));
        req.on('end', () => {
          const params = new URLSearchParams(rawBody);
          const grantType = params.get('grant_type');
          if (grantType === 'authorization_code') {
            const code = params.get('code');
            if (code === 'code_user_a') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  access_token: 'ya29.userA_initial_token',
                  refresh_token: '1//refresh_token_userA_secret',
                  expires_in: 3600,
                  scope: `openid email profile ${GOOGLE_DRIVE_FILE_SCOPE}`,
                  token_type: 'Bearer',
                })
              );
              return;
            }
            if (code === 'code_user_b') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  access_token: 'ya29.userB_initial_token',
                  refresh_token: '1//refresh_token_userB_secret',
                  expires_in: 3600,
                  scope: `openid email profile ${GOOGLE_DRIVE_FILE_SCOPE}`,
                  token_type: 'Bearer',
                })
              );
              return;
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'Invalid authorization code',
              })
            );
            return;
          }

          if (grantType === 'refresh_token') {
            if (simulateRevokedRefreshToken) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'invalid_grant',
                  error_description: 'Token has been expired or revoked.',
                })
              );
              return;
            }
            const rt = params.get('refresh_token') || '';
            tokenRefreshCount += 1;
            const prefix = rt.includes('userB') ? 'userB' : 'userA';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                access_token: `ya29.${prefix}_refreshed_${tokenRefreshCount}`,
                expires_in: 3600,
                scope: `openid email profile ${GOOGLE_DRIVE_FILE_SCOPE}`,
                token_type: 'Bearer',
              })
            );
            return;
          }

          res.writeHead(400).end();
        });
        return;
      }

      // 2. OAuth Token Revocation Endpoint
      if (parsed.pathname === '/oauth2/revoke' && req.method === 'POST') {
        revokeEndpointCalledCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ revoked: true }));
        return;
      }

      // 3. Google OpenID UserInfo Endpoint
      if (parsed.pathname === '/oauth2/userinfo') {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401).end();
          return;
        }
        const isUserB = authHeader.includes('userB');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            sub: isUserB ? 'google-sub-user-b' : 'google-sub-user-a',
            email: isUserB ? 'userb@drive.test' : 'usera@drive.test',
            name: isUserB ? 'Creator User B' : 'Creator User A',
            picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c',
          })
        );
        return;
      }

      // 4. Google Drive v3 File Metadata & Streaming Media Download
      if (parsed.pathname.startsWith('/drive/v3/files/')) {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 401, message: 'Unauthorized' } }));
          return;
        }

        const callerPrefix: 'userA' | 'userB' = authHeader.includes('userB')
          ? 'userB'
          : 'userA';
        const fileId = decodeURIComponent(
          parsed.pathname.replace('/drive/v3/files/', '')
        );
        const entry = driveCatalog.get(fileId);

        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'File not found' } }));
          return;
        }

        // Enforce strict per-Google-user Drive ownership
        if (entry.ownerTokenPrefix !== callerPrefix) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 403,
                message: 'The authenticated user does not have permission for this file.',
              },
            })
          );
          return;
        }

        if (parsed.searchParams.get('alt') === 'media') {
          if (entry.failDownloadCount && entry.failDownloadCount > 0) {
            entry.failDownloadCount -= 1;
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: { code: 502, message: 'Upstream gateway error' } })
            );
            return;
          }

          if (!entry.filePath || !fs.existsSync(entry.filePath)) {
            res.writeHead(404).end();
            return;
          }

          const totalBytes = fs.statSync(entry.filePath).size;
          const rangeHeader = req.headers.range;

          // Simulate mid-stream truncation on first attempt, then honor Range header on retry!
          if (entry.dropFirstStreamHalfway && !rangeHeader) {
            entry.dropFirstStreamHalfway = false;
            const halfBytes = Math.floor(totalBytes / 2);
            res.writeHead(200, {
              'Content-Type': entry.mimeType,
              'Accept-Ranges': 'bytes',
            });
            const partialBuf = Buffer.alloc(halfBytes);
            const fd = fs.openSync(entry.filePath, 'r');
            fs.readSync(fd, partialBuf, 0, halfBytes, 0);
            fs.closeSync(fd);
            res.write(partialBuf, () => {
              setTimeout(() => res.end(), 20);
            });
            return;
          }

          if (rangeHeader && /^bytes=(\d+)-/.test(rangeHeader)) {
            const match = /^bytes=(\d+)-/.exec(rangeHeader)!;
            const start = Number(match[1]);
            rangeResumeObserved = true;
            res.writeHead(206, {
              'Content-Type': entry.mimeType,
              'Content-Length': String(totalBytes - start),
              'Content-Range': `bytes ${start}-${totalBytes - 1}/${totalBytes}`,
              'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(entry.filePath, { start }).pipe(res);
            return;
          }

          res.writeHead(200, {
            'Content-Type': entry.mimeType,
            'Content-Length': String(totalBytes),
            'Accept-Ranges': 'bytes',
          });
          fs.createReadStream(entry.filePath).pipe(res);
          return;
        }

        // Metadata response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: entry.id,
            name: entry.name,
            mimeType: entry.mimeType,
            size: String(entry.sizeBytes),
            md5Checksum: entry.md5Checksum,
            thumbnailLink: entry.thumbnailLink,
            modifiedTime: '2026-11-15T10:00:00.000Z',
            capabilities: { canDownload: true },
            videoMediaMetadata: entry.durationMillis
              ? {
                  width: entry.width || 640,
                  height: entry.height || 360,
                  durationMillis: String(entry.durationMillis),
                }
              : undefined,
          })
        );
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      mockGoogleServer.listen(0, '127.0.0.1', () => {
        const addr = mockGoogleServer.address();
        if (addr && typeof addr === 'object') {
          mockBaseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
    (env as any).GOOGLE_CLIENT_SECRET = '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client';
    (env as any).GOOGLE_REDIRECT_URI =
      'http://localhost:4000/api/v1/google-drive/oauth/callback';
    (env as any).GOOGLE_API_KEY = 'AIzaSyTestBrowserPickerKeyOnly';
    (env as any).GOOGLE_PROJECT_NUMBER = '987654321098';
    (env as any).GOOGLE_OAUTH_AUTH_URL = `${mockBaseUrl}/oauth2/auth`;
    (env as any).GOOGLE_OAUTH_TOKEN_URL = `${mockBaseUrl}/oauth2/token`;
    (env as any).GOOGLE_OAUTH_REVOKE_URL = `${mockBaseUrl}/oauth2/revoke`;
    (env as any).GOOGLE_OAUTH_USERINFO_URL = `${mockBaseUrl}/oauth2/userinfo`;
    (env as any).GOOGLE_DRIVE_API_BASE_URL = `${mockBaseUrl}/drive/v3`;
    (env as any).LOCAL_STORAGE_DIR = STORAGE_DIR;
    (env as any).TEMP_WORKING_DIR = WORK_DIR;
    clearInMemoryAccessTokensForTesting();

    await connectDatabase(process.env.MONGODB_URI);
    await ensureSystemBootstrap();
    await initializeQueueSystem();

    userAAgent = request.agent(app);
    const regA = await userAAgent.post('/api/v1/auth/register').send({
      name: 'Drive Creator A',
      email: 'drive.user.a@clipforge.test',
      password: 'Password123!',
    });
    expect(regA.status).toBe(201);
    userAId = regA.body.data.user.id;

    await CreditWallet.findOneAndUpdate(
      { userId: userAId },
      { $set: { availableCredits: 2000, reservedCredits: 0 } }
    );

    userBAgent = request.agent(app);
    const regB = await userBAgent.post('/api/v1/auth/register').send({
      name: 'Drive Creator B',
      email: 'drive.user.b@clipforge.test',
      password: 'Password123!',
    });
    expect(regB.status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mockGoogleServer.close(() => resolve()));
    await disconnectDatabase();
    clearInMemoryAccessTokensForTesting();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(MONGO_EJSON, { force: true });
  });

  it('1. Connects Google Drive with minimum drive.file scope, handles OAuth cancellation & invalid/replayed state, encrypts refresh tokens, and never stores permanent access tokens or exposes secrets', async () => {
    const initStatus = await userAAgent.get('/api/v1/google-drive/oauth/status');
    expect(initStatus.status).toBe(200);
    expect(initStatus.body.data.connected).toBe(false);
    expect(initStatus.body.data.oauthConfigured).toBe(true);
    expect(initStatus.body.data.pickerConfigured).toBe(true);
    expect(JSON.stringify(initStatus.body)).not.toContain(
      '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client'
    );

    // OAuth Cancellation (JSON & Browser Redirect modes)
    const cancelJson = await userAAgent
      .get('/api/v1/google-drive/oauth/callback')
      .query({ error: 'access_denied', format: 'json' });
    expect(cancelJson.status).toBe(400);
    expect(cancelJson.body.error.code).toBe('GOOGLE_OAUTH_CANCELLED');

    const cancelBrowser = await request(app)
      .get('/api/v1/google-drive/oauth/callback')
      .set('Accept', 'text/html')
      .query({ error: 'access_denied' });
    expect(cancelBrowser.status).toBe(302);
    expect(cancelBrowser.headers.location).toContain('googleError=');

    // Create Authorization URL — verify minimum scope (drive.file ONLY)
    const authUrlRes = await userAAgent
      .post('/api/v1/google-drive/oauth/authorize')
      .send({ redirectPath: '/dashboard/create?tab=google_drive' });
    expect(authUrlRes.status).toBe(200);
    const { authorizationUrl, state, scopes } = authUrlRes.body.data;
    expect(scopes).toContain(GOOGLE_DRIVE_FILE_SCOPE);
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive.readonly');

    const parsedUrl = new URL(authorizationUrl);
    expect(parsedUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/v1/google-drive/oauth/callback'
    );
    expect(parsedUrl.searchParams.get('access_type')).toBe('offline');
    expect(parsedUrl.searchParams.get('scope')).toContain(GOOGLE_DRIVE_FILE_SCOPE);

    // Invalid / Tampered OAuth state must fail
    const badStateRes = await userAAgent
      .get('/api/v1/google-drive/oauth/callback')
      .query({ code: 'code_user_a', state: `${state}tampered`, format: 'json' });
    expect(badStateRes.status).toBe(400);
    expect(badStateRes.body.error.code).toBe('GOOGLE_OAUTH_INVALID_STATE');

    // Valid OAuth callback succeeds
    const okCb = await userAAgent
      .get('/api/v1/google-drive/oauth/callback')
      .query({ code: 'code_user_a', state, format: 'json' });
    expect(okCb.status).toBe(200);
    expect(okCb.body.data.status.connected).toBe(true);
    expect(okCb.body.data.status.email).toBe('usera@drive.test');
    expect(okCb.body.data.status.hasDriveScope).toBe(true);

    // Replay of the exact same state nonce must fail (anti-replay protection)
    const replayRes = await userAAgent
      .get('/api/v1/google-drive/oauth/callback')
      .query({ code: 'code_user_a', state, format: 'json' });
    expect(replayRes.status).toBe(400);
    expect(replayRes.body.error.code).toBe('GOOGLE_OAUTH_INVALID_STATE');

    // Inspect MongoDB document: refresh token is AES-256-GCM encrypted; NO permanent access token stored
    const dbRecord = await UserGoogleIntegration.findOne({ userId: userAId }).lean();
    expect(dbRecord).toBeTruthy();
    expect((dbRecord as any).encryptedAccessToken).toBeUndefined();
    expect((dbRecord as any).accessToken).toBeUndefined();
    expect(typeof dbRecord!.encryptedRefreshToken).toBe('string');
    expect(dbRecord!.encryptedRefreshToken.startsWith('v1:')).toBe(true);
    expect(dbRecord!.encryptedRefreshToken).not.toContain('1//refresh_token_userA_secret');

    // Also connect User B cleanly for cross-user isolation tests
    const authB = await userBAgent
      .post('/api/v1/google-drive/oauth/authorize')
      .send({});
    const cbB = await userBAgent
      .get('/api/v1/google-drive/oauth/callback')
      .query({ code: 'code_user_b', state: authB.body.data.state, format: 'json' });
    expect(cbB.status).toBe(200);
  });

  it('2. Creates Picker session safely, validates Drive Picker file selection, and blocks unauthorized/unselected or cross-user Drive files', async () => {
    const pickerRes = await userAAgent.post('/api/v1/google-drive/picker-session');
    expect(pickerRes.status).toBe(200);
    expect(pickerRes.body.data.pickerConfigured).toBe(true);
    expect(pickerRes.body.data.apiKey).toBe('AIzaSyTestBrowserPickerKeyOnly');
    expect(pickerRes.body.data.appId).toBe('987654321098');
    expect(pickerRes.body.data.accessToken).toContain('ya29.userA');
    const serialized = JSON.stringify(pickerRes.body);
    expect(serialized).not.toContain('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client');
    expect(serialized).not.toContain('1//refresh_token');

    // Reject non-video Drive selection (PDF)
    const pdfRes = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_pdf_doc_05' });
    expect(pdfRes.status).toBe(400);
    expect(pdfRes.body.error.code).toBe('GOOGLE_DRIVE_NOT_VIDEO');

    // Reject >10h video selection
    const overLimitRes = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_11h_overlimit_09' });
    expect(overLimitRes.status).toBe(400);
    expect(overLimitRes.body.error.code).toBe('VIDEO_DURATION_LIMIT_EXCEEDED');

    // Reject client-supplied fileId on /import if user never selected it via Google Picker
    const unpickedImport = await userAAgent
      .post('/api/v1/google-drive/import')
      .send({
        fileId: 'drv_mp4_valid_01',
        settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
      });
    expect(unpickedImport.status).toBe(403);
    expect(unpickedImport.body.error.code).toBe('GOOGLE_DRIVE_FILE_NOT_AUTHORIZED');

    // Reject cross-user file access: User A trying to select User B's Drive file
    const crossUserSelect = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_userB_private_06' });
    expect(crossUserSelect.status).toBe(403);
    expect(crossUserSelect.body.error.code).toBe('GOOGLE_DRIVE_ACCESS_DENIED');

    // Even if User B selects their own file, User A STILL cannot import User B's fileId
    const userBOwnSelect = await userBAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_userB_private_06' });
    expect(userBOwnSelect.status).toBe(200);

    const crossUserImport = await userAAgent
      .post('/api/v1/google-drive/import')
      .send({
        fileId: 'drv_userB_private_06',
        settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
      });
    expect(crossUserImport.status).toBe(403);
    expect(crossUserImport.body.error.code).toBe('GOOGLE_DRIVE_FILE_NOT_AUTHORIZED');
  });

  it('3. Imports both MP4 and MOV videos from Google Drive end-to-end, verifies FFmpeg + Faster-Whisper clips, downloads MP4, settles credits, and cleans temp files', async () => {
    const walletBefore = await CreditWallet.findOne({ userId: userAId }).lean();
    const startCredits = walletBefore!.availableCredits;

    // --- 3A. MP4 Import ---
    const selectMp4 = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_mp4_valid_01', clipCount: 2 });
    expect(selectMp4.status).toBe(200);
    expect(selectMp4.body.data.file.mimeType).toBe('video/mp4');
    expect(selectMp4.body.data.file.thumbnailUrl).toContain('drv_mp4_valid_01');

    const importMp4 = await userAAgent.post('/api/v1/google-drive/import').send({
      fileId: 'drv_mp4_valid_01',
      title: 'Founder Keynote MP4 Drive Import',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 2,
        aspectRatio: '9:16',
      },
    });
    expect(importMp4.status).toBe(201);
    const mp4JobId = importMp4.body.data.job._id;
    const mp4ProjectId = importMp4.body.data.project._id;

    const finishedMp4Job = await waitForJobTerminal(mp4JobId);
    expect(finishedMp4Job.status).toBe('completed');
    expect(finishedMp4Job.creditsDeducted).toBeGreaterThan(0);

    // Verify temporary job directory was cleaned up after processing
    expect(fs.existsSync(path.join(WORK_DIR, `job_${mp4JobId}`))).toBe(false);

    // Fetch generated clips & verify real MP4 download
    const projRes = await userAAgent.get(`/api/v1/projects/${mp4ProjectId}`);
    expect(projRes.status).toBe(200);
    expect(projRes.body.data.project.sourceType).toBe('google_drive');
    expect(projRes.body.data.clips.length).toBe(2);

    const firstClip = projRes.body.data.clips[0];
    const dlPath = new URL(firstClip.downloadUrl, 'http://localhost:4000');
    const dlRes = await userAAgent.get(`${dlPath.pathname}${dlPath.search}`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-type']).toContain('video/mp4');

    // --- 3B. MOV (video/quicktime) Import ---
    const selectMov = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_mov_valid_02', clipCount: 1 });
    expect(selectMov.status).toBe(200);
    expect(selectMov.body.data.file.mimeType).toBe('video/quicktime');

    const importMov = await userAAgent.post('/api/v1/google-drive/import').send({
      fileId: 'drv_mov_valid_02',
      title: 'Studio Camera MOV Import',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 1,
        aspectRatio: '9:16',
      },
    });
    expect(importMov.status).toBe(201);
    const movJobId = importMov.body.data.job._id;
    const movProjectId = importMov.body.data.project._id;
    const finishedMovJob = await waitForJobTerminal(movJobId);
    expect(finishedMovJob.status).toBe('completed');

    const movProjRes = await userAAgent.get(`/api/v1/projects/${movProjectId}`);
    expect(movProjRes.status).toBe(200);
    expect(movProjRes.body.data.clips.length).toBe(1);
    const movClipItem = movProjRes.body.data.clips[0];
    const movDlUrl = new URL(movClipItem.downloadUrl, 'http://localhost:4000');
    const movDlRes = await userAAgent
      .get(`${movDlUrl.pathname}${movDlUrl.search}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(movDlRes.status).toBe(200);
    const downloadedMovClipMp4 = path.join(TEST_ROOT, 'verified_mov_output_clip.mp4');
    fs.writeFileSync(downloadedMovClipMp4, movDlRes.body as Buffer);
    const probe = await probeMediaFile(downloadedMovClipMp4);
    expect(probe.width).toBe(720);
    expect(probe.height).toBe(1280);
    expect(probe.durationSec).toBeGreaterThan(5);

    const walletAfter = await CreditWallet.findOne({ userId: userAId }).lean();
    expect(walletAfter!.reservedCredits).toBe(0);
    expect(walletAfter!.availableCredits).toBe(
      startCredits - finishedMp4Job.creditsDeducted - finishedMovJob.creditsDeducted
    );
  });

  it('4. Resumes interrupted large Drive downloads via HTTP Range, verifies MD5 checksum integrity, and refreshes expired access tokens transparently', async () => {
    const refreshBefore = tokenRefreshCount;
    expireInMemoryAccessTokenForTesting(userAId);

    const selectResumable = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_resumable_large_03', clipCount: 1 });
    expect(selectResumable.status).toBe(200);
    expect(tokenRefreshCount).toBeGreaterThan(refreshBefore);

    rangeResumeObserved = false;
    const importResumable = await userAAgent
      .post('/api/v1/google-drive/import')
      .send({
        fileId: 'drv_resumable_large_03',
        settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
      });
    expect(importResumable.status).toBe(201);

    const resumedJob = await waitForJobTerminal(importResumable.body.data.job._id);
    expect(resumedJob.status).toBe('completed');
    expect(rangeResumeObserved).toBe(true);

    // Corrupted MD5 checksum transfer must fail cleanly and refund 100% of reserved credits
    const walletBeforeCorrupt = await CreditWallet.findOne({ userId: userAId }).lean();
    await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_corrupt_md5_04' });

    const importCorrupt = await userAAgent
      .post('/api/v1/google-drive/import')
      .send({
        fileId: 'drv_corrupt_md5_04',
        settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
      });
    expect(importCorrupt.status).toBe(201);

    const failedCorruptJob = await waitForJobTerminal(importCorrupt.body.data.job._id);
    expect(failedCorruptJob.status).toBe('failed');
    expect(failedCorruptJob.error?.code).toBe('GOOGLE_DRIVE_CHECKSUM_MISMATCH');
    expect(failedCorruptJob.creditReservationReleased).toBe(true);

    const walletAfterCorrupt = await CreditWallet.findOne({ userId: userAId }).lean();
    expect(walletAfterCorrupt!.availableCredits).toBe(
      walletBeforeCorrupt!.availableCredits
    );
    expect(walletAfterCorrupt!.reservedCredits).toBe(0);
  });

  it('5. Handles failed Drive downloads with automatic credit refund AND succeeds when retried via POST /api/v1/jobs/:id/retry', async () => {
    const walletBefore = await CreditWallet.findOne({ userId: userAId }).lean();

    await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_flaky_retry_07' });

    const importFlaky = await userAAgent.post('/api/v1/google-drive/import').send({
      fileId: 'drv_flaky_retry_07',
      title: 'Flaky Upstream Then Manual Retry',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 1,
      },
    });
    expect(importFlaky.status).toBe(201);
    const initialJobId = importFlaky.body.data.job._id;

    // Wait for initial job to exhaust download retries + worker retries and fail cleanly
    const failedJob = await waitForJobTerminal(initialJobId);
    expect(failedJob.status).toBe('failed');
    expect(failedJob.error?.code).toBe('GOOGLE_DRIVE_DOWNLOAD_FAILED');
    expect(failedJob.creditReservationReleased).toBe(true);

    const walletAfterFail = await CreditWallet.findOne({ userId: userAId }).lean();
    expect(walletAfterFail!.availableCredits).toBe(walletBefore!.availableCredits);
    expect(walletAfterFail!.reservedCredits).toBe(0);

    // Upstream is now healthy (failDownloadCount decremented to 0) -> retry the failed job!
    const retryRes = await userAAgent.post(`/api/v1/jobs/${initialJobId}/retry`);
    expect(retryRes.status).toBe(202);
    const retriedJobId = retryRes.body.data.job._id;

    const succeededRetryJob = await waitForJobTerminal(retriedJobId);
    expect(succeededRetryJob.status).toBe('completed');
    expect(succeededRetryJob.creditsDeducted).toBeGreaterThan(0);

    const clips = await Clip.find({ jobId: retriedJobId }).lean();
    expect(clips.length).toBe(1);
  });

  it('6. Processes a 10-Hour Google Drive Video (36,000s) with chunk-based processing, global timestamps, boundary deduplication, and bounded RAM', async () => {
    await CreditWallet.updateOne(
      { userId: userAId },
      { $inc: { availableCredits: 10_000, totalEarnedCredits: 10_000 } }
    );

    const select10h = await userAAgent
      .post('/api/v1/google-drive/select-file')
      .send({ fileId: 'drv_10h_marathon_08', clipCount: 3 });
    expect(select10h.status).toBe(200);
    expect(select10h.body.data.file.durationSec).toBe(36_000);
    expect(select10h.body.data.chunkPlan.enabled).toBe(true);

    const rssBeforeMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    const import10h = await userAAgent.post('/api/v1/google-drive/import').send({
      fileId: 'drv_10h_marathon_08',
      title: '10-Hour Summit Drive Import',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 3,
        chunkDurationSec: 3000, // 12 chunks × 50 min = 10 hours
        aspectRatio: '9:16',
      },
    });
    expect(import10h.status).toBe(201);
    const job10hId = import10h.body.data.job._id;

    const completed10h = await waitForJobTerminal(job10hId, 180_000);
    expect(completed10h.status).toBe('completed');
    expect(completed10h.chunkProgress?.enabled).toBe(true);
    expect(completed10h.chunkProgress?.totalChunks).toBe(12);
    expect(completed10h.chunkProgress?.completedChunks).toBe(12);

    const rssAfterMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    expect(rssAfterMb - rssBeforeMb).toBeLessThan(350);

    const clips10h = await Clip.find({ jobId: job10hId }).sort({ orderIndex: 1 }).lean();
    expect(clips10h.length).toBe(3);
    expect(clips10h.some((c) => c.startSec >= 10_000)).toBe(true);
    for (let i = 1; i < clips10h.length; i++) {
      expect(clips10h[i].startSec).not.toBe(clips10h[i - 1].startSec);
    }

    expect(fs.existsSync(path.join(WORK_DIR, `job_${job10hId}`))).toBe(false);
  }, 180_000);

  it('7. Handles revoked Google permission cleanly, supports explicit disconnect/revocation, and preserves Option A Direct Video Upload', async () => {
    expireInMemoryAccessTokenForTesting(userAId);
    simulateRevokedRefreshToken = true;

    const revokedPicker = await userAAgent.post('/api/v1/google-drive/picker-session');
    expect(revokedPicker.status).toBe(401);
    expect(revokedPicker.body.error.code).toBe('GOOGLE_OAUTH_REVOKED');

    const statusAfterRevoke = await userAAgent.get('/api/v1/google-drive/oauth/status');
    expect(statusAfterRevoke.body.data.connected).toBe(false);
    simulateRevokedRefreshToken = false;

    // Test explicit disconnect & token revocation on User B
    const revokeBefore = revokeEndpointCalledCount;
    const discRes = await userBAgent.post('/api/v1/google-drive/oauth/disconnect');
    expect(discRes.status).toBe(200);
    expect(discRes.body.data.connected).toBe(false);
    expect(revokeEndpointCalledCount).toBeGreaterThan(revokeBefore);

    // Verify Option A (Direct Local Video Upload) remains 100% functional alongside Google Drive
    const uploadRes = await userAAgent
      .post('/api/v1/videos/upload')
      .field('title', 'Option A Local Upload Regression Check')
      .field('autoStart', 'true')
      .field(
        'settings',
        JSON.stringify({ ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 })
      )
      .attach('video', mp4FixturePath, {
        filename: 'Founder_Keynote_Master.mp4',
        contentType: 'video/mp4',
      });
    expect(uploadRes.status).toBe(201);
    const uploadJob = await waitForJobTerminal(uploadRes.body.data.job._id);
    expect(uploadJob.status).toBe('completed');

    const txHistory = await CreditTransaction.find({ userId: userAId }).lean();
    expect(txHistory.some((t) => t.type === 'reserve')).toBe(true);
    expect(txHistory.some((t) => t.type === 'deduct')).toBe(true);
    expect(txHistory.some((t) => t.type === 'release_reserve')).toBe(true);
  });
});
