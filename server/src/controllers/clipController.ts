import fs from 'fs';
import archiver from 'archiver';
import type { Request, Response } from 'express';
import {
  Clip,
  ProcessingJob,
  Project,
  type IClip,
} from '../models';
import {
  createMediaAccessToken,
  getStorageAdapter,
  localStorage,
  verifyMediaAccessToken,
} from '../services/storageService';
import { generateClipMetadataWithGracefulFallback } from '../services/aiService';
import { reserveCreditsForJob } from '../services/walletService';
import { enqueueProcessingJob, getActiveQueueMode } from '../queues/videoQueue';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';

export async function decorateClipWithSignedUrls(clip: IClip, ownerId: string) {
  const obj = clip.toObject ? clip.toObject() : { ...(clip as any) };
  const clipId = String(obj._id);
  const storage = getStorageAdapter();

  if (obj.status === 'ready') {
    const s3VideoUrl =
      storage.provider === 's3' ? await storage.getSignedReadUrl(obj.storageKey, 3600) : null;
    const streamToken = createMediaAccessToken({
      userId: ownerId,
      resourceType: 'clip_video',
      resourceId: clipId,
      ttlSeconds: 7200,
    });
    const downloadToken = createMediaAccessToken({
      userId: ownerId,
      resourceType: 'clip_download',
      resourceId: clipId,
      ttlSeconds: 7200,
    });

    obj.previewUrl = s3VideoUrl || `/api/v1/clips/${clipId}/stream?token=${streamToken}`;
    obj.downloadUrl = `/api/v1/clips/${clipId}/download?token=${downloadToken}`;

    if (obj.thumbnailKey) {
      const s3ThumbUrl =
        storage.provider === 's3' ? await storage.getSignedReadUrl(obj.thumbnailKey, 3600) : null;
      const thumbToken = createMediaAccessToken({
        userId: ownerId,
        resourceType: 'clip_thumb',
        resourceId: clipId,
        ttlSeconds: 7200,
      });
      obj.thumbnailUrl = s3ThumbUrl || `/api/v1/clips/${clipId}/thumbnail?token=${thumbToken}`;
    }
  }

  return obj;
}

