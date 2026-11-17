import type { Request, Response } from 'express';
import { getDatabaseHealth } from '../config/database';
import {
  AdminAuditLog,
  Clip,
  CreditPackage,
  CreditTransaction,
  CreditWallet,
  Payment,
  ProcessingJob,
  Project,
  User,
  getOrCreateSystemConfig,
} from '../models';
import { checkMediaBinaries } from '../services/mediaProbeService';
import { getAIProvider } from '../services/aiService';
import { isRazorpayLiveOrTestConfigured } from '../services/paymentService';
import { adminAdjustCredits, reverseRefundedCredits } from '../services/walletService';
import { getQueueHealth } from '../queues/videoQueue';
import { BadRequestError, NotFoundError } from '../utils/errors';

async function recordAdminAudit(
  req: Request,
  entry: {
    action: string;
    targetType: 'user' | 'wallet' | 'package' | 'system_config' | 'job' | 'payment';
    targetId?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    reason?: string;
  }
) {
  await AdminAuditLog.create({
    adminId: req.user!._id,
    adminEmail: req.user!.email,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    before: entry.before,
    after: entry.after,
    reason: entry.reason,
    ipAddress: req.ip,
    requestId: req.requestId,
  });
}

export const adminController = {
  async overview(_req: Request, res: Response) {
    const [
      totalUsers,
      activeUsers,
      totalProjects,
      totalClips,
      totalJobs,
      failedJobs,
      activeJobs,
      paymentCount,
      verifiedPayments,
      wallets,
      bins,
      qHealth,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ status: 'active' }),
      Project.countDocuments({}),
      Clip.countDocuments({ status: 'ready' }),
      ProcessingJob.countDocuments({}),
      ProcessingJob.countDocuments({ status: 'failed' }),
      ProcessingJob.countDocuments({ status: { $in: ['queued', 'processing'] } }),
      Payment.countDocuments({}),
      Payment.find({ status: 'verified' }),
      CreditWallet.find({}),
      checkMediaBinaries(),
      getQueueHealth(),
    ]);

    let liveRevenuePaise = 0;
    let sandboxVolumePaise = 0;
    for (const p of verifiedPayments) {
      if (p.isDevelopmentMode) {
        sandboxVolumePaise += p.amountPaise;
      } else {
        liveRevenuePaise += p.amountPaise;
      }
    }

    const totalCreditsUsed = wallets.reduce((acc, w) => acc + (w.lifetimeUsedCredits || 0), 0);
    const ai = getAIProvider();
    const dbHealth = getDatabaseHealth();

    res.json({
      success: true,
      data: {
        metrics: {
          totalUsers,
          activeUsers,
          totalProjects,
          totalClips,
          totalJobs,
          failedJobs,
          activeJobs,
          paymentCount,
          liveRevenuePaise,
          sandboxVolumePaise,
          totalCreditsUsed,
        },
        health: {
          database: `${dbHealth.status} (${dbHealth.mode})`,
          ffmpeg: bins.ffmpegAvailable && bins.ffprobeAvailable,
          aiProvider: ai.providerName,
          aiConfigured: ai.isConfigured(),
          razorpayConfigured: isRazorpayLiveOrTestConfigured(),
        },
        queue: qHealth,
      },
    });
  },

  async listUsers(req: Request, res: Response) {
    const filter: Record<string, any> = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { email: rx }];
      }
    }

    const users = await User.find(filter).sort({ createdAt: -1 }).limit(100);
    const userIds = users.map((u) => u._id);
    const wallets = await CreditWallet.find({ userId: { $in: userIds } });
    const walletMap = new Map(wallets.map((w) => [String(w.userId), w]));

    const items = users.map((u) => ({
      id: String(u._id),
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status,
      preferences: u.preferences,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      wallet: walletMap.get(String(u._id)),
    }));

    res.json({ success: true, data: { items, total: items.length } });
  },

  async updateUserStatus(req: Request, res: Response) {
    const target = await User.findById(req.params.id);
    if (!target) throw new NotFoundError('Target user not found');
    if (String(target._id) === String(req.user!._id)) {
      throw new BadRequestError('Administrators cannot suspend their own active session');
    }

    const prevStatus = target.status;
    target.status = req.body.status;
    await target.save();

    await recordAdminAudit(req, {
      action: target.status === 'suspended' ? 'USER_SUSPENDED' : 'USER_RESTORED',
      targetType: 'user',
      targetId: String(target._id),
      before: { status: prevStatus },
      after: { status: target.status },
      reason: req.body.reason,
    });

    res.json({
      success: true,
      data: {
        user: {
          id: String(target._id),
          name: target.name,
          email: target.email,
          role: target.role,
          status: target.status,
        },
      },
    });
  },

  async adjustUserCredits(req: Request, res: Response) {
    const target = await User.findById(req.params.id);
    if (!target) throw new NotFoundError('Target user not found');

    const wallet = await adminAdjustCredits({
      userId: target._id,
      delta: Number(req.body.amount),
      reason: req.body.reason,
      adminId: req.user!._id,
    });

    await recordAdminAudit(req, {
      action: 'WALLET_CREDIT_ADJUSTMENT',
      targetType: 'wallet',
      targetId: String(target._id),
      after: { delta: req.body.amount, newAvailableBalance: wallet.availableCredits },
      reason: req.body.reason,
    });

    res.json({ success: true, data: { wallet } });
  },

  async getUserActivity(req: Request, res: Response) {
    const target = await User.findById(req.params.id);
    if (!target) throw new NotFoundError('User not found');

    const [projects, jobs, transactions] = await Promise.all([
      Project.find({ userId: target._id }).sort({ createdAt: -1 }).limit(20),
      ProcessingJob.find({ userId: target._id }).sort({ createdAt: -1 }).limit(20),
      CreditTransaction.find({ userId: target._id }).sort({ createdAt: -1 }).limit(30),
    ]);

    res.json({
      success: true,
      data: { projects, jobs, transactions },
    });
  },

  async listJobs(req: Request, res: Response) {
    const filter: Record<string, any> = {};
    if (req.query.status) filter.status = String(req.query.status);

    const items = await ProcessingJob.find(filter)
      .populate('userId', 'name email')
      .populate('projectId', 'title')
      .sort({ createdAt: -1 })
      .limit(80);

    res.json({ success: true, data: { items, total: items.length } });
  },

  async listPayments(_req: Request, res: Response) {
    const items = await Payment.find({})
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .limit(80);

    res.json({ success: true, data: { items } });
  },

  async refundPayment(req: Request, res: Response) {
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw new NotFoundError('Payment record not found');
    if (payment.status !== 'verified' && payment.status !== 'captured') {
      throw new BadRequestError('Only verified/captured payments can be refunded');
    }

    const reason = String(req.body.reason || 'Administrative refund').trim();
    payment.status = 'refunded';
    payment.refundAmountPaise = payment.amountPaise;
    payment.refundReason = reason;
    payment.refundedAt = new Date();
    await payment.save();

    await reverseRefundedCredits({
      userId: payment.userId,
      paymentId: String(payment._id),
      credits: payment.creditsGranted,
      reason,
      adminId: req.user!._id,
    });

    await recordAdminAudit(req, {
      action: 'PAYMENT_REFUNDED',
      targetType: 'payment',
      targetId: String(payment._id),
      after: { status: 'refunded', refundAmountPaise: payment.amountPaise },
      reason,
    });

    res.json({ success: true, data: { payment } });
  },

  async listPackages(_req: Request, res: Response) {
    const items = await CreditPackage.find({}).sort({ sortOrder: 1 });
    res.json({ success: true, data: { items } });
  },

  async createPackage(req: Request, res: Response) {
    const slug =
      String(req.body.slug || req.body.name || 'pack')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-') + `-${Date.now().toString(36)}`;

    const item = await CreditPackage.create({
      name: String(req.body.name || 'Custom Credit Package').trim(),
      slug,
      description: String(req.body.description || ''),
      credits: Math.max(1, Number(req.body.credits || 100)),
      amountPaise: Math.max(100, Number(req.body.amountPaise || 49900)),
      currency: 'INR',
      popular: Boolean(req.body.popular),
      active: req.body.active !== false,
      features: Array.isArray(req.body.features)
        ? req.body.features
        : [`${req.body.credits || 100} processing credits`, 'All aspect ratios & AI copy'],
      sortOrder: Number(req.body.sortOrder || 5),
    });

    await recordAdminAudit(req, {
      action: 'CREDIT_PACKAGE_CREATED',
      targetType: 'package',
      targetId: String(item._id),
      after: { name: item.name, credits: item.credits, amountPaise: item.amountPaise },
    });

    res.status(201).json({ success: true, data: { item } });
  },

  async updatePackage(req: Request, res: Response) {
    const item = await CreditPackage.findById(req.params.id);
    if (!item) throw new NotFoundError('Credit package not found');

    const before = {
      name: item.name,
      credits: item.credits,
      amountPaise: item.amountPaise,
      active: item.active,
    };

    if (req.body.name !== undefined) item.name = String(req.body.name).trim();
    if (req.body.description !== undefined) item.description = String(req.body.description);
    if (req.body.credits !== undefined) item.credits = Math.max(1, Number(req.body.credits));
    if (req.body.amountPaise !== undefined)
      item.amountPaise = Math.max(100, Number(req.body.amountPaise));
    if (req.body.popular !== undefined) item.popular = Boolean(req.body.popular);
    if (req.body.active !== undefined) item.active = Boolean(req.body.active);
    if (Array.isArray(req.body.features)) item.features = req.body.features;

    await item.save();

    await recordAdminAudit(req, {
      action: 'CREDIT_PACKAGE_UPDATED',
      targetType: 'package',
      targetId: String(item._id),
      before,
      after: {
        name: item.name,
        credits: item.credits,
        amountPaise: item.amountPaise,
        active: item.active,
      },
    });

    res.json({ success: true, data: { item } });
  },

  async getConfig(_req: Request, res: Response) {
    const config = await getOrCreateSystemConfig();
    res.json({ success: true, data: { config } });
  },

  async updateConfig(req: Request, res: Response) {
    const config = await getOrCreateSystemConfig();
    const before = {
      welcomeCredits: config.welcomeCredits,
      creditsPerMinuteProcessed: config.creditsPerMinuteProcessed,
      maxUploadSizeMb: config.maxUploadSizeMb,
    };

    if (req.body.welcomeCredits !== undefined)
      config.welcomeCredits = Math.max(0, Number(req.body.welcomeCredits));
    if (req.body.creditsPerMinuteProcessed !== undefined)
      config.creditsPerMinuteProcessed = Math.max(1, Number(req.body.creditsPerMinuteProcessed));
    if (req.body.minCreditsPerJob !== undefined)
      config.minCreditsPerJob = Math.max(1, Number(req.body.minCreditsPerJob));
    if (req.body.maxUploadSizeMb !== undefined)
      config.maxUploadSizeMb = Math.max(5, Number(req.body.maxUploadSizeMb));
    if (req.body.maxVideoDurationSec !== undefined)
      config.maxVideoDurationSec = Math.max(30, Number(req.body.maxVideoDurationSec));
    if (req.body.maxClipsPerJob !== undefined)
      config.maxClipsPerJob = Math.floor(Math.max(1, Math.min(20, Number(req.body.maxClipsPerJob))));
    if (req.body.supportedPlatforms && typeof req.body.supportedPlatforms === 'object') {
      config.supportedPlatforms = req.body.supportedPlatforms;
      config.markModified('supportedPlatforms');
    }

    await config.save();

    await recordAdminAudit(req, {
      action: 'SYSTEM_CONFIG_UPDATED',
      targetType: 'system_config',
      before,
      after: {
        welcomeCredits: config.welcomeCredits,
        creditsPerMinuteProcessed: config.creditsPerMinuteProcessed,
        maxUploadSizeMb: config.maxUploadSizeMb,
      },
    });

    res.json({ success: true, data: { config } });
  },

  async listAuditLogs(_req: Request, res: Response) {
    const [items, errorLogs] = await Promise.all([
      AdminAuditLog.find({}).sort({ createdAt: -1 }).limit(80),
      ProcessingJob.find({ status: 'failed' })
        .select('stage error createdAt updatedAt projectId userId')
        .sort({ updatedAt: -1 })
        .limit(40),
    ]);

    res.json({
      success: true,
      data: { items, errorLogs },
    });
  },
};
