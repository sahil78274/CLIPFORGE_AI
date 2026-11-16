import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';

// Configure isolated environment before importing server modules
const TEST_ROOT = path.resolve(__dirname, '../../temp/yt_long_suite');
const EXPORT_DIR = path.join(TEST_ROOT, 'owner_exports');
const STORAGE_DIR = path.join(TEST_ROOT, 'storage');
const WORK_DIR = path.join(TEST_ROOT, 'work');
const MONGO_EJSON = path.resolve(
  __dirname,
  '../../.data/embedded-mongo/clipforge_yt_long_test.ejson'
);

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27101/clipforge_yt_long_test?directConnection=true';
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
import {
  Clip,
  CreditTransaction,
  CreditWallet,
  ProcessingJob,
  Project,
  ensureSystemBootstrap,
} from '../models';
import {
  initializeQueueSystem,
  recoverOrphanedJobsOnStartup,
} from '../queues/videoQueue';
import {
  getJobCheckpointPath,
  scheduleNextWorkerInterruptForTesting,
} from '../workers/videoWorker';
import {
  parseAndValidateYouTubeUrl,
  parseIso8601DurationToSeconds,
} from '../services/youtubeImportService';
import {
  setCustomYouTubeMediaAdapterForTesting,
  type YouTubeMediaSourceAdapter,
} from '../services/youtubeMediaSourceAdapter';
import { probeMediaFile } from '../services/mediaProbeService';
import { getStorageAdapter } from '../services/storageService';
import { AppError } from '../utils/errors';

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
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`Timed out waiting for job ${jobId} after ${timeoutMs}ms`);
}

