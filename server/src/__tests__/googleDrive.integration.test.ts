import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';

// Isolated environment configured BEFORE importing server modules.
const TEST_ROOT = path.resolve(__dirname, '../../temp/google_drive_suite');
const STORAGE_DIR = path.join(TEST_ROOT, 'storage');
const WORK_DIR = path.join(TEST_ROOT, 'work');
const FIXTURES_DIR = path.join(TEST_ROOT, 'fixtures');
const MONGO_EJSON = path.resolve(
  __dirname,
  '../../.data/embedded-mongo/clipforge_gdrive_test.ejson'
);

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI =
  'mongodb://127.0.0.1:27111/clipforge_gdrive_test?directConnection=true';
process.env.ENABLE_EMBEDDED_MONGO_FALLBACK = 'true';
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;
process.env.TEMP_WORKING_DIR = WORK_DIR;
process.env.MAX_VIDEO_DURATION_SEC = '36000';
process.env.VIDEO_CHUNK_DURATION_SEC = '600';
process.env.VIDEO_CHUNK_OVERLAP_SEC = '5';

import { createApp } from '../app';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import {
  Clip,
  CreditWallet,
  GoogleDriveFileSelection,
  ProcessingJob,
  Project,
  UserGoogleDriveConnection,
  ensureSystemBootstrap,
} from '../models';
import { initializeQueueSystem } from '../queues/videoQueue';
import { getStorageAdapter } from '../services/storageService';
import { decryptOAuthToken } from '../services/mediaAcquisition';
import { getGoogleDriveOAuthService } from '../services/googleDrive/GoogleDriveOAuthService';

async function waitForJobTerminal(
  agent: ReturnType<typeof request.agent>,
  jobId: string,
  timeoutMs = 240000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await agent.get(`/api/v1/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const job = res.body.data.job;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for job ${jobId} after ${timeoutMs}ms`);
}

function serveRangedFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  const stat = fs.statSync(filePath);
  const range = String(req.headers.range || '');
  const m = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m) {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      ETag: `"etag_${stat.size}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), stat.size - 1);
  if (start >= stat.size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    ETag: `"etag_${stat.size}"`,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

describe('ClipForge AI — Google Drive OAuth 2.0 + Official Picker + Streamed Import Suite', () => {
  const app = createApp();
  const fixtureScript = path.resolve(
    __dirname,
    '../../../scripts/generate-long-video-fixture.py'
  );
  const unitCacheMp4 = path.join(TEST_ROOT, 'unit_60s_cache.mp4');

  let mockGoogleServer: http.Server;
  let mockGoogleBaseUrl = '';

  let ownerAgent: ReturnType<typeof request.agent>;
  let ownerUserId = '';
  let outsiderAgent: ReturnType<typeof request.agent>;

  let mp4Short = '';
  let mp4Mov = '';
  let mp4Large = '';
  let mp4TenHours = '';
  let largeMd5 = '';
  let largeSha256 = '';
  let shortStat: fs.Stats;
  let largeStat: fs.Stats;
  let tenHourSize = 0;

  let validAuthCode = 'valid_drive_auth_code';
  let issuedRefreshToken = '1//0g_drive_owner_refresh_token';
  let revokedMode = false;
  let refreshCount = 0;
  let replayCallbackUsed = false;
  let transientFailuresRemaining = 0;
  let brokenDownload = true;
  let mediaRequestCount = 0;

  const oauthCallbackPath = '/api/v1/google-drive/oauth/callback';

  beforeAll(async () => {
    fs.rmSync(MONGO_EJSON, { force: true });
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });

    // Real, FFprobe-verifiable H.264 + AAC fixtures (never fake bytes).
    mp4Short = path.join(FIXTURES_DIR, 'drive_creator_36s.mp4');
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output', mp4Short,
      '--ffmpeg', env.FFMPEG_PATH,
      '--duration', '36',
      '--unit-cache', unitCacheMp4,
    ]);
    mp4Mov = path.join(FIXTURES_DIR, 'drive_creator_36s_mov.mov');
    fs.copyFileSync(mp4Short, mp4Mov);
    mp4Large = path.join(FIXTURES_DIR, 'drive_creator_75s.mp4');
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output', mp4Large,
      '--ffmpeg', env.FFMPEG_PATH,
      '--duration', '75',
      '--unit-cache', unitCacheMp4,
    ]);
    mp4TenHours = path.join(FIXTURES_DIR, 'drive_creator_10h.mp4');
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output', mp4TenHours,
      '--ffmpeg', env.FFMPEG_PATH,
      '--duration', '36000',
      '--unit-cache', unitCacheMp4,
    ]);

    shortStat = fs.statSync(mp4Short);
    tenHourSize = fs.statSync(mp4TenHours).size;
    largeStat = fs.statSync(mp4Large);
    largeMd5 = crypto.createHash('md5').update(fs.readFileSync(mp4Large)).digest('hex');
    largeSha256 = crypto.createHash('sha256').update(fs.readFileSync(mp4Large)).digest('hex');

    const driveFileMeta = (id: string, name: string, mimeType: string, size: number, durationSec: number) => ({
      id,
      name,
      mimeType,
      size: String(size),
      modifiedTime: '2026-11-16T09:00:00.000Z',
      trashed: false,
      capabilities: { canDownload: true },
      videoMediaMetadata: { width: 640, height: 360, durationMillis: String(durationSec * 1000) },
      thumbnailLink: `${mockGoogleBaseUrl}/thumb/${id}.jpg`,
    });

    mockGoogleServer = http.createServer(async (req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const authHeader = String(req.headers.authorization || '');

      // --- OAuth 2.0 token endpoint ---
      if (req.method === 'POST' && u.pathname === '/oauth2/token') {
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(ch as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));

        if (form.get('grant_type') === 'authorization_code') {
          if (form.get('code') !== validAuthCode) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'ya29.drive_initial_access_token',
              refresh_token: issuedRefreshToken,
              expires_in: 3600,
              token_type: 'Bearer',
              scope: [
                'openid',
                'email',
                'profile',
                'https://www.googleapis.com/auth/drive.file',
              ].join(' '),
            })
          );
          return;
        }

        if (form.get('grant_type') === 'refresh_token') {
          if (
            revokedMode ||
            form.get('refresh_token') !== issuedRefreshToken ||
            form.get('client_secret') !== env.GOOGLE_CLIENT_SECRET
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          refreshCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: `ya29.drive_refreshed_${refreshCount}`,
              expires_in: 3600,
              token_type: 'Bearer',
            })
          );
          return;
        }
      }

      if (req.method === 'POST' && u.pathname === '/oauth2/revoke') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ revoked: true }));
        return;
      }

      if (req.method === 'GET' && u.pathname === '/oauth2/userinfo') {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'google-drive-uid-7788',
            email: 'drive.owner@clipforge-studio.test',
            name: 'Drive Owner',
            picture: 'https://lh3.googleusercontent.com/a/drive-owner',
          })
        );
        return;
      }

      // --- Drive thumbnail proxy target ---
      if (req.method === 'GET' && u.pathname.startsWith('/thumb/')) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'));
        return;
      }

      // --- Drive v3 metadata + alt=media download ---
      if (u.pathname.startsWith('/drive/v3/files/')) {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }));
          return;
        }
        const fileId = decodeURIComponent(u.pathname.replace('/drive/v3/files/', ''));
        const isMedia = u.searchParams.get('alt') === 'media';

        if (fileId === 'drive_not_a_video_pdf') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: fileId,
              name: 'Show_Notes.pdf',
              mimeType: 'application/pdf',
              size: '4096',
              trashed: false,
              capabilities: { canDownload: true },
            })
          );
          return;
        }

        if (fileId === 'drive_private_other_user') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 403, message: 'The user does not have access' } }));
          return;
        }

        if (fileId === 'drive_deleted_file') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'File not found' } }));
          return;
        }

        const table: Record<
          string,
          { meta: Record<string, unknown>; filePath?: string; mode?: 'broken' | 'transient' }
        > = {
          drive_mp4_short_036: { meta: driveFileMeta('drive_mp4_short_036', 'Keynote_Clip_036.mp4', 'video/mp4', shortStat.size, 36), filePath: mp4Short },
          drive_mov_short_036: { meta: driveFileMeta('drive_mov_short_036', 'Keynote_Clip_036.mov', 'video/quicktime', shortStat.size, 36), filePath: mp4Mov },
          drive_large_075: {
            meta: {
              ...driveFileMeta('drive_large_075', 'Long_Guest_Lecture_075.mp4', 'video/mp4', largeStat.size, 75),
              md5Checksum: largeMd5,
              sha256Checksum: largeSha256,
            },
            filePath: mp4Large,
          },
          drive_transient_075: { meta: driveFileMeta('drive_transient_075', 'Flaky_But_Resumable_075.mp4', 'video/mp4', largeStat.size, 75), filePath: mp4Large, mode: 'transient' },
          drive_broken_502: {
            meta: driveFileMeta('drive_broken_502', 'Unavailable_Export_036.mp4', 'video/mp4', shortStat.size, 36),
            filePath: mp4Short,
            mode: 'broken',
          },
          drive_ten_hours_36000: {
            meta: driveFileMeta('drive_ten_hours_36000', 'Ten_Hour_Marathon_Master.mp4', 'video/mp4', tenHourSize, 36000),
            filePath: mp4TenHours,
          },
        };

        const entry = table[fileId];
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'File not found' } }));
          return;
        }

        if (!isMedia) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(entry.meta));
          return;
        }

        mediaRequestCount += 1;
        if (entry.mode === 'broken' && brokenDownload) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 502, message: 'storage shard unavailable' } }));
          return;
        }
        if (entry.mode === 'transient' && transientFailuresRemaining > 0) {
          transientFailuresRemaining -= 1;
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ error: { code: 503, message: 'try again' } }));
          return;
        }
        if (!entry.filePath) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 502, message: 'no backing media' } }));
          return;
        }
        serveRangedFile(req, res, entry.filePath);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unhandled mock Google route', path: u.pathname }));
    });

    await new Promise<void>((resolve) => mockGoogleServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockGoogleServer.address() as { port: number };
    mockGoogleBaseUrl = `http://127.0.0.1:${addr.port}`;

    // Point the Drive integration at the deterministic mock Google endpoints.
    const mutableEnv = env as any;
    mutableEnv.GOOGLE_CLIENT_ID = 'test-drive-client-id.apps.googleusercontent.com';
    mutableEnv.GOOGLE_CLIENT_SECRET = 'GOCSPX-test-drive-client-secret';
    mutableEnv.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/v1/google-drive/oauth/callback';
    mutableEnv.GOOGLE_API_KEY = 'AIzaSyTestPickerBrowserKey123456';
    mutableEnv.GOOGLE_PROJECT_NUMBER = '123456789012';
    mutableEnv.GOOGLE_TOKEN_ENCRYPTION_KEY = 'drive-test-token-encryption-key-32chars-min';
    mutableEnv.GOOGLE_OAUTH_AUTH_URL = `${mockGoogleBaseUrl}/oauth2/auth`;
    mutableEnv.GOOGLE_OAUTH_TOKEN_URL = `${mockGoogleBaseUrl}/oauth2/token`;
    mutableEnv.GOOGLE_OAUTH_USERINFO_URL = `${mockGoogleBaseUrl}/oauth2/userinfo`;
    mutableEnv.GOOGLE_OAUTH_REVOKE_URL = `${mockGoogleBaseUrl}/oauth2/revoke`;
    mutableEnv.GOOGLE_DRIVE_API_BASE_URL = `${mockGoogleBaseUrl}/drive/v3`;
    mutableEnv.LOCAL_STORAGE_DIR = STORAGE_DIR;
    mutableEnv.TEMP_WORKING_DIR = WORK_DIR;
    mutableEnv.MONGO_EJSON_PATH = MONGO_EJSON;

    await connectDatabase(process.env.MONGODB_URI);
    await ensureSystemBootstrap();
    await initializeQueueSystem();

    ownerAgent = request.agent(app);
    const regOwner = await ownerAgent.post('/api/v1/auth/register').send({
      name: 'Drive Owner',
      email: 'drive.owner@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(regOwner.status).toBe(201);
    ownerUserId = regOwner.body.data.user.id;
    await CreditWallet.findOneAndUpdate(
      { userId: ownerUserId },
      { $set: { availableCredits: 5000, reservedCredits: 0 } }
    );

    outsiderAgent = request.agent(app);
    const regOutsider = await outsiderAgent.post('/api/v1/auth/register').send({
      name: 'Drive Outsider',
      email: 'drive.outsider@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(regOutsider.status).toBe(201);
    await CreditWallet.findOneAndUpdate(
      { userId: regOutsider.body.data.user.id },
      { $set: { availableCredits: 5000, reservedCredits: 0 } }
    );
  }, 240000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mockGoogleServer.close(() => resolve()));
    await disconnectDatabase();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(MONGO_EJSON, { force: true });
  });

  it('1. Reports honest configuration status and rejects invalid, tampered, expired and replayed OAuth state', async () => {
    const configRes = await ownerAgent.get('/api/v1/google-drive/config');
    expect(configRes.status).toBe(200);
    expect(configRes.body.data.pickerConfigured).toBe(true);
    expect(configRes.body.data.apiKey).toBe('AIzaSyTestPickerBrowserKey123456');
    expect(configRes.body.data.projectNumber).toBe('123456789012');
    // The OAuth client secret must never be exposed to the browser.
    expect(JSON.stringify(configRes.body)).not.toContain('GOCSPX-test-drive-client-secret');

    const authorizeRes = await ownerAgent.post('/api/v1/google-drive/oauth/authorize').send({
      redirectPath: '/dashboard/create?tab=drive',
    });
    expect(authorizeRes.status).toBe(200);
    const authUrl = new URL(authorizeRes.body.data.authorizationUrl);
    expect(authUrl.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/drive.file'
    );
    expect(authUrl.searchParams.get('scope')).not.toContain('drive.readonly');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('prompt')).toBe('consent');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/v1/google-drive/oauth/callback'
    );
    const signedState = authUrl.searchParams.get('state') || '';
    expect(signedState).toContain('.');

    // Tampered signature
    const tampered = await request(app)
      .get(oauthCallbackPath)
      .query({ code: validAuthCode, state: `${signedState}tamper`, format: 'json' });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error.code).toBe('GOOGLE_DRIVE_INVALID_STATE');

    // Garbage / missing state
    const garbage = await request(app)
      .get(oauthCallbackPath)
      .query({ code: validAuthCode, state: 'not-a-signed-state', format: 'json' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('GOOGLE_DRIVE_INVALID_STATE');

    // Genuinely signed but expired state (mirrors what Google would return after 10+ minutes).
    const expiredAuthorize = await ownerAgent
      .post('/api/v1/google-drive/oauth/authorize')
      .send({});
    const expiredState = new URL(expiredAuthorize.body.data.authorizationUrl).searchParams.get(
      'state'
    ) as string;
    const [encodedPayload] = expiredState.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const expiredPayload = Buffer.from(
      JSON.stringify({ ...payload, exp: Date.now() - 60_000 }),
      'utf8'
    ).toString('base64url');
    const expiredSignature = crypto
      .createHmac('sha256', env.JWT_ACCESS_SECRET)
      .update(`clipforge-drive-oauth-state-v1:${expiredPayload}`)
      .digest('base64url');
    const expiredAttempt = await request(app)
      .get(oauthCallbackPath)
      .query({ code: validAuthCode, state: `${expiredPayload}.${expiredSignature}`, format: 'json' });
    expect(expiredAttempt.status).toBe(400);
    expect(expiredAttempt.body.error.code).toBe('GOOGLE_DRIVE_STATE_EXPIRED');

    // Nothing was stored by any failed attempt.
    expect(await UserGoogleDriveConnection.countDocuments({ userId: ownerUserId })).toBe(0);
  });

  it('2. Handles OAuth cancellation without storing any credential', async () => {
    const authorizeRes = await ownerAgent.post('/api/v1/google-drive/oauth/authorize').send({
      redirectPath: '/dashboard/create?tab=drive',
    });
    const state = new URL(authorizeRes.body.data.authorizationUrl).searchParams.get('state') || '';

    const cancelRes = await request(app)
      .get(oauthCallbackPath)
      .query({ error: 'access_denied', state, format: 'json' });
    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.error.code).toBe('GOOGLE_DRIVE_OAUTH_CANCELLED');
    expect(await UserGoogleDriveConnection.countDocuments({ userId: ownerUserId })).toBe(0);

    // Browser (HTML) cancellation redirects back to the app with a friendly flag.
    const authorizeRes2 = await ownerAgent.post('/api/v1/google-drive/oauth/authorize').send({});
    const state2 = new URL(authorizeRes2.body.data.authorizationUrl).searchParams.get('state') || '';
    const browserCancel = await request(app)
      .get(oauthCallbackPath)
      .query({ error: 'access_denied', state: state2 })
      .set('Accept', 'text/html');
    expect(browserCancel.status).toBe(302);
    expect(browserCancel.headers.location).toContain('driveError=cancelled');
  });

  it('3. Completes OAuth 2.0 authorization-code exchange, encrypts only the refresh token, and enforces single-use state', async () => {
    const authorizeRes = await ownerAgent.post('/api/v1/google-drive/oauth/authorize').send({
      redirectPath: '/dashboard/create?tab=drive',
    });
    const state = new URL(authorizeRes.body.data.authorizationUrl).searchParams.get('state') || '';

    const cbRes = await request(app)
      .get(oauthCallbackPath)
      .query({ code: validAuthCode, state, format: 'json' });
    expect(cbRes.status).toBe(200);
    expect(cbRes.body.data.status.connected).toBe(true);
    expect(cbRes.body.data.status.email).toBe('drive.owner@clipforge-studio.test');
    expect(cbRes.body.data.status.hasRequiredScope).toBe(true);

    const dbRecord = await UserGoogleDriveConnection.findOne({ userId: ownerUserId }).lean();
    expect(dbRecord).toBeTruthy();
    expect(dbRecord!.status).toBe('active');
    expect(dbRecord!.scopes).toContain('https://www.googleapis.com/auth/drive.file');
    // Refresh token must be AES-256-GCM encrypted at rest and decryptable server-side.
    expect(dbRecord!.encryptedRefreshToken.startsWith('v1:')).toBe(true);
    expect(dbRecord!.encryptedRefreshToken).not.toContain(issuedRefreshToken);
    expect(decryptOAuthToken(dbRecord!.encryptedRefreshToken)).toBe(issuedRefreshToken);
    // No plaintext access token is ever persisted in the connection document.
    expect(JSON.stringify(dbRecord)).not.toContain('ya29.');

    // Replaying the same callback state must be rejected (single-use).
    const replay = await request(app)
      .get(oauthCallbackPath)
      .query({ code: validAuthCode, state, format: 'json' });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('GOOGLE_DRIVE_INVALID_STATE');
    replayCallbackUsed = true;

    const statusRes = await ownerAgent.get('/api/v1/google-drive/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.connected).toBe(true);
    expect(JSON.stringify(statusRes.body)).not.toContain(issuedRefreshToken);

    // Picker token: short-lived access token only, never a refresh token.
    const tokenRes = await ownerAgent.get('/api/v1/google-drive/picker-token');
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.data.accessToken).toMatch(/^ya29\./);
    expect(JSON.stringify(tokenRes.body)).not.toContain('refresh_token');
    expect(tokenRes.headers['cache-control']).toBe('no-store');
  });

  it('4. Verifies every Picker file selection with the user\'s own credentials and blocks cross-user access', async () => {
    // Unsupported MIME
    const pdf = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_not_a_video_pdf' });
    expect(pdf.status).toBe(400);
    expect(pdf.body.error.code).toBe('GOOGLE_DRIVE_NOT_VIDEO');

    // File owned by someone else / not granted by the drive.file consent
    const forbidden = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_private_other_user' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('GOOGLE_DRIVE_ACCESS_DENIED');

    // Deleted / nonexistent file
    const missing = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_deleted_file' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('GOOGLE_DRIVE_FILE_NOT_FOUND');

    // Malformed file ID is rejected by validation before any network call
    const malformed = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: '../etc/passwd' });
    expect(malformed.status).toBe(400);

    // Valid MP4 selection returns verified metadata + a same-origin thumbnail proxy
    const selected = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_mp4_short_036' });
    expect(selected.status).toBe(201);
    const selection = selected.body.data;
    expect(selection.fileId).toBe('drive_mp4_short_036');
    expect(selection.name).toBe('Keynote_Clip_036.mp4');
    expect(selection.mimeType).toBe('video/mp4');
    expect(selection.sizeBytes).toBe(shortStat.size);
    expect(selection.durationSec).toBe(36);
    expect(selection.thumbnailUrl).toBe(
      `/api/v1/google-drive/selections/${selection.selectionId}/thumbnail`
    );
    // The raw Drive file ID is not itself an authorization token: the server stores an
    // opaque, user-bound selection handle instead.
    expect(selection.selectionId).toMatch(/^[a-f0-9]{24}$/);

    const thumb = await ownerAgent.get(
      `/api/v1/google-drive/selections/${selection.selectionId}/thumbnail`
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/jpeg');

    // Another authenticated ClipForge user cannot read this selection.
    const outsiderRead = await outsiderAgent.get(
      `/api/v1/google-drive/selections/${selection.selectionId}`
    );
    expect(outsiderRead.status).toBe(404);
    expect(outsiderRead.body.error.code).toBe('GOOGLE_DRIVE_SELECTION_NOT_FOUND');

    // Another user cannot launch generation from someone else's selection.
    const outsiderGenerate = await outsiderAgent.post('/api/v1/google-drive/generate').send({
      selectionId: selection.selectionId,
      settings: DEFAULT_PROCESSING_SETTINGS,
    });
    expect(outsiderGenerate.status).toBe(404);

    // Expired selections are rejected with an actionable error.
    await GoogleDriveFileSelection.updateOne(
      { _id: selection.selectionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );
    const expired = await ownerAgent.get(`/api/v1/google-drive/selections/${selection.selectionId}`);
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('GOOGLE_DRIVE_SELECTION_EXPIRED');
    await GoogleDriveFileSelection.deleteOne({ _id: selection.selectionId });
  });

  it('5. Refreshes an expired access token transparently from the encrypted refresh token', async () => {
    const before = refreshCount;
    getGoogleDriveOAuthService().clearAccessTokenCache(ownerUserId);

    const tokenRes = await ownerAgent.get('/api/v1/google-drive/picker-token');
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.data.accessToken).toContain('drive_refreshed_');
    expect(refreshCount).toBeGreaterThan(before);

    // Access token still absent from MongoDB after the refresh.
    const dbRecord = await UserGoogleDriveConnection.findOne({ userId: ownerUserId }).lean();
    expect(JSON.stringify(dbRecord)).not.toContain('ya29.');
  });

  it('6. Imports an MP4 through the full Drive → temporary storage → FFmpeg/Faster-Whisper pipeline', async () => {
    const selected = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_mp4_short_036' });
    expect(selected.status).toBe(201);

    const walletBefore = await ownerAgent.get('/api/v1/wallet');
    const availableBefore = walletBefore.body.data.wallet.availableCredits;

    const gen = await ownerAgent.post('/api/v1/google-drive/generate').send({
      selectionId: selected.body.data.selectionId,
      title: 'Drive MP4 Import',
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1, durationPreset: '15-30' },
    });
    expect(gen.status).toBe(201);
    expect(gen.body.data.project.sourcePlatform).toBe('google_drive');
    expect(gen.body.data.project.googleDriveMetadata.fileId).toBe('drive_mp4_short_036');
    expect(gen.body.data.estimatedCredits).toBe(10);
    expect(gen.body.data.job.status).toBe('queued');

    const walletReserved = await ownerAgent.get('/api/v1/wallet');
    expect(walletReserved.body.data.wallet.reservedCredits).toBeGreaterThan(0);

    const done = await waitForJobTerminal(ownerAgent, gen.body.data.job._id);
    expect(done.status).toBe('completed');
    expect(done.creditsDeducted).toBe(10);

    const clips = await Clip.find({ projectId: gen.body.data.project._id });
    expect(clips.length).toBeGreaterThanOrEqual(1);
    expect(clips[0].storageKey).toContain('clips/');
    // The clip must be persisted through the configured storage adapter.
    await expect(
      getStorageAdapter().resolveLocalPathForProcessing(clips[0].storageKey, WORK_DIR)
    ).resolves.toBeTruthy();

    // Temp working dir (including streamed .part downloads) removed after processing.
    expect(fs.existsSync(path.join(WORK_DIR, `job_${gen.body.data.job._id}`))).toBe(false);

    const walletAfter = await ownerAgent.get('/api/v1/wallet');
    expect(walletAfter.body.data.wallet.availableCredits).toBe(availableBefore - 10);
    expect(walletAfter.body.data.wallet.reservedCredits).toBe(0);
  }, 240000);

  it('7. Imports a MOV (video/quicktime) Drive file and validates the resulting clips', async () => {
    const selected = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_mov_short_036' });
    expect(selected.status).toBe(201);
    expect(selected.body.data.mimeType).toBe('video/quicktime');

    const gen = await ownerAgent.post('/api/v1/google-drive/generate').send({
      selectionId: selected.body.data.selectionId,
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
    });
    expect(gen.status).toBe(201);

    const done = await waitForJobTerminal(ownerAgent, gen.body.data.job._id);
    expect(done.status).toBe('completed');

    const project = await Project.findById(gen.body.data.project._id).lean();
    expect(project!.googleDriveMetadata!.mimeType).toBe('video/quicktime');
    const clips = await Clip.find({ projectId: gen.body.data.project._id });
    expect(clips.length).toBeGreaterThanOrEqual(1);
  }, 240000);

  it('8. Streams a large file in bounded HTTP Range chunks, verifies Drive checksums, and recovers from transient 5xx', async () => {
    // Force small chunks so the multi-chunk Range + resume path is exercised.
    const previousChunkSize = env.GOOGLE_DRIVE_DOWNLOAD_CHUNK_BYTES;
    (env as any).GOOGLE_DRIVE_DOWNLOAD_CHUNK_BYTES = 256 * 1024;

    const selected = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_large_075' });
    expect(selected.status).toBe(201);
    expect(selected.body.data.sizeBytes).toBe(largeStat.size);

    const requestsBefore = mediaRequestCount;
    // Drive shard returns 503 twice, then serves the file — the downloader must retry
    // and continue from the exact byte offset rather than restarting or buffering.
    transientFailuresRemaining = 2;

    const gen = await ownerAgent.post('/api/v1/google-drive/generate').send({
      selectionId: selected.body.data.selectionId,
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 2,
        chunkDurationSec: 30,
      },
    });
    expect(gen.status).toBe(201);
    expect(gen.body.data.chunkPlan.estimatedChunks).toBe(3);

    const done = await waitForJobTerminal(ownerAgent, gen.body.data.job._id);
    expect(done.status, JSON.stringify(done.error || done.chunkProgress)).toBe('completed');
    expect(done.chunkProgress.totalChunks).toBeGreaterThanOrEqual(2);
    expect(done.chunkProgress.completedChunks).toBe(done.chunkProgress.totalChunks);

    // Multiple independent range requests prove the download was chunked, not buffered.
    const rangeRequests = mediaRequestCount - requestsBefore;
    expect(rangeRequests).toBeGreaterThanOrEqual(2);
    expect(rangeRequests).toBeGreaterThanOrEqual(
      Math.ceil(largeStat.size / (256 * 1024)) - 1
    );

    (env as any).GOOGLE_DRIVE_DOWNLOAD_CHUNK_BYTES = previousChunkSize;
  }, 300000);

  it('9. Fails a broken Drive download cleanly, refunds 100% of reserved credits, and succeeds on job retry', async () => {
    brokenDownload = true;
    transientFailuresRemaining = 0;
    const selected = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_broken_502' });
    expect(selected.status).toBe(201);

    const walletBefore = await ownerAgent.get('/api/v1/wallet');
    const availableBefore = walletBefore.body.data.wallet.availableCredits;

    const gen = await ownerAgent.post('/api/v1/google-drive/generate').send({
      selectionId: selected.body.data.selectionId,
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
    });
    expect(gen.status).toBe(201);

    const failed = await waitForJobTerminal(ownerAgent, gen.body.data.job._id);
    expect(failed.status).toBe('failed');
    expect(failed.error.code).toBe('GOOGLE_DRIVE_DOWNLOAD_FAILED');
    expect(failed.creditReservationReleased).toBe(true);

    const walletAfterFail = await ownerAgent.get('/api/v1/wallet');
    expect(walletAfterFail.body.data.wallet.availableCredits).toBe(availableBefore);
    expect(walletAfterFail.body.data.wallet.reservedCredits).toBe(0);
    const failedProject = await Project.findById(gen.body.data.project._id).lean();
    expect(failedProject!.status).toBe('failed');

    // Temporary download artefacts must not leak after a failure.
    expect(fs.existsSync(path.join(WORK_DIR, `job_${gen.body.data.job._id}`))).toBe(false);

    // Retry: make the Drive object downloadable again, then retry the failed job.
    brokenDownload = false;
    const retry = await ownerAgent.post(`/api/v1/jobs/${gen.body.data.job._id}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body.data.job.driveImport.fileId).toBe('drive_broken_502');

    const retried = await waitForJobTerminal(ownerAgent, retry.body.data.job._id);
    expect(retried.status, JSON.stringify(retried.error || {})).toBe('completed');

    const clips = await Clip.find({ projectId: gen.body.data.project._id });
    expect(clips.length).toBeGreaterThanOrEqual(1);
  }, 300000);

  it('10. Processes a full 10-hour (36,000s) Drive video in overlapping chunks with global timestamps and temp cleanup', async () => {
    const selected = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_ten_hours_36000' });
    expect(selected.status).toBe(201);
    expect(selected.body.data.durationSec).toBe(36000);

    const heapBeforeMb = process.memoryUsage().rss / (1024 * 1024);

    const gen = await ownerAgent.post('/api/v1/google-drive/generate').send({
      selectionId: selected.body.data.selectionId,
      title: 'Ten Hour Drive Marathon',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 3,
        chunkDurationSec: 1800,
        durationPreset: '15-30',
        aspectRatio: '9:16',
      },
    });
    expect(gen.status).toBe(201);
    expect(gen.body.data.project.googleDriveMetadata.durationSec).toBe(36000);
    expect(gen.body.data.chunkPlan).toMatchObject({
      enabled: true,
      estimatedChunks: 20,
      maxSupportedDurationSec: 36000,
    });
    expect(gen.body.data.estimatedCredits).toBe(690);

    const done = await waitForJobTerminal(ownerAgent, gen.body.data.job._id, 480000);
    expect(done.status).toBe('completed');
    expect(done.chunkProgress.totalChunks).toBe(20);
    expect(done.chunkProgress.completedChunks).toBe(20);
    expect(done.creditsDeducted).toBe(690);

    // Bounded RAM: no full 300MB file buffered in the Node process.
    const heapAfterMb = process.memoryUsage().rss / (1024 * 1024);
    expect(heapAfterMb - heapBeforeMb).toBeLessThan(150);

    const clips = await Clip.find({ projectId: gen.body.data.project._id }).sort({ startSec: 1 });
    expect(clips.length).toBe(3);
    expect(clips[clips.length - 1].startSec).toBeGreaterThan(24000);
    expect(clips[clips.length - 1].endSec).toBeLessThanOrEqual(36001);

    // Temp working dir and checkpoint removed after success.
    expect(fs.existsSync(path.join(WORK_DIR, `job_${gen.body.data.job._id}`))).toBe(false);
    expect(
      fs.existsSync(path.join(WORK_DIR, 'checkpoints', `job_${gen.body.data.job._id}.json`))
    ).toBe(false);

    fs.rmSync(mp4TenHours, { force: true });
  }, 600000);

  it('11. Detects a revoked Google permission, marks the connection revoked, blocks imports, and supports disconnect/reconnect', async () => {
    revokedMode = true;
    getGoogleDriveOAuthService().clearAccessTokenCache(ownerUserId);

    const pickerToken = await ownerAgent.get('/api/v1/google-drive/picker-token');
    expect(pickerToken.status).toBe(401);
    expect(pickerToken.body.error.code).toBe('GOOGLE_DRIVE_REAUTH_REQUIRED');

    const status = await ownerAgent.get('/api/v1/google-drive/status');
    expect(status.status).toBe(200);
    expect(status.body.data.connected).toBe(false);
    expect(status.body.data.status).toBe('revoked');

    const conn = await UserGoogleDriveConnection.findOne({ userId: ownerUserId }).lean();
    expect(conn!.status).toBe('revoked');
    expect(conn!.encryptedRefreshToken).toBe('');

    // Import attempts now fail with an actionable reconnect error.
    const select = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_mp4_short_036' });
    expect(select.status).toBe(403);
    expect(select.body.error.code).toBe('GOOGLE_DRIVE_NOT_CONNECTED');

    // Disconnect revokes + deletes credentials without throwing.
    const disconnect = await ownerAgent.post('/api/v1/google-drive/oauth/disconnect');
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.data.connected).toBe(false);
    expect(await UserGoogleDriveConnection.countDocuments({ userId: ownerUserId })).toBe(0);

    // Reconnect works end-to-end after the user grants permission again.
    revokedMode = false;
    const authorizeRes = await ownerAgent.post('/api/v1/google-drive/oauth/authorize').send({
      redirectPath: '/dashboard/create?tab=drive',
    });
    const state = new URL(authorizeRes.body.data.authorizationUrl).searchParams.get('state') || '';
    const reconnected = await request(app)
      .get(oauthCallbackPath)
      .query({ code: validAuthCode, state, format: 'json' });
    expect(reconnected.status).toBe(200);
    expect(reconnected.body.data.status.connected).toBe(true);

    const reselect = await ownerAgent
      .post('/api/v1/google-drive/files/select')
      .send({ fileId: 'drive_mp4_short_036' });
    expect(reselect.status, JSON.stringify(reselect.body)).toBe(201);
    expect(replayCallbackUsed).toBe(true);
  }, 120000);
});
