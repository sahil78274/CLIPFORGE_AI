import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';
import { env } from '../config/env';
import {
  Clip,
  ProcessingJob,
  Project,
  Video,
  getOrCreateSystemConfig,
} from '../models';
import { probeMediaFile } from '../services/mediaProbeService';
import { assertClipCountWithinSystemLimit } from '../services/processingSettingsService';
import { getStorageAdapter } from '../services/storageService';
import {
  downloadSafeDirectMediaUrl,
  inspectVideoUrl,
} from '../services/urlSafetyService';
import {
  calculateJobCreditCost,
  ensureUserWallet,
  reserveCreditsForJob,
} from '../services/walletService';
import { getActiveQueueMode, enqueueProcessingJob, cancelQueuedOrRunningJob } from '../queues/videoQueue';
import { processingSettingsSchema } from '../validators/schemas';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import { decorateClipWithSignedUrls } from './clipController';

export const projectController = {
  async list(req: Request, res: Response) {
    const userId = req.user!._id;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 12)));
    const status = req.query.status ? String(req.query.status) : undefined;
    const search = req.query.search ? String(req.query.search).trim() : undefined;

    const filter: Record<string, any> = { userId };
    if (status) filter.status = status;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.title = new RegExp(escaped, 'i');
    }

    const [items, total] = await Promise.all([
      Project.find(filter)
        .populate('videoId', 'durationSec originalFilename width height sizeBytes status')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Project.countDocuments(filter),
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

  async getById(req: Request, res: Response) {
    const project = await Project.findById(req.params.id).populate('videoId');
    if (!project) {
      throw new NotFoundError('Project not found');
    }
    if (String(project.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('You do not have permission to access this project');
    }

    const [rawClips, jobs] = await Promise.all([
      Clip.find({ projectId: project._id, userId: req.user!._id }).sort({ startSec: 1 }),
      ProcessingJob.find({ projectId: project._id, userId: req.user!._id })
        .sort({ createdAt: -1 })
        .limit(10),
    ]);

    const clips = await Promise.all(
      rawClips.map((c) => decorateClipWithSignedUrls(c, String(req.user!._id)))
    );

    res.json({
      success: true,
      data: {
        project,
        clips,
        jobs,
      },
    });
  },

  async create(req: Request, res: Response) {
    const project = await Project.create({
      userId: req.user!._id,
      title: req.body.title,
      description: req.body.description,
      settings: req.body.settings || DEFAULT_PROCESSING_SETTINGS,
      status: 'draft',
    });

    res.status(201).json({
      success: true,
      data: { project },
    });
  },

  async remove(req: Request, res: Response) {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError('Project not found');
    if (String(project.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('You do not have permission to delete this project');
    }

    const activeJobs = await ProcessingJob.find({
      projectId: project._id,
      status: { $in: ['queued', 'processing'] },
    });
    for (const j of activeJobs) {
      await cancelQueuedOrRunningJob(String(j._id));
    }

    const storage = getStorageAdapter();
    const clips = await Clip.find({ projectId: project._id });
    for (const c of clips) {
      await storage.deleteObject(c.storageKey);
      if (c.thumbnailKey) await storage.deleteObject(c.thumbnailKey);
    }

    const videos = await Video.find({ projectId: project._id });
    for (const v of videos) {
      await storage.deleteObject(v.storageKey);
    }

    await Promise.all([
      Clip.deleteMany({ projectId: project._id }),
      Video.deleteMany({ projectId: project._id }),
      ProcessingJob.deleteMany({ projectId: project._id }),
      Project.deleteOne({ _id: project._id }),
    ]);

    res.json({
      success: true,
      data: { deleted: true },
    });
  },
};

export const videoController = {
  async checkUrl(req: Request, res: Response) {
    const report = await inspectVideoUrl(req.body.url);
    res.json({
      success: true,
      data: report,
    });
  },

  async uploadVideo(req: Request, res: Response) {
    const uploadedFile = req.file;
    if (!uploadedFile) {
      throw new BadRequestError('No video file received in multipart field "video"');
    }

    const userId = req.user!._id;
    const cfg = await getOrCreateSystemConfig();

    try {
      if (uploadedFile.size > cfg.maxUploadSizeMb * 1024 * 1024) {
        throw new BadRequestError(
          `Uploaded file exceeds maximum allowed size (${cfg.maxUploadSizeMb} MB).`
        );
      }

      let rawSettings: unknown = undefined;
      if (typeof req.body.settings === 'string' && req.body.settings.trim()) {
        try {
          rawSettings = JSON.parse(req.body.settings);
        } catch {
          throw new BadRequestError('Invalid JSON in settings field');
        }
      }
      const parsedSettings = processingSettingsSchema.parse(rawSettings || {});
      assertClipCountWithinSystemLimit(parsedSettings.clipCount, cfg.maxClipsPerJob);

      const probe = await probeMediaFile(uploadedFile.path);
      if (probe.durationSec > cfg.maxVideoDurationSec) {
        throw new BadRequestError(
          `Video duration (${Math.round(probe.durationSec)}s) exceeds limit (${cfg.maxVideoDurationSec}s).`
        );
      }

      await ensureUserWallet(userId, false);
      const autoStart = String(req.body.autoStart ?? 'true') !== 'false';
      const estimatedCost = await calculateJobCreditCost(
        probe.durationSec,
        parsedSettings.clipCount
      );

      const title =
        (typeof req.body.title === 'string' && req.body.title.trim()) ||
        uploadedFile.originalname.replace(/\.[^.]+$/, '') ||
        'Untitled Video Project';

      const project = await Project.create({
        userId,
        title: title.slice(0, 180),
        sourceType: 'upload',
        sourcePlatform: 'upload',
        settings: parsedSettings,
        status: autoStart ? 'queued' : 'draft',
      });

      const ext = path.extname(uploadedFile.originalname || '.mp4').toLowerCase() || '.mp4';
      const storageKey = `sources/${String(userId)}/${String(project._id)}/source${ext}`;
      const storage = getStorageAdapter();
      await storage.saveFromLocalFile(
        uploadedFile.path,
        storageKey,
        uploadedFile.mimetype || 'video/mp4'
      );

      const video = await Video.create({
        userId,
        projectId: project._id,
        originalFilename: uploadedFile.originalname,
        storageKey,
        storageProvider: storage.provider,
        mimeType: uploadedFile.mimetype || 'video/mp4',
        sizeBytes: probe.sizeBytes,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        codec: probe.codec,
        audioCodec: probe.audioCodec,
        hasAudio: probe.hasAudio,
        status: 'validated',
      });

      project.videoId = video._id;

      let jobDoc = undefined;
      if (autoStart) {
        jobDoc = await ProcessingJob.create({
          userId,
          projectId: project._id,
          videoId: video._id,
          type: 'full_pipeline',
          queueMode: getActiveQueueMode(),
          stage: 'importing',
          status: 'queued',
          progressPercent: 2,
          currentMessage: 'Video validated and queued for AI analysis...',
          creditsReserved: estimatedCost,
          idempotencyKey: `job:init:${String(project._id)}:${Date.now()}`,
        });

        try {
          await reserveCreditsForJob({
            userId,
            jobId: jobDoc._id,
            amount: estimatedCost,
            description: `Reserved ${estimatedCost} credits for "${project.title}"`,
          });
        } catch (creditErr) {
          await ProcessingJob.deleteOne({ _id: jobDoc._id });
          project.status = 'draft';
          await project.save();
          throw creditErr;
        }

        project.latestJobId = jobDoc._id;
        project.creditsReserved = estimatedCost;
        await project.save();

        await enqueueProcessingJob(String(jobDoc._id));
      } else {
        await project.save();
      }

      res.status(201).json({
        success: true,
        data: {
          project,
          video,
          job: jobDoc,
        },
      });
    } finally {
      try {
        if (fs.existsSync(uploadedFile.path)) {
          fs.unlinkSync(uploadedFile.path);
        }
      } catch {
        // ignore temp cleanup warning
      }
    }
  },

  async importFromUrl(req: Request, res: Response) {
    const userId = req.user!._id;
    const rawUrl: string = req.body.url;
    const check = await inspectVideoUrl(rawUrl);

    if (!check.importableDirectly) {
      throw new BadRequestError(check.reason, 'URL_DIRECT_IMPORT_UNAVAILABLE');
    }

    const cfg = await getOrCreateSystemConfig();
    const maxBytes = cfg.maxUploadSizeMb * 1024 * 1024;
    const tempDir = path.join(env.TEMP_WORKING_DIR, 'url_imports');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `import_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    try {
      const downloaded = await downloadSafeDirectMediaUrl(rawUrl, tempPath, maxBytes);
      const probe = await probeMediaFile(tempPath);

      if (probe.durationSec > cfg.maxVideoDurationSec) {
        throw new BadRequestError(
          `Imported video duration (${Math.round(probe.durationSec)}s) exceeds limit (${cfg.maxVideoDurationSec}s).`
        );
      }

      const settings = processingSettingsSchema.parse(req.body.settings || {});
      assertClipCountWithinSystemLimit(settings.clipCount, cfg.maxClipsPerJob);

      const estimatedCost = await calculateJobCreditCost(probe.durationSec, settings.clipCount);

      const project = await Project.create({
        userId,
        title: req.body.title,
        sourceType: 'url',
        sourceUrl: rawUrl,
        sourcePlatform: 'direct_mp4',
        settings,
        status: 'queued',
      });

      const storageKey = `sources/${String(userId)}/${String(project._id)}/imported.mp4`;
      const storage = getStorageAdapter();
      await storage.saveFromLocalFile(tempPath, storageKey, downloaded.contentType);

      const video = await Video.create({
        userId,
        projectId: project._id,
        originalFilename: path.basename(new URL(rawUrl).pathname) || 'imported.mp4',
        storageKey,
        storageProvider: storage.provider,
        mimeType: downloaded.contentType,
        sizeBytes: probe.sizeBytes,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        codec: probe.codec,
        audioCodec: probe.audioCodec,
        hasAudio: probe.hasAudio,
        status: 'validated',
      });

      const job = await ProcessingJob.create({
        userId,
        projectId: project._id,
        videoId: video._id,
        type: 'full_pipeline',
        queueMode: getActiveQueueMode(),
        stage: 'importing',
        status: 'queued',
        progressPercent: 2,
        currentMessage: 'Imported URL media validated and queued...',
        creditsReserved: estimatedCost,
        idempotencyKey: `job:url:${String(project._id)}:${Date.now()}`,
      });

      await reserveCreditsForJob({
        userId,
        jobId: job._id,
        amount: estimatedCost,
        description: `Reserved ${estimatedCost} credits for URL import "${project.title}"`,
      });

      project.videoId = video._id;
      project.latestJobId = job._id;
      project.creditsReserved = estimatedCost;
      await project.save();

      await enqueueProcessingJob(String(job._id));

      res.status(201).json({
        success: true,
        data: { project, video, job },
      });
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  },
};
