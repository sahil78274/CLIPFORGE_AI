import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';

const TEST_ROOT = path.resolve(__dirname, '../../temp/media_acq_suite');
const EXPORT_DIR = path.join(TEST_ROOT, 'owner_exports');
const STORAGE_DIR = path.join(TEST_ROOT, 'storage');
const WORK_DIR = path.join(TEST_ROOT, 'work');
const FIXTURES_DIR = path.join(TEST_ROOT, 'fixtures');
const MONGO_EJSON = path.resolve(
  __dirname,
  '../../.data/embedded-mongo/clipforge_media_acq_test.ejson'
);

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI =
  'mongodb://127.0.0.1:27109/clipforge_media_acq_test?directConnection=true';
process.env.ENABLE_EMBEDDED_MONGO_FALLBACK = 'true';
process.env.YOUTUBE_MEDIA_ADAPTER = 'composite';
process.env.YOUTUBE_AUTHORIZED_EXPORTS_DIR = EXPORT_DIR;
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;
process.env.TEMP_WORKING_DIR = WORK_DIR;
process.env.MAX_VIDEO_DURATION_SEC = '36000';
process.env.VIDEO_CHUNK_DURATION_SEC = '600';
process.env.VIDEO_CHUNK_OVERLAP_SEC = '5';

import { createApp } from '../app';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import { expireInMemoryAccessTokenForTesting } from '../services/mediaAcquisition/GoogleOAuthProvider';
import {
  Clip,
  CreditTransaction,
  CreditWallet,
  UserGoogleIntegration,
  ensureSystemBootstrap,
} from '../models';
import { initializeQueueSystem } from '../queues/videoQueue';
import {
  clearAllowedTestMediaOrigins,
  decryptOAuthToken,
  encryptOAuthToken,
  matchDriveFileToYouTubeVideo,
  registerAllowedTestMediaOrigin,
} from '../services/mediaAcquisition';