describe('ClipForge AI — YouTube URL-to-Clips & 1h / 5h / 10h Chunked Processing Suite', () => {
  const app = createApp();
  const fixtureScript = path.resolve(
    __dirname,
    '../../../scripts/generate-long-video-fixture.py'
  );
  const unitCacheMp4 = path.join(TEST_ROOT, 'unit_60s_cache.mp4');

  let mockOembedServer: http.Server;
  let userAgent: ReturnType<typeof request.agent>;
  let userId = '';

  const buildAuthorizedExportFixture = (
    videoId: string,
    durationSec: number,
    meta: { title: string; channelName: string; privacyStatus?: string }
  ) => {
    const mp4Path = path.join(EXPORT_DIR, `${videoId}.mp4`);
    const metaPath = path.join(EXPORT_DIR, `${videoId}.meta.json`);
    execFileSync(env.PYTHON_BIN, [
      fixtureScript,
      '--output',
      mp4Path,
      '--ffmpeg',
      env.FFMPEG_PATH,
      '--duration',
      String(durationSec),
      '--unit-cache',
      unitCacheMp4,
    ]);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        title: meta.title,
        channelName: meta.channelName,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        privacyStatus: meta.privacyStatus || 'public',
      }),
      'utf8'
    );
    return mp4Path;
  };

  beforeAll(async () => {
    fs.rmSync(MONGO_EJSON, { force: true });
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.mkdirSync(WORK_DIR, { recursive: true });

    // Local oEmbed mock endpoint to deterministically verify private, 404 unavailable,
    // and metadata-only (no media stream) YouTube URLs without external internet dependency.
    mockOembedServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const target = u.searchParams.get('url') || '';
      if (target.includes('PrivVid0001')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Private or restricted video' }));
        return;
      }
      if (target.includes('DeadVid0002')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      const match = target.match(/v=([A-Za-z0-9_-]{11})/);
      const vid = match ? match[1] : 'Unknown0000';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          title: `Public oEmbed Metadata Only (${vid})`,
          author_name: 'ClipForge Verified Channel',
          thumbnail_url: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        })
      );
    });

    await new Promise<void>((resolve) => {
      mockOembedServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = mockOembedServer.address() as { port: number };
    (env as any).YOUTUBE_OEMBED_ENDPOINT = `http://127.0.0.1:${addr.port}/oembed`;
    (env as any).YOUTUBE_AUTHORIZED_EXPORTS_DIR = EXPORT_DIR;
    (env as any).LOCAL_STORAGE_DIR = STORAGE_DIR;
    (env as any).TEMP_WORKING_DIR = WORK_DIR;
    (env as any).MAX_VIDEO_DURATION_SEC = 36000;
    (env as any).VIDEO_CHUNK_DURATION_SEC = 600;
    (env as any).VIDEO_CHUNK_OVERLAP_SEC = 5;

    await connectDatabase(process.env.MONGODB_URI);
    await ensureSystemBootstrap();
    await initializeQueueSystem();

    userAgent = request.agent(app);
    const reg = await userAgent.post('/api/v1/auth/register').send({
      name: 'Rohan Sharma',
      email: 'rohan.youtube@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(reg.status).toBe(201);
    userId = reg.body.data.user.id;

    // Seed generous credit balance (5,000 credits) so we can run short + 1h + 5h + 10h + recovery jobs
    await CreditWallet.findOneAndUpdate(
      { userId },
      { $set: { availableCredits: 5000, reservedCredits: 0 } }
    );
  }, 120000);

  afterAll(async () => {
    setCustomYouTubeMediaAdapterForTesting(null);
    await new Promise<void>((resolve) => mockOembedServer.close(() => resolve()));
    await disconnectDatabase();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(MONGO_EJSON, { force: true });
  });

  it('1. Validates all YouTube URL formats, ISO-8601 durations, invalid URLs, and SSRF protections', async () => {
    expect(
      parseAndValidateYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s').videoId
    ).toBe('dQw4w9WgXcQ');
    expect(parseAndValidateYouTubeUrl('https://youtu.be/aqz-KE-bpKQ?si=test').videoId).toBe(
      'aqz-KE-bpKQ'
    );
    expect(
      parseAndValidateYouTubeUrl('https://www.youtube.com/shorts/9bZkp7q19f0').videoId
    ).toBe('9bZkp7q19f0');
    expect(parseAndValidateYouTubeUrl('https://www.youtube.com/live/jfKfPfyJRdk').videoId).toBe(
      'jfKfPfyJRdk'
    );
    expect(parseAndValidateYouTubeUrl('https://www.youtube.com/embed/M7lc1UVf-VE').videoId).toBe(
      'M7lc1UVf-VE'
    );

    expect(parseIso8601DurationToSeconds('PT45S')).toBe(45);
    expect(parseIso8601DurationToSeconds('PT1H0M0S')).toBe(3600);
    expect(parseIso8601DurationToSeconds('PT5H0M0S')).toBe(18000);
    expect(parseIso8601DurationToSeconds('PT10H0M0S')).toBe(36000);

    // Invalid non-YouTube domain
    const vimeoRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://vimeo.com/123456789' });
    expect(vimeoRes.status).toBe(400);
    expect(vimeoRes.body.error.code).toBe('INVALID_YOUTUBE_URL');

    // Missing 11-char video ID (channel URL)
    const channelRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/@ClipForgeCreator' });
    expect(channelRes.status).toBe(400);
    expect(channelRes.body.error.code).toBe('MISSING_YOUTUBE_VIDEO_ID');

    // Malformed ID length
    const badIdRes = await userAgent
      .post('/api/v1/youtube/generate')
      .send({ url: 'https://www.youtube.com/watch?v=short', settings: DEFAULT_PROCESSING_SETTINGS });
    expect(badIdRes.status).toBe(400);

    // Loopback / internal SSRF host blocked
    const ssrfRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'http://127.0.0.1/watch?v=dQw4w9WgXcQ' });
    expect(ssrfRes.status).toBe(403);
    expect(ssrfRes.body.error.code).toBe('SSRF_BLOCKED');
  });

  it('2. Rejects private & unavailable YouTube videos and never fakes clip generation from oEmbed metadata alone', async () => {
    // Private video via oEmbed 403
    const privRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=PrivVid0001' });
    expect(privRes.status).toBe(403);
    expect(privRes.body.error.code).toBe('YOUTUBE_VIDEO_PRIVATE');

    // Private video via sidecar metadata
    fs.writeFileSync(
      path.join(EXPORT_DIR, 'PrivSidecar.meta.json'),
      JSON.stringify({ privacyStatus: 'private', title: 'Hidden Episode' })
    );
    const privSideRes = await userAgent
      .post('/api/v1/youtube/generate')
      .send({
        url: 'https://www.youtube.com/watch?v=PrivSidecar',
        settings: DEFAULT_PROCESSING_SETTINGS,
      });
    expect(privSideRes.status).toBe(403);
    expect(privSideRes.body.error.code).toBe('YOUTUBE_VIDEO_PRIVATE');

    // Unavailable / deleted video via oEmbed 404
    const unavailRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=DeadVid0002' });
    expect(unavailRes.status).toBe(404);
    expect(unavailRes.body.error.code).toBe('YOUTUBE_VIDEO_UNAVAILABLE');

    // Public video with valid oEmbed metadata ONLY (no authorized media stream available)
    const walletBefore = await CreditWallet.findOne({ userId });
    const fetchOnly = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=NoMedia0003' });
    expect(fetchOnly.status).toBe(200);
    expect(fetchOnly.body.data.video.videoId).toBe('NoMedia0003');
    expect(fetchOnly.body.data.video.title).toContain('NoMedia0003');
    expect(fetchOnly.body.data.mediaAccess.available).toBe(false);

    // Attempting to generate clips without actual media access MUST fail cleanly with 422/503 and zero credit charge
    const genBlocked = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=NoMedia0003',
      settings: DEFAULT_PROCESSING_SETTINGS,
    });
    expect([422, 503]).toContain(genBlocked.status);
    expect([
      'YOUTUBE_MEDIA_ACCESS_FAILED',
      'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED',
    ]).toContain(genBlocked.body.error.code);

    const walletAfter = await CreditWallet.findOne({ userId });
    expect(walletAfter!.availableCredits).toBe(walletBefore!.availableCredits);
    expect(walletAfter!.reservedCredits).toBe(0);
  });

  it('3. Refunds 100% of reserved credits when Stage 1a media stream download fails mid-job', async () => {
    const walletBefore = await CreditWallet.findOne({ userId });
    const startAvail = walletBefore!.availableCredits;

    const failingAdapter: YouTubeMediaSourceAdapter = {
      name: 'simulated_failing_provider',
      isConfigured: () => true,
      getSetupInstructions: () => 'Test adapter',
      checkAvailability: async () => ({
        available: true,
        configured: true,
        adapterName: 'simulated_failing_provider',
        probedDurationSec: 120,
      }),
      acquireMedia: async () => {
        throw new AppError(
          'Authorized upstream media stream disconnected (HTTP 502) while downloading.',
          502,
          'YOUTUBE_MEDIA_ACCESS_FAILED'
        );
      },
    };

    setCustomYouTubeMediaAdapterForTesting(failingAdapter);
    try {
      const genRes = await userAgent.post('/api/v1/youtube/generate').send({
        url: 'https://www.youtube.com/watch?v=FailMedia04',
        settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 2 },
      });
      expect(genRes.status).toBe(201);
      const jobId = genRes.body.data.job._id;

      const finalJob = await waitForJobTerminal(userAgent, jobId, 30000);
      expect(finalJob.status).toBe('failed');
      expect(finalJob.error.code).toBe('YOUTUBE_MEDIA_ACCESS_FAILED');
      expect(finalJob.creditReservationReleased).toBe(true);
      expect(finalJob.creditsDeducted).toBe(0);

      const walletAfter = await CreditWallet.findOne({ userId });
      expect(walletAfter!.availableCredits).toBe(startAvail);
      expect(walletAfter!.reservedCredits).toBe(0);

      const releaseTx = await CreditTransaction.findOne({
        userId,
        referenceId: String(jobId),
        type: 'release_reserve',
      });
      expect(releaseTx).toBeTruthy();
    } finally {
      setCustomYouTubeMediaAdapterForTesting(null);
    }
  });

  it('4. Processes a Short YouTube Video (36s) end-to-end: fetch, subtitles, AI metadata, project clips, MP4 download, and credit deduction', async () => {
    buildAuthorizedExportFixture('VidShort036', 36, {
      title: 'Short Startup Retention Playbook',
      channelName: 'ClipForge Founders',
    });

    const walletBefore = await CreditWallet.findOne({ userId });
    const startCredits = walletBefore!.availableCredits;

    const fetchRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://youtu.be/VidShort036' });
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.data.video.videoId).toBe('VidShort036');
    expect(fetchRes.body.data.video.title).toBe('Short Startup Retention Playbook');
    expect(fetchRes.body.data.video.channelName).toBe('ClipForge Founders');
    expect(Math.round(fetchRes.body.data.video.durationSec)).toBe(36);
    expect(fetchRes.body.data.mediaAccess.available).toBe(true);
    expect(fetchRes.body.data.chunkPlan.enabled).toBe(false);
    expect(fetchRes.body.data.estimatedCredits).toBe(10);

    const genRes = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://youtu.be/VidShort036',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 2,
        durationPreset: '15-30',
        aspectRatio: '9:16',
      },
    });
    expect(genRes.status).toBe(201);
    const projectId = genRes.body.data.project._id;
    const jobId = genRes.body.data.job._id;

    const doneJob = await waitForJobTerminal(userAgent, jobId, 60000);
    expect(doneJob.status).toBe('completed');
    expect(doneJob.creditsDeducted).toBe(10);

    const projRes = await userAgent.get(`/api/v1/projects/${projectId}`);
    expect(projRes.status).toBe(200);
    expect(projRes.body.data.project.sourcePlatform).toBe('youtube');
    expect(projRes.body.data.project.youtubeMetadata.videoId).toBe('VidShort036');
    const clips = projRes.body.data.clips;
    expect(clips.length).toBe(2);

    for (const clip of clips) {
      expect(clip.title.length).toBeGreaterThan(3);
      expect(clip.metadata.descriptions.youtubeShorts.length).toBeGreaterThan(5);
      expect(clip.aspectRatio).toBe('9:16');
      expect(clip.durationSec).toBeGreaterThanOrEqual(5);
      expect(clip.endSec).toBeLessThanOrEqual(37);
    }

    // Verify actual signed MP4 download works
    const dlUrlPath = new URL(clips[0].downloadUrl, 'http://localhost').pathname +
      new URL(clips[0].downloadUrl, 'http://localhost').search;
    const dlRes = await userAgent.get(dlUrlPath);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-type']).toContain('video/mp4');
    expect(Buffer.byteLength(dlRes.body)).toBeGreaterThan(5000);

    const walletAfter = await CreditWallet.findOne({ userId });
    expect(walletAfter!.availableCredits).toBe(startCredits - 10);
    expect(walletAfter!.reservedCredits).toBe(0);
  }, 90000);

  it('5. Processes a 1-Hour YouTube Video (3,600s) across 6 chunks with boundary deduplication and accurate global timestamps', async () => {
    buildAuthorizedExportFixture('Vid01Hour00', 3600, {
      title: '1-Hour Deep Dive Engineering Podcast',
      channelName: 'Systems Scale FM',
    });

    const walletBefore = await CreditWallet.findOne({ userId });
    const startCredits = walletBefore!.availableCredits;

    const fetchRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=Vid01Hour00' });
    expect(fetchRes.status).toBe(200);
    expect(Math.round(fetchRes.body.data.video.durationSec)).toBe(3600);
    expect(fetchRes.body.data.chunkPlan.enabled).toBe(true);
    expect(fetchRes.body.data.chunkPlan.estimatedChunks).toBe(6);
    expect(fetchRes.body.data.estimatedCredits).toBe(150);

    const genRes = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=Vid01Hour00',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 3,
        chunkDurationSec: 600,
        durationPreset: '15-30',
        aspectRatio: '9:16',
      },
    });
    expect(genRes.status).toBe(201);
    const doneJob = await waitForJobTerminal(userAgent, genRes.body.data.job._id, 120000);
    expect(doneJob.status).toBe('completed');
    expect(doneJob.chunkProgress.totalChunks).toBe(6);
    expect(doneJob.chunkProgress.completedChunks).toBe(6);
    expect(doneJob.creditsDeducted).toBe(150);

    const clips = await Clip.find({ projectId: genRes.body.data.project._id }).sort({
      startSec: 1,
    });
    expect(clips.length).toBe(3);

    // Ensure zero overlapping/duplicate clips across chunk boundaries and global timestamps into late chapters
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i].startSec).toBeGreaterThanOrEqual(clips[i - 1].endSec);
    }
    expect(clips[clips.length - 1].startSec).toBeGreaterThan(2000);

    // Verify rendered file via FFprobe
    const localClipPath = await getStorageAdapter().resolveLocalPathForProcessing(
      clips[clips.length - 1].storageKey,
      WORK_DIR
    );
    const probe = await probeMediaFile(localClipPath);
    expect(probe.codec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
    expect(probe.width).toBeGreaterThanOrEqual(720);
    expect(probe.height / probe.width).toBeCloseTo(16 / 9, 2);

    const walletAfter = await CreditWallet.findOne({ userId });
    expect(walletAfter!.availableCredits).toBe(startCredits - 150);
    expect(walletAfter!.reservedCredits).toBe(0);
  }, 150000);

  it('6. Processes a 5-Hour YouTube Video (18,000s) using bounded-RAM chunked streaming and global multi-hour timestamps', async () => {
    buildAuthorizedExportFixture('Vid05Hour00', 18000, {
      title: '5-Hour Product & AI Architecture Summit',
      channelName: 'ClipForge Live Keynotes',
    });

    const walletBefore = await CreditWallet.findOne({ userId });
    const startCredits = walletBefore!.availableCredits;

    const genRes = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=Vid05Hour00',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 3,
        chunkDurationSec: 1800,
        durationPreset: '15-30',
        aspectRatio: '9:16',
      },
    });
    expect(genRes.status).toBe(201);

    const doneJob = await waitForJobTerminal(userAgent, genRes.body.data.job._id, 180000);
    expect(doneJob.status).toBe('completed');
    expect(doneJob.chunkProgress.totalChunks).toBe(10);
    expect(doneJob.chunkProgress.completedChunks).toBe(10);
    expect(doneJob.creditsDeducted).toBe(390);

    const clips = await Clip.find({ projectId: genRes.body.data.project._id }).sort({
      startSec: 1,
    });
    expect(clips.length).toBe(3);
    // Late-chapter clip must have accurate global timestamp well past Hour 3 (> 10,800s)
    expect(clips[clips.length - 1].startSec).toBeGreaterThan(10800);
    expect(clips[clips.length - 1].endSec).toBeLessThanOrEqual(18001);

    const walletAfter = await CreditWallet.findOne({ userId });
    expect(walletAfter!.availableCredits).toBe(startCredits - 390);
  }, 180000);

  it('7. Processes a Full 10-Hour YouTube Video (36,000s) with bounded RAM & temp cleanup, and rejects >10h videos', async () => {
    buildAuthorizedExportFixture('Vid10Hour00', 36000, {
      title: '10-Hour Complete Engineering Marathon',
      channelName: 'Marathon Tech Talks',
    });

    const heapBeforeMb = process.memoryUsage().rss / (1024 * 1024);

    const fetchRes = await userAgent
      .post('/api/v1/youtube/fetch')
      .send({ url: 'https://www.youtube.com/watch?v=Vid10Hour00' });
    expect(fetchRes.status).toBe(200);
    expect(Math.round(fetchRes.body.data.video.durationSec)).toBe(36000);
    expect(fetchRes.body.data.estimatedCredits).toBe(690);

    const genRes = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=Vid10Hour00',
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 3,
        chunkDurationSec: 1800,
        durationPreset: '15-30',
        aspectRatio: '9:16',
      },
    });
    expect(genRes.status).toBe(201);
    const jobId = genRes.body.data.job._id;

    const doneJob = await waitForJobTerminal(userAgent, jobId, 240000);
    expect(doneJob.status).toBe('completed');
    expect(doneJob.chunkProgress.totalChunks).toBe(20);
    expect(doneJob.chunkProgress.completedChunks).toBe(20);
    expect(doneJob.creditsDeducted).toBe(690);

    const heapAfterMb = process.memoryUsage().rss / (1024 * 1024);
    // Node worker RSS growth must stay tiny (< 120 MB delta), proving zero full-file RAM buffering
    expect(heapAfterMb - heapBeforeMb).toBeLessThan(120);

    // Temp job working directory and checkpoint file must be cleaned up after completion
    expect(fs.existsSync(path.join(WORK_DIR, `job_${jobId}`))).toBe(false);
    expect(fs.existsSync(getJobCheckpointPath(jobId))).toBe(false);

    const clips = await Clip.find({ projectId: genRes.body.data.project._id }).sort({
      startSec: 1,
    });
    expect(clips.length).toBe(3);
    // Verify global timestamp reaches deep into the final third of the 10-hour timeline (> 24,000s)
    expect(clips[clips.length - 1].startSec).toBeGreaterThan(24000);
    expect(clips[clips.length - 1].endSec).toBeLessThanOrEqual(36001);

    // Free the 308 MB 10h source export fixture immediately after assertion
    fs.rmSync(path.join(EXPORT_DIR, 'Vid10Hour00.mp4'), { force: true });

    // Verify videos exceeding 10 hours (e.g. 10h 15m = 36,900s) are rejected cleanly
    const overLimitAdapter: YouTubeMediaSourceAdapter = {
      name: 'over_limit_probe_adapter',
      isConfigured: () => true,
      getSetupInstructions: () => 'Test over-limit adapter',
      checkAvailability: async () => ({
        available: true,
        configured: true,
        adapterName: 'over_limit_probe_adapter',
        probedDurationSec: 36900,
      }),
      acquireMedia: async () => {
        throw new Error('Should be blocked prior to download');
      },
    };
    setCustomYouTubeMediaAdapterForTesting(overLimitAdapter);
    try {
      const overRes = await userAgent.post('/api/v1/youtube/generate').send({
        url: 'https://www.youtube.com/watch?v=Over10Hours',
        settings: DEFAULT_PROCESSING_SETTINGS,
      });
      expect(overRes.status).toBe(400);
      expect(overRes.body.error.code).toBe('VIDEO_DURATION_LIMIT_EXCEEDED');
    } finally {
      setCustomYouTubeMediaAdapterForTesting(null);
    }
  }, 240000);

  it('8. Recovers interrupted multi-chunk processing automatically & across server restart without duplicating chunks or double-charging credits', async () => {
    // Reuse Vid01Hour00 (3,600s = 6 chunks of 600s)
    const walletBefore = await CreditWallet.findOne({ userId });
    const startCredits = walletBefore!.availableCredits;

    // Arm deterministic interruption BEFORE starting so attempt #1 is guaranteed to interrupt right after chunk 3/6 persists its checkpoint
    scheduleNextWorkerInterruptForTesting(3);

    const genRes = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=Vid01Hour00',
      title: 'Interrupted & Recovered 1h Podcast',
      autoStart: true,
      settings: {
        ...DEFAULT_PROCESSING_SETTINGS,
        clipCount: 2,
        chunkDurationSec: 600,
      },
    });
    expect(genRes.status).toBe(201);
    const jobId = genRes.body.data.job._id;

    const recoveredJob = await waitForJobTerminal(userAgent, jobId, 150000);
    expect(recoveredJob.status).toBe('completed');
    expect(recoveredJob.attempts).toBe(2);
    expect(recoveredJob.chunkProgress.completedChunks).toBe(6);
    expect(recoveredJob.creditsDeducted).toBe(150);

    const historyMessages = recoveredJob.stageHistory.map((h: any) => h.message).join(' | ');
    expect(historyMessages).toContain('Auto-resuming from checkpoint after interruption');

    // Also test startup crash recovery (`recoverOrphanedJobsOnStartup`) when a job was left in `processing` state
    const crashCreate = await userAgent.post('/api/v1/youtube/generate').send({
      url: 'https://www.youtube.com/watch?v=VidShort036',
      title: 'Server Restart Orphan Recovery Test',
      autoStart: false,
      settings: { ...DEFAULT_PROCESSING_SETTINGS, clipCount: 2 },
    });
    expect(crashCreate.status).toBe(201);
    const orphanProjId = crashCreate.body.data.project._id;

    const startOrphan = await userAgent
      .post(`/api/v1/jobs/project/${orphanProjId}/start`)
      .send({});
    expect(startOrphan.status).toBe(202);
    const orphanJobId = startOrphan.body.data.job._id;

    const doneOrphan = await waitForJobTerminal(userAgent, orphanJobId, 60000);
    expect(doneOrphan.status).toBe('completed');

    // Now simulate an interrupted job persisted as 'processing' in DB before restart
    const stuckJob = await ProcessingJob.create({
      userId,
      projectId: orphanProjId,
      videoId: doneOrphan.videoId,
      type: 'full_pipeline',
      status: 'processing',
      stage: 'transcribing',
      progressPercent: 45,
      currentMessage: 'Transcribing before sudden power loss',
      attempts: 1,
      maxAttempts: 3,
      creditsReserved: 0,
      queueMode: 'local_worker',
    });

    await recoverOrphanedJobsOnStartup();
    const resumedAfterRestart = await waitForJobTerminal(
      userAgent,
      String(stuckJob._id),
      60000
    );
    expect(resumedAfterRestart.status).toBe('completed');
    expect(resumedAfterRestart.attempts).toBe(2);

    // Verify exact net wallet balance across both jobs (150 + 10 = 160 credits, zero double charges)
    const walletAfter = await CreditWallet.findOne({ userId });
    expect(walletAfter!.availableCredits).toBe(startCredits - 160);
    expect(walletAfter!.reservedCredits).toBe(0);
  }, 210000);
});