export const clipController = {
  async list(req: Request, res: Response) {
    const userId = req.user!._id;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(60, Math.max(1, Number(req.query.limit || 24)));

    const filter: Record<string, any> = { userId };
    if (req.query.projectId) filter.projectId = String(req.query.projectId);
    if (req.query.aspectRatio) filter.aspectRatio = String(req.query.aspectRatio);
    if (req.query.status) filter.status = String(req.query.status);

    if (req.query.search) {
      const q = String(req.query.search).trim();
      if (q) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp(escaped, 'i');
        filter.$or = [{ title: rx }, { transcript: rx }];
      }
    }

    const sortParam = String(req.query.sort || 'newest');
    const sortSpec: Record<string, 1 | -1> =
      sortParam === 'score'
        ? { engagementScore: -1, createdAt: -1 }
        : sortParam === 'duration'
        ? { durationSec: -1, createdAt: -1 }
        : { createdAt: -1 };

    const [rawItems, total] = await Promise.all([
      Clip.find(filter)
        .populate('projectId', 'title')
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit),
      Clip.countDocuments(filter),
    ]);

    const items = await Promise.all(
      rawItems.map((c) => decorateClipWithSignedUrls(c, String(userId)))
    );

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
    const clip = await Clip.findById(req.params.id).populate('projectId', 'title');
    if (!clip) throw new NotFoundError('Clip not found');
    if (String(clip.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot access another user’s clip');
    }

    const decorated = await decorateClipWithSignedUrls(clip, String(req.user!._id));
    res.json({ success: true, data: { clip: decorated } });
  },

  async rename(req: Request, res: Response) {
    const clip = await Clip.findById(req.params.id);
    if (!clip) throw new NotFoundError('Clip not found');
    if (String(clip.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot modify another user’s clip');
    }

    clip.title = req.body.title.trim();
    await clip.save();
    const decorated = await decorateClipWithSignedUrls(clip, String(req.user!._id));
    res.json({ success: true, data: { clip: decorated } });
  },

  async updateMetadata(req: Request, res: Response) {
    const clip = await Clip.findById(req.params.id);
    if (!clip) throw new NotFoundError('Clip not found');
    if (String(clip.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot modify another user’s clip');
    }

    clip.metadata = {
      ...clip.metadata,
      ...(req.body.metadata || {}),
    };
    clip.markModified('metadata');
    await clip.save();

    const decorated = await decorateClipWithSignedUrls(clip, String(req.user!._id));
    res.json({ success: true, data: { clip: decorated } });
  },

  async regenerateMetadata(req: Request, res: Response) {
    const clip = await Clip.findById(req.params.id);
    if (!clip) throw new NotFoundError('Clip not found');
    if (String(clip.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot modify another user’s clip');
    }

    const project = await Project.findById(clip.projectId);
    const { metadata, aiNotice } = await generateClipMetadataWithGracefulFallback(
      {
        projectTitle: project?.title || clip.title,
        clipTranscript: clip.transcript || clip.title,
        category: clip.category,
        durationSec: clip.durationSec,
      },
      { clipId: String(clip._id) }
    );

    clip.metadata = metadata;
    clip.markModified('metadata');
    await clip.save();

    const decorated = await decorateClipWithSignedUrls(clip, String(req.user!._id));
    res.json({ success: true, data: { clip: decorated, aiNotice } });
  },

  async regenerateVideo(req: Request, res: Response) {
    const clip = await Clip.findById(req.params.id);
    if (!clip) throw new NotFoundError('Clip not found');
    if (String(clip.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot regenerate another user’s clip');
    }

    const regenCost = 5;
    const overrides: Record<string, unknown> = {};
    if (req.body.aspectRatio && ['9:16', '1:1', '16:9'].includes(req.body.aspectRatio)) {
      overrides.aspectRatio = req.body.aspectRatio;
    }
    if (req.body.captionStyle && typeof req.body.captionStyle === 'object') {
      overrides.captionStyle = { ...clip.captionStyle, ...req.body.captionStyle };
    }

    const job = await ProcessingJob.create({
      userId: req.user!._id,
      projectId: clip.projectId,
      videoId: clip.videoId,
      targetClipId: clip._id,
      type: 'regenerate_clip',
      overrides,
      queueMode: getActiveQueueMode(),
      stage: 'editing',
      status: 'queued',
      progressPercent: 10,
      currentMessage: 'Queued clip re-render...',
      creditsReserved: regenCost,
      idempotencyKey: `job:regen:${String(clip._id)}:${Date.now()}`,
    });

    await reserveCreditsForJob({
      userId: req.user!._id,
      jobId: job._id,
      amount: regenCost,
      description: `Reserved ${regenCost} credits to re-render clip "${clip.title}"`,
    });

    clip.status = 'rendering';
    await clip.save();

    await enqueueProcessingJob(String(job._id));

    res.status(202).json({
      success: true,
      data: { job },
    });
  },

  async remove(req: Request, res: Response) {
    const clip = await Clip.findById(req.params.id);
    if (!clip) throw new NotFoundError('Clip not found');
    if (String(clip.userId) !== String(req.user!._id)) {
      throw new ForbiddenError('Cannot delete another user’s clip');
    }

    const storage = getStorageAdapter();
    await storage.deleteObject(clip.storageKey);
    if (clip.thumbnailKey) await storage.deleteObject(clip.thumbnailKey);
    await Clip.deleteOne({ _id: clip._id });

    const remaining = await Clip.countDocuments({ projectId: clip.projectId, status: 'ready' });
    await Project.findByIdAndUpdate(clip.projectId, { $set: { clipsCount: remaining } });

    res.json({ success: true, data: { deleted: true } });
  },

  async streamVideo(req: Request, res: Response) {
    const token = String(req.query.token || '');
    const { userId } = verifyMediaAccessToken(token, 'clip_video', String(req.params.id));

    const clip = await Clip.findById(req.params.id);
    if (!clip || String(clip.userId) !== userId) {
      throw new ForbiddenError('Unauthorized clip stream request');
    }

    const filePath = localStorage.getSafeReadPath(clip.storageKey);
    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  },

  async streamThumbnail(req: Request, res: Response) {
    const token = String(req.query.token || '');
    const { userId } = verifyMediaAccessToken(token, 'clip_thumb', String(req.params.id));

    const clip = await Clip.findById(req.params.id);
    if (!clip || String(clip.userId) !== userId || !clip.thumbnailKey) {
      throw new NotFoundError('Thumbnail not found');
    }

    const filePath = localStorage.getSafeReadPath(clip.thumbnailKey);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  },

  async downloadVideo(req: Request, res: Response) {
    const token = String(req.query.token || '');
    const { userId } = verifyMediaAccessToken(token, 'clip_download', String(req.params.id));

    const clip = await Clip.findById(req.params.id);
    if (!clip || String(clip.userId) !== userId) {
      throw new ForbiddenError('Unauthorized clip download request');
    }

    const storage = getStorageAdapter();
    if (storage.provider === 's3') {
      const signed = await storage.getSignedReadUrl(clip.storageKey, 900);
      if (signed) {
        res.redirect(signed);
        return;
      }
    }

    const filePath = localStorage.getSafeReadPath(clip.storageKey);
    const safeName =
      clip.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || `clip_${String(clip._id)}`;
    res.download(filePath, `${safeName}_${clip.aspectRatio.replace(':', 'x')}.mp4`);
  },

  async createBulkDownloadToken(req: Request, res: Response) {
    const clipIds: string[] = Array.isArray(req.body.clipIds) ? req.body.clipIds : [];
    if (clipIds.length === 0 || clipIds.length > 25) {
      throw new BadRequestError('Select between 1 and 25 clips for bulk download');
    }

    const ownedCount = await Clip.countDocuments({
      _id: { $in: clipIds },
      userId: req.user!._id,
      status: 'ready',
    });

    if (ownedCount !== clipIds.length) {
      throw new ForbiddenError('One or more selected clips do not belong to your account');
    }

    const joinedIds = clipIds.join(',');
    const token = createMediaAccessToken({
      userId: String(req.user!._id),
      resourceType: 'bulk_zip',
      resourceId: joinedIds,
      ttlSeconds: 900,
    });

    res.json({
      success: true,
      data: {
        downloadUrl: `/api/v1/clips/bulk-download?token=${encodeURIComponent(token)}`,
      },
    });
  },

  async streamBulkZip(req: Request, res: Response) {
    const token = String(req.query.token || '');
    const { userId, resourceId } = verifyMediaAccessToken(token, 'bulk_zip');
    const ids = resourceId.split(',').filter(Boolean);

    const clips = await Clip.find({
      _id: { $in: ids },
      userId,
      status: 'ready',
    });

    if (clips.length === 0) {
      throw new NotFoundError('No downloadable clips found');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clipforge_clips_${Date.now()}.zip"`
    );

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    clips.forEach((c, idx) => {
      try {
        const p = localStorage.getSafeReadPath(c.storageKey);
        const safe = c.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 50) || `clip_${idx + 1}`;
        archive.file(p, { name: `${String(idx + 1).padStart(2, '0')}_${safe}.mp4` });
      } catch {
        // skip missing file safely
      }
    });

    await archive.finalize();
  },
};
