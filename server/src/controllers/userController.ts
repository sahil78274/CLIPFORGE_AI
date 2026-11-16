import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import {
  Clip,
  Notification,
  ProcessingJob,
  Project,
  User,
} from '../models';
import { ensureUserWallet } from '../services/walletService';
import { BadRequestError } from '../utils/errors';
import { decorateClipWithSignedUrls } from './clipController';

export const userController = {
  async overview(req: Request, res: Response) {
    const userId = req.user!._id;

    const [
      wallet,
      totalProjects,
      clipsGenerated,
      activeProcessingJobs,
      recentProjects,
      recentJobs,
      rawRecentClips,
      recentActivity,
    ] = await Promise.all([
      ensureUserWallet(userId, false),
      Project.countDocuments({ userId }),
      Clip.countDocuments({ userId, status: 'ready' }),
      ProcessingJob.countDocuments({ userId, status: { $in: ['queued', 'processing'] } }),
      Project.find({ userId })
        .populate('videoId', 'durationSec originalFilename width height')
        .sort({ createdAt: -1 })
        .limit(6),
      ProcessingJob.find({ userId })
        .populate('projectId', 'title')
        .sort({ createdAt: -1 })
        .limit(5),
      Clip.find({ userId, status: 'ready' }).sort({ createdAt: -1 }).limit(6),
      Notification.find({ userId }).sort({ createdAt: -1 }).limit(8),
    ]);

    const recentClips = await Promise.all(
      rawRecentClips.map((c) => decorateClipWithSignedUrls(c, String(userId)))
    );

    res.json({
      success: true,
      data: {
        stats: {
          totalProjects,
          clipsGenerated,
          activeProcessingJobs,
          creditsRemaining: wallet.availableCredits,
          reservedCredits: wallet.reservedCredits,
        },
        recentProjects,
        recentJobs,
        recentClips,
        recentActivity,
      },
    });
  },

  async updateProfile(req: Request, res: Response) {
    const user = req.user!;
    if (req.body.name) {
      user.name = req.body.name.trim();
    }
    if (req.body.preferences) {
      user.preferences = {
        ...user.preferences,
        ...req.body.preferences,
      };
    }
    await user.save();

    res.json({
      success: true,
      data: {
        user: {
          id: String(user._id),
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          preferences: user.preferences,
          createdAt: user.createdAt,
        },
      },
    });
  },

  async changePassword(req: Request, res: Response) {
    const fullUser = await User.findById(req.user!._id).select('+passwordHash');
    if (!fullUser) throw new BadRequestError('User not found');

    const matches = await bcrypt.compare(req.body.currentPassword, fullUser.passwordHash);
    if (!matches) {
      throw new BadRequestError('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }

    fullUser.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    await fullUser.save();

    res.json({
      success: true,
      data: { message: 'Password updated successfully' },
    });
  },

  async globalSearch(req: Request, res: Response) {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      res.json({ success: true, data: { projects: [], clips: [] } });
      return;
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const userId = req.user!._id;

    const [projects, clips] = await Promise.all([
      Project.find({ userId, title: regex }).sort({ createdAt: -1 }).limit(5),
      Clip.find({
        userId,
        $or: [{ title: regex }, { transcript: regex }],
      })
        .sort({ createdAt: -1 })
        .limit(6),
    ]);

    res.json({
      success: true,
      data: { projects, clips },
    });
  },
};
