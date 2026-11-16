import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Configure isolated test environment before importing app modules
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27099/clipforge_e2e_test?directConnection=true';
process.env.ENABLE_EMBEDDED_MONGO_FALLBACK = 'true';
process.env.PAYMENT_SANDBOX_SIMULATOR = 'true';
process.env.PAYMENT_SANDBOX_SECRET = 'test-sandbox-hmac-secret-key-2026-clipforge';
process.env.LOCAL_STORAGE_DIR = path.resolve(__dirname, '../../temp/test_storage');
process.env.TEMP_WORKING_DIR = path.resolve(__dirname, '../../temp/test_work');

import { createApp } from '../app';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import {
  CreditTransaction,
  CreditWallet,
  ProcessingJob,
  Project,
  User,
  ensureSystemBootstrap,
} from '../models';
import { initializeQueueSystem } from '../queues/videoQueue';
import { failAndReleaseJob } from '../workers/videoWorker';
import { reserveCreditsForJob } from '../services/walletService';
import { probeMediaFile } from '../services/mediaProbeService';

describe('ClipForge AI — Full-Stack Integration, Media Pipeline, Wallet, Payment & Security Suite', () => {
  const app = createApp();
  const sampleMp4Path = path.resolve(__dirname, '../../temp/sample_podcast_e2e.mp4');

  let userAAgent: ReturnType<typeof request.agent>;
  let userBAgent: ReturnType<typeof request.agent>;
  let adminAgent: ReturnType<typeof request.agent>;

  let userAId = '';
  let createdProjectId = '';
  let renderedClipIds: string[] = [];
  let firstClipDownloadUrl = '';

  beforeAll(async () => {
    fs.rmSync(path.resolve(__dirname, '../../.data/embedded-mongo/clipforge_e2e_test.ejson'), {
      force: true,
    });
    fs.rmSync(env.LOCAL_STORAGE_DIR, { recursive: true, force: true });
    fs.rmSync(env.TEMP_WORKING_DIR, { recursive: true, force: true });

    await connectDatabase(process.env.MONGODB_URI);
    await ensureSystemBootstrap();
    await initializeQueueSystem();

    // Generate real multi-scene H.264 + AAC + subtitle MP4 sample video
    const genScript = path.resolve(__dirname, '../../../scripts/generate-sample-video.py');
    execFileSync(env.PYTHON_BIN, [
      genScript,
      '--output',
      sampleMp4Path,
      '--ffmpeg',
      env.FFMPEG_PATH,
    ]);
    expect(fs.existsSync(sampleMp4Path)).toBe(true);

    userAAgent = request.agent(app);
    userBAgent = request.agent(app);
    adminAgent = request.agent(app);
  }, 60000);

  afterAll(async () => {
    await disconnectDatabase();
    fs.rmSync(sampleMp4Path, { force: true });
    fs.rmSync(env.LOCAL_STORAGE_DIR, { recursive: true, force: true });
    fs.rmSync(env.TEMP_WORKING_DIR, { recursive: true, force: true });
    fs.rmSync(path.resolve(__dirname, '../../.data/embedded-mongo/clipforge_e2e_test.ejson'), {
      force: true,
    });
  });

  it('1. Enforces input validation, user registration, password hashing, welcome credits, and sign-in', async () => {
    // Invalid short password rejected
    const badReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Test',
      email: 'bad@example.com',
      password: '123',
    });
    expect(badReg.status).toBe(400);
    expect(badReg.body.error.code).toBe('VALIDATION_ERROR');

    // Valid registration for User A
    const regRes = await userAAgent.post('/api/v1/auth/register').send({
      name: 'Ananya Rao',
      email: 'ananya.e2e@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(regRes.status).toBe(201);
    expect(regRes.body.data.user.email).toBe('ananya.e2e@clipforge.local');
    expect((regRes.body.data.user as any).passwordHash).toBeUndefined();
    expect(regRes.body.data.wallet.availableCredits).toBe(60);
    userAId = regRes.body.data.user.id;

    // Duplicate registration blocked
    const dupRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Duplicate',
      email: 'ananya.e2e@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(dupRes.status).toBe(409);

    // Password reset flow
    const forgotRes = await request(app).post('/api/v1/auth/forgot-password').send({
      email: 'ananya.e2e@clipforge.local',
    });
    expect(forgotRes.status).toBe(200);
    expect(forgotRes.body.data.devResetToken).toBeTruthy();

    const resetRes = await request(app).post('/api/v1/auth/reset-password').send({
      token: forgotRes.body.data.devResetToken,
      password: 'UpdatedPassword!2026',
    });
    expect(resetRes.status).toBe(200);

    // Sign in with updated password
    const loginRes = await userAAgent.post('/api/v1/auth/login').send({
      email: 'ananya.e2e@clipforge.local',
      password: 'UpdatedPassword!2026',
    });
    expect(loginRes.status).toBe(200);

    // Protected /me check
    const meRes = await userAAgent.get('/api/v1/auth/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.id).toBe(userAId);
  });

  it('2. Enforces SSRF protection, platform restriction transparency, and rejects spoofed non-video uploads', async () => {
    // Unauthenticated access blocked
    const unauth = await request(app).get('/api/v1/projects');
    expect(unauth.status).toBe(401);

    // SSRF loopback & AWS/cloud metadata IPs blocked
    for (const unsafeUrl of [
      'http://127.0.0.1:4000/api/v1/health',
      'http://localhost:27017/video.mp4',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal.mp4',
    ]) {
      const ssrfRes = await userAAgent.post('/api/v1/videos/check-url').send({ url: unsafeUrl });
      expect(ssrfRes.status).toBe(403);
      expect(ssrfRes.body.error.code).toBe('SSRF_BLOCKED');
    }

    // Social URL returns honest restriction explanation + upload fallback
    const ytCheck = await userAAgent.post('/api/v1/videos/check-url').send({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(ytCheck.status).toBe(200);
    expect(ytCheck.body.data.platform).toBe('youtube');
    expect(ytCheck.body.data.importableDirectly).toBe(false);
    expect(ytCheck.body.data.requiresUploadFallback).toBe(true);

    // Disguised text file renamed to .mp4 rejected by FFprobe without credit loss
    const fakeMp4 = path.join(env.TEMP_WORKING_DIR, 'spoofed.mp4');
    fs.mkdirSync(path.dirname(fakeMp4), { recursive: true });
    fs.writeFileSync(fakeMp4, 'not a real video binary stream');

    const badUpload = await userAAgent
      .post('/api/v1/videos/upload')
      .field('title', 'Malicious Spoof')
      .attach('video', fakeMp4, { filename: 'spoofed.mp4', contentType: 'video/mp4' });
    expect(badUpload.status).toBe(400);
    expect(badUpload.body.error.code).toBe('INVALID_MEDIA_CONTAINER');

    const walletCheck = await userAAgent.get('/api/v1/wallet');
    expect(walletCheck.body.data.wallet.availableCredits).toBe(60);
  });

  it(
    '3. Uploads a real video, reserves credits, runs all 12 Python/OpenCV/FFmpeg pipeline stages, renders & validates 9:16 clips, settles credits, and downloads MP4 + Bulk ZIP',
    async () => {
      const uploadRes = await userAAgent
        .post('/api/v1/videos/upload')
        .field('title', 'Creator Retention Deep Dive')
        .field(
          'settings',
          JSON.stringify({
            durationPreset: 'custom',
            customMinDuration: 5,
            customMaxDuration: 12,
            clipCount: 2,
            aspectRatio: '9:16',
            language: 'en',
            editingIntensity: 'balanced',
            silenceRemovalEnabled: true,
            silenceThresholdDb: -38,
            silenceMinDurationSec: 0.5,
            audioNormalization: true,
            noiseReduction: true,
            zoomEffects: true,
            backgroundMusic: 'ambient_focus',
            watermarkEnabled: true,
            watermarkText: '@ClipForgeE2E',
            introText: 'KEY RETENTION INSIGHT',
            outroText: 'FOLLOW FOR MORE',
            captionStyle: {
              enabled: true,
              font: 'DejaVu Sans Bold',
              fontSize: 40,
              position: 'bottom',
              textColor: '#FFFFFF',
              highlightColor: '#38BDF8',
              backgroundColor: '#09090B',
              backgroundOpacity: 0.65,
              animation: 'word_pop',
            },
          })
        )
        .attach('video', sampleMp4Path, {
          filename: 'sample_podcast.mp4',
          contentType: 'video/mp4',
        });

      expect(uploadRes.status).toBe(201);
      createdProjectId = uploadRes.body.data.project._id;
      const jobId = uploadRes.body.data.job._id;
      expect(createdProjectId).toBeTruthy();
      expect(jobId).toBeTruthy();

      // Poll job until completed
      let finalJob: any = null;
      const deadline = Date.now() + 95000;
      while (Date.now() < deadline) {
        const jobRes = await userAAgent.get(`/api/v1/jobs/${jobId}`);
        expect(jobRes.status).toBe(200);
        finalJob = jobRes.body.data.job;
        if (finalJob.status === 'completed' || finalJob.status === 'failed') {
          break;
        }
        await new Promise((r) => setTimeout(r, 750));
      }

      expect(finalJob).toBeTruthy();
      expect(finalJob.status).toBe('completed');
      expect(finalJob.stage).toBe('completed');
      expect(finalJob.progressPercent).toBe(100);
      expect(finalJob.creditsDeducted).toBeGreaterThan(0);

      // Verify project detail & generated clips
      const projRes = await userAAgent.get(`/api/v1/projects/${createdProjectId}`);
      expect(projRes.status).toBe(200);
      expect(projRes.body.data.project.status).toBe('completed');
      const clips = projRes.body.data.clips;
      expect(clips.length).toBe(2);

      renderedClipIds = clips.map((c: any) => c._id);
      firstClipDownloadUrl = clips[0].downloadUrl;

      for (const clip of clips) {
        expect(clip.status).toBe('ready');
        expect(clip.aspectRatio).toBe('9:16');
        expect(clip.width).toBe(720);
        expect(clip.height).toBe(1280);
        expect(clip.fileSizeBytes).toBeGreaterThan(5000);
        expect(clip.metadata.titleOptions.length).toBe(3);
        expect(clip.metadata.descriptions.youtubeShorts).toBeTruthy();
        expect(clip.metadata.descriptions.instagramReels).toBeTruthy();
        expect(clip.metadata.descriptions.tiktok).toBeTruthy();
        expect(clip.metadata.descriptions.facebookReels).toBeTruthy();

        // Probe physical rendered MP4 on disk via FFprobe
        const diskPath = path.join(env.LOCAL_STORAGE_DIR, clip.storageKey);
        const probe = await probeMediaFile(diskPath);
        expect(probe.width).toBe(720);
        expect(probe.height).toBe(1280);
        expect(probe.hasAudio).toBe(true);
      }

      // Download rendered clip via signed URL & verify MP4 ftyp box signature
      const dlRes = await userAAgent.get(firstClipDownloadUrl).buffer(true);
      expect(dlRes.status).toBe(200);
      const binBuf = dlRes.body as Buffer;
      expect(binBuf.length).toBeGreaterThan(5000);
      expect(binBuf.subarray(4, 8).toString('ascii')).toBe('ftyp');

      // Tampered download token signature must be blocked
      const tamperedUrl = `${firstClipDownloadUrl}tampered`;
      const badDl = await userAAgent.get(tamperedUrl);
      expect(badDl.status).toBe(403);

      // Bulk ZIP download verification
      const bulkTokenRes = await userAAgent
        .post('/api/v1/clips/bulk-download-token')
        .send({ clipIds: renderedClipIds });
      expect(bulkTokenRes.status).toBe(200);

      const zipRes = await userAAgent
        .get(bulkTokenRes.body.data.downloadUrl)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(zipRes.status).toBe(200);
      const zipBuf = zipRes.body as Buffer;
      // PK\x03\x04 ZIP header
      expect(zipBuf[0]).toBe(0x50);
      expect(zipBuf[1]).toBe(0x4b);

      // Verify credit reservation settled cleanly
      const walletAfter = await userAAgent.get('/api/v1/wallet');
      expect(walletAfter.body.data.wallet.reservedCredits).toBe(0);
      expect(walletAfter.body.data.wallet.availableCredits).toBe(50);
      expect(walletAfter.body.data.wallet.lifetimeUsedCredits).toBe(10);
    },
    120000
  );

  it('4. Releases reserved credits automatically and idempotently when a processing job fails, and enforces ledger immutability', async () => {
    const dummyProj = await Project.create({
      userId: userAId,
      title: 'Simulated Failure Job',
      status: 'processing',
    });
    const failedJob = await ProcessingJob.create({
      userId: userAId,
      projectId: dummyProj._id,
      stage: 'rendering',
      status: 'processing',
      creditsReserved: 15,
    });

    await reserveCreditsForJob({
      userId: userAId,
      jobId: failedJob._id,
      amount: 15,
      description: 'Reserve 15 credits for failure test',
    });

    let w = await CreditWallet.findOne({ userId: userAId });
    expect(w?.availableCredits).toBe(35);
    expect(w?.reservedCredits).toBe(15);

    // Fail job -> must release 15 credits back to availableCredits
    await failAndReleaseJob(
      String(failedJob._id),
      'SIMULATED_FFMPEG_CRASH',
      'Simulated pipeline failure',
      'rendering'
    );
    // Calling a second time must be strictly idempotent (no double credit refund!)
    await failAndReleaseJob(
      String(failedJob._id),
      'SIMULATED_FFMPEG_CRASH',
      'Simulated pipeline failure duplicate call',
      'rendering'
    );

    w = await CreditWallet.findOne({ userId: userAId });
    expect(w?.availableCredits).toBe(50);
    expect(w?.reservedCredits).toBe(0);

    // Verify CreditTransaction immutability guard blocks mutation
    await expect(
      CreditTransaction.updateOne({}, { $set: { amount: 99999 } })
    ).rejects.toThrow(/immutable/i);
  });

  it('5. Validates Razorpay sandbox HMAC signatures and blocks duplicate webhook replays', async () => {
    const pkgsRes = await userAAgent.get('/api/v1/payments/packages');
    expect(pkgsRes.status).toBe(200);
    const starterPkg = pkgsRes.body.data.items[0];
    expect(starterPkg).toBeTruthy();

    // Create sandbox order
    const orderRes = await userAAgent.post('/api/v1/payments/create-order').send({
      packageId: starterPkg._id,
      useSandboxSimulator: true,
    });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.data.isDevelopmentMode).toBe(true);

    const { orderId, sandboxPaymentId, sandboxSignaturePreview } = orderRes.body.data;

    // Tampered signature must fail without granting credits
    const badVerify = await userAAgent.post('/api/v1/payments/verify').send({
      razorpayOrderId: orderId,
      razorpayPaymentId: sandboxPaymentId,
      razorpaySignature: '0000deadbeefinvalidhmacsignature0000',
    });
    expect(badVerify.status).toBe(400);
    expect(badVerify.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');

    const walletUnchanged = await userAAgent.get('/api/v1/wallet');
    expect(walletUnchanged.body.data.wallet.availableCredits).toBe(50);

    // Create fresh sandbox order and test signed webhook + replay protection
    const orderRes2 = await userAAgent.post('/api/v1/payments/create-order').send({
      packageId: starterPkg._id,
      useSandboxSimulator: true,
    });
    const orderId2 = orderRes2.body.data.orderId;

    const webhookPayload = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_webhook_test_001',
            order_id: orderId2,
            amount: starterPkg.amountPaise,
          },
        },
      },
    });

    const validWebhookSig = crypto
      .createHmac('sha256', process.env.PAYMENT_SANDBOX_SECRET!)
      .update(webhookPayload)
      .digest('hex');

    // First webhook delivery -> credits wallet
    const wh1 = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', validWebhookSig)
      .set('X-Razorpay-Event-Id', 'evt_unique_001')
      .send(webhookPayload);
    expect(wh1.status).toBe(200);
    expect(wh1.body.data.duplicate).toBe(false);

    const walletCredited = await userAAgent.get('/api/v1/wallet');
    expect(walletCredited.body.data.wallet.availableCredits).toBe(50 + starterPkg.credits);

    // Duplicate webhook replay with same event ID -> ignored idempotently!
    const wh2 = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', validWebhookSig)
      .set('X-Razorpay-Event-Id', 'evt_unique_001')
      .send(webhookPayload);
    expect(wh2.status).toBe(200);
    expect(wh2.body.data.duplicate).toBe(true);

    const walletAfterReplay = await userAAgent.get('/api/v1/wallet');
    expect(walletAfterReplay.body.data.wallet.availableCredits).toBe(50 + starterPkg.credits);

    // Verify sandbox payments are NOT counted as real live revenue in Admin metrics
    await adminAgent.post('/api/v1/auth/login').send({
      email: env.ADMIN_BOOTSTRAP_EMAIL,
      password: env.ADMIN_BOOTSTRAP_PASSWORD,
    });
    const adminOverview = await adminAgent.get('/api/v1/admin/overview');
    expect(adminOverview.status).toBe(200);
    expect(adminOverview.body.data.metrics.liveRevenuePaise).toBe(0);
    expect(adminOverview.body.data.metrics.sandboxVolumePaise).toBe(starterPkg.amountPaise);
  });

  it('6. Enforces strict cross-user tenant isolation and Admin RBAC authorization + audit logging', async () => {
    // Register User B
    const regB = await userBAgent.post('/api/v1/auth/register').send({
      name: 'Vikram Singh',
      email: 'vikram.e2e@clipforge.local',
      password: 'StrongPassword!2026',
    });
    expect(regB.status).toBe(201);

    // User B cannot view User A's project
    const crossProj = await userBAgent.get(`/api/v1/projects/${createdProjectId}`);
    expect(crossProj.status).toBe(403);

    // User B cannot rename or delete User A's clip
    const crossRename = await userBAgent
      .patch(`/api/v1/clips/${renderedClipIds[0]}`)
      .send({ title: 'Hijacked Title' });
    expect(crossRename.status).toBe(403);

    const crossDel = await userBAgent.delete(`/api/v1/clips/${renderedClipIds[0]}`);
    expect(crossDel.status).toBe(403);

    // Normal User B cannot access Admin endpoints
    const nonAdminAttempt = await userBAgent.get('/api/v1/admin/users');
    expect(nonAdminAttempt.status).toBe(403);
    expect(nonAdminAttempt.body.error.code).toBe('ADMIN_REQUIRED');

    // Admin can adjust User B credits and audit log is persisted
    const userBId = regB.body.data.user.id;
    const adjRes = await adminAgent
      .post(`/api/v1/admin/users/${userBId}/credits`)
      .send({ amount: 25, reason: 'QA verification grant' });
    expect(adjRes.status).toBe(200);
    expect(adjRes.body.data.wallet.availableCredits).toBe(85);

    const logsRes = await adminAgent.get('/api/v1/admin/audit-logs');
    expect(logsRes.status).toBe(200);
    expect(
      logsRes.body.data.items.some((l: any) => l.action === 'WALLET_CREDIT_ADJUSTMENT')
    ).toBe(true);

    // Ensure no secrets leaked in capabilities endpoint
    const caps = await request(app).get('/api/v1/jobs/capabilities');
    expect(caps.status).toBe(200);
    expect(JSON.stringify(caps.body)).not.toContain(env.JWT_ACCESS_SECRET);
  });
});