async function waitForJobTerminal(
  agent: ReturnType<typeof request.agent>,
  jobId: string,
  timeoutMs = 180000
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

describe('ClipForge AI — Modular Media Acquisition (Metadata, Google OAuth, Google Drive, Direct Authorized URLs, Chunking & Credit Refunds)', () => {
  const app = createApp();
  const fixtureScript = path.resolve(
    __dirname,
    '../../../scripts/generate-long-video-fixture.py'
  );
  const unitCacheMp4 = path.join(TEST_ROOT, 'unit_60s_cache.mp4');

  let mockGoogleServer: http.Server;
  let mockGoogleBaseUrl = '';
  let mockCdnServer: http.Server;
  let mockCdnBaseUrl = '';

  let ownerAgent: ReturnType<typeof request.agent>;
  let ownerUserId = '';
  let outsiderAgent: ReturnType<typeof request.agent>;

  let sampleMp4Short = '';
  let sampleMp4Chunked = '';
  let tokenRefreshCount = 0;

  beforeAll(async () => {
    fs.rmSync(MONGO_EJSON, { force: true });
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });

    // Generate real H.264 + AAC video fixtures (36s short + 75s multi-chunk fixture)
    sampleMp4Short = path.join(FIXTURES_DIR, 'creator_short_36s.mp4');
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output',
      sampleMp4Short,
      '--ffmpeg',
      env.FFMPEG_PATH,
      '--duration',
      '36',
      '--unit-cache',
      unitCacheMp4,
    ]);

    sampleMp4Chunked = path.join(FIXTURES_DIR, 'creator_long_75s.mp4');
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output',
      sampleMp4Chunked,
      '--ffmpeg',
      env.FFMPEG_PATH,
      '--duration',
      '75',
      '--unit-cache',
      unitCacheMp4,
    ]);

    const shortStat = fs.statSync(sampleMp4Short);
    const chunkedStat = fs.statSync(sampleMp4Chunked);

    // Mock Google OAuth2 + YouTube Data API v3 + YouTube oEmbed + Google Drive v3 server
    mockGoogleServer = http.createServer(async (req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const authHeader = String(req.headers.authorization || '');

      // 1. OAuth2 Token Exchange & Refresh
      if (req.method === 'POST' && u.pathname === '/oauth2/token') {
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(ch as Buffer);
        const bodyParams = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const grantType = bodyParams.get('grant_type');

        if (grantType === 'authorization_code') {
          const code = bodyParams.get('code');
          if (code !== 'valid_google_auth_code') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'ya29.initial_owner_access_token',
              refresh_token: '1//0g_owner_refresh_token',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: [
                'openid',
                'email',
                'profile',
                'https://www.googleapis.com/auth/youtube.readonly',
                'https://www.googleapis.com/auth/drive.readonly',
              ].join(' '),
            })
          );
          return;
        }

        if (grantType === 'refresh_token') {
          if (bodyParams.get('refresh_token') !== '1//0g_owner_refresh_token') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          tokenRefreshCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: `ya29.refreshed_owner_token_${tokenRefreshCount}`,
              expires_in: 3600,
              token_type: 'Bearer',
            })
          );
          return;
        }
      }

      // 2. OAuth2 Revoke
      if (req.method === 'POST' && u.pathname === '/oauth2/revoke') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ revoked: true }));
        return;
      }

      // 3. Google UserInfo
      if (req.method === 'GET' && u.pathname === '/oauth2/userinfo') {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'google-uid-991122',
            email: 'creator@clipforge-studio.test',
            name: 'Aarav Creator',
            picture: 'https://lh3.googleusercontent.com/a/default-user',
          })
        );
        return;
      }

      // 4. YouTube Data API v3: channels?mine=true
      if (req.method === 'GET' && u.pathname === '/youtube/v3/channels') {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                id: 'UC_OWNER_CHANNEL_01',
                snippet: {
                  title: 'Aarav Tech Studio',
                  customUrl: '@aaravtech',
                  thumbnails: { default: { url: 'https://i.ytimg.com/ch/owner.jpg' } },
                },
              },
            ],
          })
        );
        return;
      }

      // 5. YouTube Data API v3: videos
      if (req.method === 'GET' && u.pathname === '/youtube/v3/videos') {
        const vid = u.searchParams.get('id') || '';
        const isOAuthOwner = authHeader.startsWith('Bearer ya29.');

        if (vid === 'OwnPriv0001') {
          if (!isOAuthOwner) {
            // Public API key cannot see another channel's private video or sees privacyStatus=private
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                items: [
                  {
                    id: 'OwnPriv0001',
                    snippet: {
                      title: 'Private Creator Cut',
                      channelId: 'UC_OWNER_CHANNEL_01',
                      channelTitle: 'Aarav Tech Studio',
                      liveBroadcastContent: 'none',
                    },
                    contentDetails: { duration: 'PT36S' },
                    status: { privacyStatus: 'private' },
                  },
                ],
              })
            );
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              items: [
                {
                  id: 'OwnPriv0001',
                  snippet: {
                    title: 'Private Creator Cut',
                    channelId: 'UC_OWNER_CHANNEL_01',
                    channelTitle: 'Aarav Tech Studio',
                    liveBroadcastContent: 'none',
                  },
                  contentDetails: { duration: 'PT36S' },
                  status: { privacyStatus: 'private' },
                },
              ],
            })
          );
          return;
        }

        if (vid === 'DrvMatch001') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              items: [
                {
                  id: 'DrvMatch001',
                  snippet: {
                    title: 'Scaling Distributed Video Pipelines',
                    channelId: 'UC_OWNER_CHANNEL_01',
                    channelTitle: 'Aarav Tech Studio',
                    liveBroadcastContent: 'none',
                  },
                  contentDetails: { duration: 'PT36S' },
                  status: { privacyStatus: 'public' },
                },
              ],
            })
          );
          return;
        }

        if (vid === 'LongChnk075') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              items: [
                {
                  id: 'LongChnk075',
                  snippet: {
                    title: 'Deep Dive Systems Podcast Episode',
                    channelId: 'UC_OWNER_CHANNEL_01',
                    channelTitle: 'Aarav Tech Studio',
                    liveBroadcastContent: 'none',
                  },
                  contentDetails: { duration: 'PT1M15S' },
                  status: { privacyStatus: 'public' },
                },
              ],
            })
          );
          return;
        }

        if (vid === 'DirectUrl01' || vid === 'FailMid0001' || vid === 'NoSource001') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              items: [
                {
                  id: vid,
                  snippet: {
                    title: `Episode Metadata (${vid})`,
                    channelId: 'UC_OTHER_CHANNEL_99',
                    channelTitle: 'External Podcast',
                    liveBroadcastContent: 'none',
                  },
                  contentDetails: { duration: 'PT36S' },
                  status: { privacyStatus: 'public' },
                },
              ],
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
        return;
      }

      // 6. YouTube oEmbed fallback
      if (req.method === 'GET' && u.pathname === '/oembed') {
        const target = u.searchParams.get('url') || '';
        const m = target.match(/v=([A-Za-z0-9_-]{11})/);
        const vid = m ? m[1] : 'Unknown0000';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            title: `oEmbed Title (${vid})`,
            author_name: 'Public Creator',
            thumbnail_url: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          })
        );
        return;
      }

      // 7. Google Drive v3 API: list & inspect & alt=media download
      if (req.method === 'GET' && u.pathname === '/drive/v3/files') {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const q = u.searchParams.get('q') || '';
        const allDriveFiles = [
          {
            id: 'drive_exact_match_001',
            name: 'Scaling_Distributed_Video_Pipelines_DrvMatch001.mp4',
            mimeType: 'video/mp4',
            size: String(shortStat.size),
            modifiedTime: '2026-11-15T10:00:00.000Z',
            videoMediaMetadata: {
              width: 1280,
              height: 720,
              durationMillis: '36000',
            },
          },
          {
            id: 'drive_long_chunked_075',
            name: 'Deep_Dive_Systems_Podcast_Episode_Master.mp4',
            mimeType: 'video/mp4',
            size: String(chunkedStat.size),
            modifiedTime: '2026-11-16T08:00:00.000Z',
            videoMediaMetadata: {
              width: 1280,
              height: 720,
              durationMillis: '75000',
            },
          },
          {
            id: 'drive_broken_upstream_502',
            name: 'Broken_Upstream_Export_FailMid0001.mp4',
            mimeType: 'video/mp4',
            size: String(shortStat.size),
            modifiedTime: '2026-11-14T08:00:00.000Z',
            videoMediaMetadata: {
              width: 1280,
              height: 720,
              durationMillis: '36000',
            },
          },
        ];

        const nameFilterMatch = q.match(/name contains '([^']+)'/);
        const filtered = nameFilterMatch
          ? allDriveFiles.filter((f) =>
              f.name.toLowerCase().includes(nameFilterMatch[1].toLowerCase())
            )
          : allDriveFiles;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: filtered }));
        return;
      }

      if (req.method === 'GET' && u.pathname.startsWith('/drive/v3/files/')) {
        if (!authHeader.startsWith('Bearer ya29.')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const fileId = decodeURIComponent(u.pathname.replace('/drive/v3/files/', ''));
        const isMediaDownload = u.searchParams.get('alt') === 'media';

        if (fileId === 'drive_doc_not_video') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'drive_doc_not_video',
              name: 'Show_Notes.pdf',
              mimeType: 'application/pdf',
              size: '4096',
            })
          );
          return;
        }

        if (fileId === 'drive_broken_upstream_502') {
          if (!isMediaDownload) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'drive_broken_upstream_502',
                name: 'Broken_Upstream_Export_FailMid0001.mp4',
                mimeType: 'video/mp4',
                size: String(shortStat.size),
                videoMediaMetadata: { width: 1280, height: 720, durationMillis: '36000' },
              })
            );
            return;
          }
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream Drive storage shard unavailable' }));
          return;
        }

        const isChunkedFile = fileId === 'drive_long_chunked_075';
        if (fileId === 'drive_exact_match_001' || isChunkedFile) {
          const backingPath = isChunkedFile ? sampleMp4Chunked : sampleMp4Short;
          const backingStat = isChunkedFile ? chunkedStat : shortStat;
          if (!isMediaDownload) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: fileId,
                name: isChunkedFile
                  ? 'Deep_Dive_Systems_Podcast_Episode_Master.mp4'
                  : 'Scaling_Distributed_Video_Pipelines_DrvMatch001.mp4',
                mimeType: 'video/mp4',
                size: String(backingStat.size),
                videoMediaMetadata: {
                  width: 1280,
                  height: 720,
                  durationMillis: isChunkedFile ? '75000' : '36000',
                },
              })
            );
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(backingStat.size),
          });
          fs.createReadStream(backingPath).pipe(res);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unhandled mock Google route', path: u.pathname }));
    });

    await new Promise<void>((resolve) => {
      mockGoogleServer.listen(0, '127.0.0.1', () => resolve());
    });
    const googleAddr = mockGoogleServer.address() as { port: number };
    mockGoogleBaseUrl = `http://127.0.0.1:${googleAddr.port}`;

    // Mock Presigned S3/R2/CDN Direct Authorized Media Server
    mockCdnServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');

      // Presigned GET-only video stream (returns 403 on HEAD just like S3 presigned GET URLs!)
      if (u.pathname === '/signed/episode_direct.mp4') {
        if (u.searchParams.get('sig') !== 'valid_presigned_sig') {
          res.writeHead(403, { 'Content-Type': 'application/xml' });
          res.end('<Error><Code>AccessDenied</Code></Error>');
          return;
        }
        if (req.method === 'HEAD') {
          res.writeHead(403, { 'Content-Type': 'application/xml' });
          res.end();
          return;
        }
        const stat = fs.statSync(sampleMp4Short);
        if (req.headers.range === 'bytes=0-1023') {
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Length': '1024',
            'Content-Range': `bytes 0-1023/${stat.size}`,
          });
          fs.createReadStream(sampleMp4Short, { start: 0, end: 1023 }).pipe(res);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(stat.size),
        });
        fs.createReadStream(sampleMp4Short).pipe(res);
        return;
      }

      // HTML page pretending to be a link -> MUST be rejected as non-video
      if (u.pathname === '/not-a-video.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Not a video stream</body></html>');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      mockCdnServer.listen(0, '127.0.0.1', () => resolve());
    });
    const cdnAddr = mockCdnServer.address() as { port: number };
    mockCdnBaseUrl = `http://127.0.0.1:${cdnAddr.port}`;
    registerAllowedTestMediaOrigin(mockCdnBaseUrl);

    // Point server env to mock Google endpoints + configure API key
    (env as any).YOUTUBE_DATA_API_KEY = 'AIzaSyTestPlatformKey123456';
    (env as any).YOUTUBE_API_BASE_URL = `${mockGoogleBaseUrl}/youtube/v3`;
    (env as any).YOUTUBE_OEMBED_ENDPOINT = `${mockGoogleBaseUrl}/oembed`;
    (env as any).GOOGLE_OAUTH_AUTH_URL = `${mockGoogleBaseUrl}/oauth2/auth`;
    (env as any).GOOGLE_OAUTH_TOKEN_URL = `${mockGoogleBaseUrl}/oauth2/token`;
    (env as any).GOOGLE_OAUTH_USERINFO_URL = `${mockGoogleBaseUrl}/oauth2/userinfo`;
    (env as any).GOOGLE_OAUTH_REVOKE_URL = `${mockGoogleBaseUrl}/oauth2/revoke`;
    (env as any).GOOGLE_DRIVE_API_BASE_URL = `${mockGoogleBaseUrl}/drive/v3`;
    (env as any).YOUTUBE_AUTHORIZED_EXPORTS_DIR = EXPORT_DIR;
    (env as any).LOCAL_STORAGE_DIR = STORAGE_DIR;
    (env as any).TEMP_WORKING_DIR = WORK_DIR;

    await connectDatabase(process.env.MONGODB_URI);
    await ensureSystemBootstrap();
    await initializeQueueSystem();

    ownerAgent = request.agent(app);
    const regOwner = await ownerAgent.post('/api/v1/auth/register').send({
      name: 'Aarav Creator',
      email: 'aarav.owner@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(regOwner.status).toBe(201);
    ownerUserId = regOwner.body.data.user.id;

    await CreditWallet.findOneAndUpdate(
      { userId: ownerUserId },
      { $set: { availableCredits: 2000, reservedCredits: 0 } }
    );

    outsiderAgent = request.agent(app);
    const regOutsider = await outsiderAgent.post('/api/v1/auth/register').send({
      name: 'Neha Viewer',
      email: 'neha.viewer@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(regOutsider.status).toBe(201);
  }, 120000);

  afterAll(async () => {
    clearAllowedTestMediaOrigins();
    await new Promise<void>((resolve) => mockGoogleServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockCdnServer.close(() => resolve()));
    await disconnectDatabase();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(MONGO_EJSON, { force: true });
  });

  it('1. Keeps metadata discovery strictly separate from media downloading and reports clear actionable errors when media is inaccessible', async () => {
    // Before Google OAuth is configured, status honestly reports oauthConfigured: false
    (env as any).GOOGLE_CLIENT_ID = '';
    (env as any).GOOGLE_CLIENT_SECRET = '';

    const statusUnconf = await ownerAgent.get('/api/v1/youtube/oauth/google/status');
    expect(statusUnconf.status).toBe(200);
    expect(statusUnconf.body.data.oauthConfigured).toBe(false);
    expect(statusUnconf.body.data.connected).toBe(false);

    const authUnconf = await ownerAgent.post('/api/v1/youtube/oauth/google/authorize').send({});
    expect(authUnconf.status).toBe(503);
    expect(authUnconf.body.error.code).toBe('GOOGLE_OAUTH_NOT_CONFIGURED');

    // Public video metadata is recognized via YouTube Data API v3, but mediaAccess.available is false
    const fetchRes = await outsiderAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=NoSource001' });
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.data.video.videoId).toBe('NoSource001');
    expect(fetchRes.body.data.video.metadataSource).toBe('youtube_data_api');
    expect(fetchRes.body.data.mediaAccess.available).toBe(false);
    expect(fetchRes.body.data.mediaAccess.resolutionOptions.length).toBeGreaterThanOrEqual(3);

    // Non-owner cannot inspect private video metadata
    const privBlocked = await outsiderAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=OwnPriv0001' });
    expect(privBlocked.status).toBe(403);
    expect(privBlocked.body.error.code).toBe('YOUTUBE_VIDEO_PRIVATE');

    // Attempting to generate clips when only metadata is available fails cleanly with 0 credits charged
    const outsiderWalletBefore = await outsiderAgent.get('/api/v1/wallet');
    const genBlocked = await outsiderAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=NoSource001',
      settings: DEFAULT_PROCESSING_SETTINGS,
    });
    expect([422, 503]).toContain(genBlocked.status);
    const outsiderWalletAfter = await outsiderAgent.get('/api/v1/wallet');
    expect(outsiderWalletAfter.body.data.wallet.availableCredits).toBe(
      outsiderWalletBefore.body.data.wallet.availableCredits
    );
    expect(outsiderWalletAfter.body.data.wallet.reservedCredits).toBe(0);
  });

  it('2. Authenticates via Google OAuth 2.0, encrypts tokens at rest, refreshes expired tokens, and verifies channel ownership', async () => {
    (env as any).GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
    (env as any).GOOGLE_CLIENT_SECRET = 'GOCSPX-test-google-client-secret';

    // AES-256-GCM encryption round-trip check
    const cipher = encryptOAuthToken('secret-token-value');
    expect(cipher).not.toContain('secret-token-value');
    expect(decryptOAuthToken(cipher)).toBe('secret-token-value');

    // Request authorization URL
    const authRes = await ownerAgent.post('/api/v1/youtube/oauth/google/authorize').send({
      redirectPath: '/dashboard/create?tab=youtube',
    });
    expect(authRes.status).toBe(200);
    expect(authRes.body.data.authorizationUrl).toContain('client_id=test-google-client-id');
    const signedState = authRes.body.data.state;

    // Tampered state is rejected
    const tamperedCb = await ownerAgent
      .get('/api/v1/youtube/oauth/google/callback')
      .query({ code: 'valid_google_auth_code', state: `${signedState}tamper`, format: 'json' });
    expect(tamperedCb.status).toBe(400);
    expect(tamperedCb.body.error.code).toBe('GOOGLE_OAUTH_INVALID_STATE');

    // Valid OAuth callback exchanges code, syncs YouTube channels, and stores encrypted tokens
    const cbRes = await ownerAgent
      .get('/api/v1/youtube/oauth/google/callback')
      .query({ code: 'valid_google_auth_code', state: signedState, format: 'json' });
    expect(cbRes.status).toBe(200);
    expect(cbRes.body.data.status.connected).toBe(true);
    expect(cbRes.body.data.status.email).toBe('creator@clipforge-studio.test');
    expect(cbRes.body.data.status.hasYouTubeScope).toBe(true);
    expect(cbRes.body.data.status.hasDriveScope).toBe(true);
    expect(cbRes.body.data.status.channels[0].channelId).toBe('UC_OWNER_CHANNEL_01');

    // Verify refresh token in MongoDB is AES-256-GCM encrypted and access token is NOT stored permanently
    const dbRecord = await UserGoogleIntegration.findOne({ userId: ownerUserId }).lean();
    expect(dbRecord).toBeTruthy();
    expect((dbRecord as any).encryptedAccessToken).toBeUndefined();
    expect(dbRecord!.encryptedRefreshToken.startsWith('v1:')).toBe(true);
    expect(dbRecord!.encryptedRefreshToken).not.toContain('1//');

    // Force in-memory access token expiration to prove transparent refresh_token rotation works
    expireInMemoryAccessTokenForTesting(ownerUserId);

    // Verified channel owner CAN inspect their own private YouTube video!
    const ownerPrivFetch = await ownerAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=OwnPriv0001' });
    expect(ownerPrivFetch.status).toBe(200);
    expect(ownerPrivFetch.body.data.video.channelOwnershipVerified).toBe(true);
    expect(ownerPrivFetch.body.data.video.metadataSource).toBe('youtube_oauth_api');
    expect(tokenRefreshCount).toBeGreaterThanOrEqual(1);
  });

  it('3. Lists Google Drive videos, matches YouTube videoId & title/duration, and runs full FFmpeg + Faster-Whisper clip generation', async () => {
    // Unit-verify matching heuristics (exact ID, high title+duration, duration mismatch warning)
    const exactMatch = matchDriveFileToYouTubeVideo(
      {
        id: 'f1',
        name: 'Scaling_Distributed_Video_Pipelines_DrvMatch001.mp4',
        durationSec: 36,
      },
      { videoId: 'DrvMatch001', title: 'Scaling Distributed Video Pipelines', durationSec: 36 }
    );
    expect(exactMatch.confidence).toBe('exact');
    expect(exactMatch.matchedByVideoId).toBe(true);

    const mismatchWarning = matchDriveFileToYouTubeVideo(
      {
        id: 'f2',
        name: 'Scaling_Distributed_Video_Pipelines_DrvMatch001.mp4',
        durationSec: 180,
      },
      { videoId: 'DrvMatch001', title: 'Scaling Distributed Video Pipelines', durationSec: 36 }
    );
    expect(mismatchWarning.confidence).toBe('exact');
    expect(mismatchWarning.warning).toContain('differs from YouTube video duration');

    // List Google Drive files via API with YouTube URL context
    const listRes = await ownerAgent
      .get('/api/v1/youtube/drive/files')
      .query({ youtubeUrl: 'https://www.youtube.com/watch?v=DrvMatch001' });
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.files.length).toBe(3);
    expect(listRes.body.data.files[0].id).toBe('drive_exact_match_001');
    expect(listRes.body.data.files[0].match.confidence).toBe('exact');
    expect(listRes.body.data.autoMatchedFile.id).toBe('drive_exact_match_001');

    // Reject selecting a non-video Google Drive file (PDF)
    const badDriveItem = await ownerAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DrvMatch001',
      googleDriveFileId: 'drive_doc_not_video',
    });
    expect(badDriveItem.status).toBe(400);
    expect(badDriveItem.body.error.code).toBe('GOOGLE_DRIVE_NOT_VIDEO');

    // Fetch YouTube URL without specifying googleDriveFileId -> auto-matches exact videoId in Drive!
    const autoFetch = await ownerAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DrvMatch001',
    });
    expect(autoFetch.status).toBe(200);
    expect(autoFetch.body.data.mediaAccess.available).toBe(true);
    expect(autoFetch.body.data.mediaAccess.adapterName).toBe('google_drive');
    expect(autoFetch.body.data.mediaAccess.matchedDriveFile.id).toBe('drive_exact_match_001');

    // Run full end-to-end clip generation from Google Drive source -> FFmpeg -> Faster-Whisper -> rendered MP4 clips!
    const walletBefore = (await ownerAgent.get('/api/v1/wallet')).body.data.wallet;
    const genRes = await ownerAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=DrvMatch001',
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 2 },
    });
    expect(genRes.status).toBe(201);
    const jobId = genRes.body.data.job._id;
    const projectId = genRes.body.data.project._id;

    const terminalJob = await waitForJobTerminal(ownerAgent, jobId);
    expect(terminalJob.status).toBe('completed');
    expect(terminalJob.creditsDeducted).toBeGreaterThan(0);

    const clips = await Clip.find({ projectId }).lean();
    expect(clips.length).toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.fileSizeBytes).toBeGreaterThan(1000);
    }

    const walletAfter = (await ownerAgent.get('/api/v1/wallet')).body.data.wallet;
    expect(walletAfter.reservedCredits).toBe(0);
    expect(walletAfter.availableCredits).toBe(
      walletBefore.availableCredits - terminalJob.creditsDeducted
    );
  }, 180000);

  it('4. Validates Direct Authorized Media URLs (SSRF, HTML/watch-page rejection, presigned GET-only streams) and generates clips', async () => {
    // Reject YouTube watch webpage URL passed as authorizedMediaUrl
    const watchAsDirect = await outsiderAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DirectUrl01',
      authorizedMediaUrl: 'https://www.youtube.com/watch?v=DirectUrl01',
    });
    expect(watchAsDirect.status).toBe(400);
    expect(watchAsDirect.body.error.code).toBe('YOUTUBE_WATCH_URL_NOT_DIRECT_MEDIA');

    // Block unapproved loopback / metadata SSRF URLs
    const ssrfDirect = await outsiderAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DirectUrl01',
      authorizedMediaUrl: 'http://169.254.169.254/latest/meta-data/video.mp4',
    });
    expect(ssrfDirect.status).toBe(403);
    expect(ssrfDirect.body.error.code).toBe('SSRF_BLOCKED');

    // Reject HTML responses masquerading as media URLs
    const htmlDirect = await outsiderAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DirectUrl01',
      authorizedMediaUrl: `${mockCdnBaseUrl}/not-a-video.html`,
    });
    expect(htmlDirect.status).toBe(400);
    expect(htmlDirect.body.error.code).toBe('YOUTUBE_MEDIA_NOT_VIDEO');

    // Reject expired/invalid presigned signature
    const expiredDirect = await outsiderAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DirectUrl01',
      authorizedMediaUrl: `${mockCdnBaseUrl}/signed/episode_direct.mp4?sig=expired`,
    });
    expect(expiredDirect.status).toBe(400);
    expect(expiredDirect.body.error.code).toBe('AUTHORIZED_MEDIA_URL_FORBIDDEN');

    // Accept valid presigned GET-only stream (where HEAD returns 403 and Range GET succeeds) & render clips!
    const validSignedUrl = `${mockCdnBaseUrl}/signed/episode_direct.mp4?sig=valid_presigned_sig`;
    const fetchDirect = await outsiderAgent.post('/api/v1/youtube/fetch').send({
      url: 'https://www.youtube.com/watch?v=DirectUrl01',
      authorizedMediaUrl: validSignedUrl,
    });
    expect(fetchDirect.status).toBe(200);
    expect(fetchDirect.body.data.mediaAccess.available).toBe(true);
    expect(fetchDirect.body.data.mediaAccess.adapterName).toBe('direct_authorized_url');

    const genDirect = await outsiderAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=DirectUrl01',
      authorizedMediaUrl: validSignedUrl,
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 },
    });
    expect(genDirect.status).toBe(201);

    const terminalJob = await waitForJobTerminal(outsiderAgent, genDirect.body.data.job._id);
    expect(terminalJob.status).toBe('completed');
    const renderedClips = await Clip.find({ projectId: genDirect.body.data.project._id }).lean();
    expect(renderedClips.length).toBe(1);
  }, 180000);

  it('5. Preserves multi-chunk long-video processing through Google Drive media acquisition', async () => {
    const genChunked = await ownerAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=LongChnk075',
      googleDriveFileId: 'drive_long_chunked_075',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 2,
        chunkDurationSec: 25,
      },
    });
    expect(genChunked.status).toBe(201);

    const terminalJob = await waitForJobTerminal(ownerAgent, genChunked.body.data.job._id);
    expect(terminalJob.status).toBe('completed');
    expect(terminalJob.chunkProgress.enabled).toBe(true);
    expect(terminalJob.chunkProgress.totalChunks).toBeGreaterThanOrEqual(2);
    expect(terminalJob.chunkProgress.completedChunks).toBe(
      terminalJob.chunkProgress.totalChunks
    );

    const clips = await Clip.find({ projectId: genChunked.body.data.project._id }).lean();
    expect(clips.length).toBeGreaterThanOrEqual(1);
  }, 180000);

  it('6. Automatically refunds 100% of reserved credits on failed media imports and preserves Direct File Upload workflow', async () => {
    const walletBefore = (await ownerAgent.get('/api/v1/wallet')).body.data.wallet;

    // Trigger job whose Google Drive file download fails mid-import with HTTP 502
    const genFail = await ownerAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=FailMid0001',
      googleDriveFileId: 'drive_broken_upstream_502',
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 2 },
    });
    expect(genFail.status).toBe(201);
    const failedJobId = genFail.body.data.job._id;

    const failedJob = await waitForJobTerminal(ownerAgent, failedJobId);
    expect(failedJob.status).toBe('failed');
    expect(failedJob.creditReservationReleased).toBe(true);
    expect(failedJob.error.code).toBe('GOOGLE_DRIVE_DOWNLOAD_FAILED');

    const walletAfterFail = (await ownerAgent.get('/api/v1/wallet')).body.data.wallet;
    expect(walletAfterFail.reservedCredits).toBe(0);
    expect(walletAfterFail.availableCredits).toBe(walletBefore.availableCredits);

    const refundTx = await CreditTransaction.findOne({
      referenceId: failedJobId,
      type: 'release_reserve',
    }).lean();
    expect(refundTx).toBeTruthy();

    // Verify Direct File Upload workflow remains 100% intact
    const uploadRes = await ownerAgent
      .post('/api/v1/videos/upload')
      .field('title', 'Direct Local Upload Regression Check')
      .field('settings', JSON.stringify({ ...DEFAULT_PROCESSING_SETTINGS, clipCount: 1 }))
      .field('autoStart', 'true')
      .attach('video', sampleMp4Short);
    expect(uploadRes.status).toBe(201);

    const uploadJob = await waitForJobTerminal(ownerAgent, uploadRes.body.data.job._id);
    expect(uploadJob.status).toBe('completed');

    // Disconnect Google OAuth cleanly
    const discRes = await ownerAgent.post('/api/v1/youtube/oauth/google/disconnect');
    expect(discRes.status).toBe(200);
    expect(discRes.body.data.connected).toBe(false);
  }, 180000);
});
