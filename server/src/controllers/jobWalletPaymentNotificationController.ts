import fs from 'fs';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import {
  CreditPackage,
  CreditTransaction,
  Notification,
  Payment,
  ProcessingJob,
  Project,
  Video,
  getOrCreateSystemConfig,
} from '../models';
import { checkMediaBinaries } from '../services/mediaProbeService';
import { getAIProvider } from '../services/aiService';
import { getYouTubeMediaSourceAdapter } from '../services/youtubeMediaSourceAdapter';
import {
  createPaymentOrder,
  isRazorpayLiveOrTestConfigured,
  isSandboxSimulatorAllowed,
  processRazorpayWebhook,
  verifyRazorpayClientPayment,
} from '../services/paymentService';
import {
  calculateJobCreditCost,
  ensureUserWallet,
  releaseReservedCredits,
  reserveCreditsForJob,
} from '../services/walletService';
import {
  cancelQueuedOrRunningJob,
  enqueueProcessingJob,
  getActiveQueueMode,
  getQueueHealth,
} from '../queues/videoQueue';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';

export const jobController = {
  async capabilities(_req: Request, res: Response) {
    const [mediaBins, cfg, qHealth] = await Promise.all([
      checkMediaBinaries(),
      getOrCreateSystemConfig(),
      getQueueHealth(),
    ]);

    const ai = getAIProvider();
    const ytAdapter = getYouTubeMediaSourceAdapter();
    const whisperCached = Boolean(
      env.WHISPER_MODEL_PATH && fs.existsSync(env.WHISPER_MODEL_PATH)
    );

    res.json({
      success: true,
      data: {
        ffmpeg: { available: mediaBins.ffmpegAvailable },
        ffprobe: { available: mediaBins.ffprobeAvailable },
        ai: {
          provider: ai.providerName,
          configured: ai.isConfigured(),
          model: ai.modelName,
          ...(!ai.isConfigured() ? { setupInstructions: ai.getSetupInstructions() } : {}),
        },
        youtube: {
          adapterName: ytAdapter.name,
          mediaAdapterConfigured: ytAdapter.isConfigured(),
          youtubeDataApiConfigured: Boolean(
            env.YOUTUBE_DATA_API_KEY && env.YOUTUBE_DATA_API_KEY.trim().length > 8
          ),
          maxDurationSec: Math.min(env.MAX_VIDEO_DURATION_SEC, cfg.maxVideoDurationSec || 36000),
          chunkDurationSec: cfg.chunkDurationSec || env.VIDEO_CHUNK_DURATION_SEC,
          setupInstructions: ytAdapter.getSetupInstructions(),
        },
        transcription: {
          primaryEngine: 'faster-whisper',
          whisperModelCached: whisperCached,
          offlineFallbackEngine: 'embedded_subtitles + pocketsphinx_offline',
          ...(!whisperCached
            ? {
                setupInstructions:
                  'Faster-Whisper runs automatically when HuggingFace Hub is reachable or WHISPER_MODEL_PATH points to a local CTranslate2 Whisper folder. Offline mode uses embedded subtitles and PocketSphinx ASR.',
              }
            : {}),
        },
        payments: {
          razorpayConfigured: isRazorpayLiveOrTestConfigured(),
          sandboxSimulatorEnabled: isSandboxSimulatorAllowed(),
          ...(isRazorpayLiveOrTestConfigured() ? { keyId: env.RAZORPAY_KEY_ID } : {}),
        },
        queue: {
          mode: qHealth.mode,
          redisConnected: qHealth.redisConnected,
        },
        limits: {
          welcomeCredits: cfg.welcomeCredits,
          creditsPerMinuteProcessed: cfg.creditsPerMinuteProcessed,
          minCreditsPerJob: cfg.minCreditsPerJob,
          maxUploadSizeMb: cfg.maxUploadSizeMb,
          maxVideoDurationSec: cfg.maxVideoDurationSec,
          maxClipsPerJob: cfg.maxClipsPerJob,
        },
        supportedPlatforms: cfg.supportedPlatforms,
      },
    });
  },

  async list(req: Request, res: Response) {
    const userId = req.user!._id;
    const filter: Record<string, any> = { userId };
    if (req.query.status) {
      const s = String(req.query.status);
      filter.status = s === 'processing' ? { $in: ['queued', 'processing'] } : s;
    }

    const [items, total] = await Promise.all([
      ProcessingJob.find(filter)
        .populate('projectId', 'title')
        .sort({ createdAt: -1 })
        .limit(40),
      ProcessingJob.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { items, total },
    });
  },

  async getById(req: Request, res: Response) {
    const job = await ProcessingJob.findById(req.params.id).populate('projectId', 'title');
    if (!job) throw new NotFoundError('Job not found');
    if (String(job.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot access another user’s job');
    }
    res.json({ success: true, data: { job } });
  },

  async startForProject(req: Request, res: Response) {
    const project = await Project.findById(req.params.projectId);
    if (!project) throw new NotFoundError('Project not found');
    if (String(project.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot process another user’s project');
    }
    const activeExisting = await ProcessingJob.findOne({
      projectId: project._id,
      status: { $in: ['queued', 'processing'] },
    });
    if (activeExisting) {
      throw new BadRequestError('A processing job is already active for this project');
    }

    let video = project.videoId ? await Video.findById(project.videoId) : null;
    if (
      !video &&
      project.sourcePlatform !== 'youtube' &&
      project.sourcePlatform !== 'google_drive' &&
      !project.youtubeMetadata?.videoId
    ) {
      throw new BadRequestError('Project does not have a validated source video yet');
    }

    const estDuration = video
      ? video.durationSec
      : project.youtubeMetadata?.durationSec ||
        project.googleDriveMetadata?.durationSec ||
        60;
    const cost = await calculateJobCreditCost(estDuration, project.settings.clipCount);
    const job = await ProcessingJob.create({
      userId: req.user!._id,
      projectId: project._id,
      videoId: video?._id,
      type: 'full_pipeline',
      queueMode: getActiveQueueMode(),
      stage: 'importing',
      status: 'queued',
      progressPercent: 2,
      currentMessage: 'Queued for background pipeline...',
      creditsReserved: cost,
      youtubeImport:
        !video && project.youtubeMetadata
          ? {
              videoId: project.youtubeMetadata.videoId,
              canonicalUrl: project.youtubeMetadata.canonicalUrl,
              title: project.youtubeMetadata.title,
              channelName: project.youtubeMetadata.channelName,
              thumbnailUrl: project.youtubeMetadata.thumbnailUrl,
              expectedDurationSec: project.youtubeMetadata.durationSec ?? undefined,
            }
          : undefined,
      driveImport:
        !video && project.googleDriveMetadata
          ? {
              selectionId: project.googleDriveMetadata.selectionId,
              fileId: project.googleDriveMetadata.fileId,
              fileName: project.googleDriveMetadata.fileName,
              mimeType: project.googleDriveMetadata.mimeType,
              sizeBytes: project.googleDriveMetadata.sizeBytes ?? null,
              durationSec: project.googleDriveMetadata.durationSec ?? null,
              estimatedDurationSec: project.googleDriveMetadata.durationSec ?? 600,
            }
          : undefined,
      idempotencyKey: `job:manual:${String(project._id)}:${Date.now()}`,
    });

    await reserveCreditsForJob({
      userId: req.user!._id,
      jobId: job._id,
      amount: cost,
      description: `Reserved ${cost} credits to process "${project.title}"`,
    });

    project.status = 'queued';
    project.latestJobId = job._id;
    project.creditsReserved = cost;
    await project.save();

    await enqueueProcessingJob(String(job._id));
    res.status(202).json({ success: true, data: { job } });
  },

  async cancel(req: Request, res: Response) {
    const job = await ProcessingJob.findById(req.params.id);
    if (!job) throw new NotFoundError('Processing job not found');
    if (String(job.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot cancel another user’s job');
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      res.json({ success: true, data: { job } });
      return;
    }

    await cancelQueuedOrRunningJob(String(job._id));

    if (!job.creditReservationReleased && job.creditsReserved > 0) {
      await releaseReservedCredits({
        userId: job.userId,
        jobId: String(job._id),
        reservedAmount: job.creditsReserved,
        reason: 'Cancelled by user',
      });
      job.creditReservationReleased = true;
    }

    job.status = 'cancelled';
    job.stage = 'cancelled';
    job.cancelledAt = new Date();
    job.currentMessage = 'Cancelled by user. Reserved credits returned to wallet.';
    await job.save();

    await Project.findByIdAndUpdate(job.projectId, { $set: { status: 'cancelled' } });
    res.json({ success: true, data: { job } });
  },

  async retry(req: Request, res: Response) {
    const oldJob = await ProcessingJob.findById(req.params.id);
    if (!oldJob) throw new NotFoundError('Job not found');
    if (String(oldJob.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot retry another user’s job');
    }
    if (oldJob.status !== 'failed' && oldJob.status !== 'cancelled') {
      throw new BadRequestError('Only failed or cancelled jobs can be retried');
    }

    const project = await Project.findById(oldJob.projectId);
    const video = oldJob.videoId ? await Video.findById(oldJob.videoId) : null;
    if (!project || (!video && !oldJob.youtubeImport && !oldJob.driveImport)) {
      throw new NotFoundError('Associated project or source video missing');
    }

    const estDurationSec =
      video?.durationSec ||
      Number((oldJob.youtubeImport?.metadata as any)?.durationSec || 0) ||
      Number(oldJob.driveImport?.estimatedDurationSec || 600);
    const cost = await calculateJobCreditCost(estDurationSec, project.settings.clipCount);
    const newJob = await ProcessingJob.create({
      userId: req.user!._id,
      projectId: project._id,
      videoId: video?._id,
      type: oldJob.type,
      targetClipId: oldJob.targetClipId,
      overrides: oldJob.overrides,
      youtubeImport: oldJob.youtubeImport,
      driveImport: oldJob.driveImport,
      chunkProgress: oldJob.chunkProgress
        ? {
            ...oldJob.chunkProgress,
            completedChunks: 0,
            currentChunkIndex: 0,
          }
        : undefined,
      queueMode: getActiveQueueMode(),
      stage: 'importing',
      status: 'queued',
      progressPercent: 2,
      currentMessage: 'Retry job queued...',
      creditsReserved: cost,
      idempotencyKey: `job:retry:${String(oldJob._id)}:${Date.now()}`,
    });

    await reserveCreditsForJob({
      userId: req.user!._id,
      jobId: newJob._id,
      amount: cost,
      description: `Reserved ${cost} credits for retry of "${project.title}"`,
    });

    project.status = 'queued';
    project.latestJobId = newJob._id;
    await project.save();

    await enqueueProcessingJob(String(newJob._id));
    res.status(202).json({ success: true, data: { job: newJob } });
  },
};

export const walletController = {
  async getWallet(req: Request, res: Response) {
    const wallet = await ensureUserWallet(req.user!._id, false);
    res.json({ success: true, data: { wallet } });
  },

  async listTransactions(req: Request, res: Response) {
    const userId = req.user!._id;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const filter: Record<string, any> = { userId };
    if (req.query.type) filter.type = String(req.query.type);

    const [items, total] = await Promise.all([
      CreditTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CreditTransaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        items,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  },
};

export const paymentController = {
  async listPackages(_req: Request, res: Response) {
    const items = await CreditPackage.find({ active: true }).sort({ sortOrder: 1 });
    res.json({ success: true, data: { items } });
  },

  async history(req: Request, res: Response) {
    const items = await Payment.find({ userId: req.user!._id })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: { items } });
  },

  async createOrder(req: Request, res: Response) {
    const data = await createPaymentOrder({
      userId: req.user!._id,
      packageId: req.body.packageId,
      useSandboxSimulator: Boolean(req.body.useSandboxSimulator),
    });
    res.status(201).json({ success: true, data });
  },

  async verify(req: Request, res: Response) {
    const data = await verifyRazorpayClientPayment({
      userId: req.user!._id,
      razorpayOrderId: req.body.razorpayOrderId,
      razorpayPaymentId: req.body.razorpayPaymentId,
      razorpaySignature: req.body.razorpaySignature,
    });
    res.json({ success: true, data });
  },

  async webhook(req: Request, res: Response) {
    const sig = String(req.headers['x-razorpay-signature'] || '');
    if (!sig) {
      throw new BadRequestError('Missing X-Razorpay-Signature header', 'MISSING_WEBHOOK_SIGNATURE');
    }
    const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body)));
    const eventId = req.headers['x-razorpay-event-id']
      ? String(req.headers['x-razorpay-event-id'])
      : undefined;

    const result = await processRazorpayWebhook({
      rawBody,
      signatureHeader: sig,
      eventIdHeader: eventId,
    });

    res.json({ success: true, data: result });
  },
};

export const notificationController = {
  async list(req: Request, res: Response) {
    const userId = req.user!._id;
    const [items, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).limit(25),
      Notification.countDocuments({ userId, isRead: false }),
    ]);
    res.json({ success: true, data: { items, unreadCount } });
  },

  async markRead(req: Request, res: Response) {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!._id },
      { $set: { isRead: true } },
      { new: true }
    );
    if (!n) throw new NotFoundError('Notification not found');
    res.json({ success: true, data: { notification: n } });
  },

  async markAllRead(req: Request, res: Response) {
    const result = await Notification.updateMany(
      { userId: req.user!._id, isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ success: true, data: { updated: result.modifiedCount || 0 } });
  },

  async submitContact(req: Request, res: Response) {
    const ticketRef = `CF-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await Notification.create({
      type: 'system',
      title: `Support Ticket [${ticketRef}]: ${req.body.subject}`,
      message: `From ${req.body.name} <${req.body.email}>: ${req.body.message}`,
      metadata: {
        ticketRef,
        senderName: req.body.name,
        senderEmail: req.body.email,
      },
    });
    res.status(201).json({
      success: true,
      data: { submitted: true, ticketRef },
    });
  },
};
