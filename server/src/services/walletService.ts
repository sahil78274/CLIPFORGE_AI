import { Types } from 'mongoose';
import {
  CreditTransaction,
  CreditWallet,
  Notification,
  getOrCreateSystemConfig,
  type ICreditWallet,
} from '../models';
import { BadRequestError, InsufficientCreditsError } from '../utils/errors';

// Per-user in-process mutex to serialize wallet mutations cleanly alongside DB unique idempotency keys
const walletLocks = new Map<string, Promise<unknown>>();

async function withUserWalletLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = walletLocks.get(userId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((res) => {
    release = res;
  });
  walletLocks.set(
    userId,
    prev.then(() => current, () => current)
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (walletLocks.get(userId) === current) {
      walletLocks.delete(userId);
    }
  }
}

async function ensureUserWalletUnlocked(
  uid: Types.ObjectId,
  grantWelcome = false
): Promise<ICreditWallet> {
  let wallet = await CreditWallet.findOne({ userId: uid });
  if (!wallet) {
    const cfg = await getOrCreateSystemConfig();
    const welcome = grantWelcome ? cfg.welcomeCredits : 0;
    wallet = await CreditWallet.create({
      userId: uid,
      availableCredits: welcome,
      reservedCredits: 0,
      lifetimeEarnedCredits: welcome,
    });

    if (welcome > 0) {
      const idem = `welcome:${String(uid)}`;
      const existingTx = await CreditTransaction.findOne({ idempotencyKey: idem });
      if (!existingTx) {
        await CreditTransaction.create({
          userId: uid,
          walletId: wallet._id,
          type: 'welcome_bonus',
          amount: welcome,
          balanceAfter: wallet.availableCredits,
          reservedAfter: wallet.reservedCredits,
          referenceType: 'signup',
          referenceId: String(uid),
          idempotencyKey: idem,
          description: `Welcome credit grant (${welcome} credits)`,
        });
        await Notification.create({
          userId: uid,
          type: 'welcome',
          title: 'Welcome to ClipForge AI',
          message: `${welcome} free processing credits have been added to your Credit Wallet.`,
          actionUrl: '/dashboard/create',
        });
      }
    }
  }
  return wallet;
}

export async function ensureUserWallet(
  userId: Types.ObjectId | string,
  grantWelcome = false
): Promise<ICreditWallet> {
  const uid = new Types.ObjectId(String(userId));
  return withUserWalletLock(String(uid), () => ensureUserWalletUnlocked(uid, grantWelcome));
}

export async function calculateJobCreditCost(
  durationSec: number,
  clipCount: number
): Promise<number> {
  const cfg = await getOrCreateSystemConfig();
  const minutes = Math.max(1, Math.ceil(Math.max(1, durationSec) / 60));
  const extraClips = Math.max(0, clipCount - 3) * 2;
  return Math.max(cfg.minCreditsPerJob, minutes * cfg.creditsPerMinuteProcessed + extraClips);
}

export async function reserveCreditsForJob(params: {
  userId: Types.ObjectId | string;
  jobId: Types.ObjectId | string;
  amount: number;
  description: string;
}): Promise<ICreditWallet> {
  const uid = new Types.ObjectId(String(params.userId));
  const jid = String(params.jobId);
  const amount = Math.max(1, Math.round(params.amount));
  const idempotencyKey = `reserve:job:${jid}`;

  return withUserWalletLock(String(uid), async () => {
    const existing = await CreditTransaction.findOne({ idempotencyKey });
    const wallet = await CreditWallet.findOne({ userId: uid });
    if (!wallet) {
      throw new InsufficientCreditsError('Wallet not initialized');
    }
    if (existing) {
      return wallet;
    }

    if (wallet.availableCredits < amount) {
      throw new InsufficientCreditsError(
        `Insufficient available credits (${wallet.availableCredits} available, ${amount} required).`
      );
    }

    const updated = await CreditWallet.findOneAndUpdate(
      { _id: wallet._id, availableCredits: { $gte: amount } },
      {
        $inc: {
          availableCredits: -amount,
          reservedCredits: amount,
        },
      },
      { new: true }
    );

    if (!updated) {
      throw new InsufficientCreditsError();
    }

    await CreditTransaction.create({
      userId: uid,
      walletId: updated._id,
      type: 'reserve',
      amount: -amount,
      balanceAfter: updated.availableCredits,
      reservedAfter: updated.reservedCredits,
      referenceType: 'job',
      referenceId: jid,
      idempotencyKey,
      description: params.description,
    });

    return updated;
  });
}

export async function settleReservedCredits(params: {
  userId: Types.ObjectId | string;
  jobId: Types.ObjectId | string;
  reservedAmount: number;
  actualAmount: number;
  description: string;
}): Promise<{ wallet: ICreditWallet; deducted: number }> {
  const uid = new Types.ObjectId(String(params.userId));
  const jid = String(params.jobId);
  const settleKey = `settle:job:${jid}`;

  return withUserWalletLock(String(uid), async () => {
    const wallet = await CreditWallet.findOne({ userId: uid });
    if (!wallet) throw new BadRequestError('Wallet missing');

    const alreadySettled = await CreditTransaction.findOne({ idempotencyKey: settleKey });
    if (alreadySettled) {
      return {
        wallet,
        deducted: Math.min(params.reservedAmount, Math.max(0, params.actualAmount)),
      };
    }

    const releaseableReserve = Math.min(wallet.reservedCredits, Math.max(0, params.reservedAmount));
    const deducted = Math.min(releaseableReserve, Math.max(0, Math.round(params.actualAmount)));
    const unusedRefundToAvailable = Math.max(0, releaseableReserve - deducted);

    const updated = await CreditWallet.findOneAndUpdate(
      { _id: wallet._id },
      {
        $inc: {
          reservedCredits: -releaseableReserve,
          availableCredits: unusedRefundToAvailable,
          lifetimeUsedCredits: deducted,
        },
      },
      { new: true }
    );

    if (!updated) throw new BadRequestError('Failed to settle wallet');

    await CreditTransaction.create({
      userId: uid,
      walletId: updated._id,
      type: 'deduct',
      amount: unusedRefundToAvailable,
      balanceAfter: updated.availableCredits,
      reservedAfter: updated.reservedCredits,
      referenceType: 'job',
      referenceId: jid,
      idempotencyKey: settleKey,
      description: `${params.description} (settled ${deducted} reserved credits${
        unusedRefundToAvailable > 0 ? `, returned ${unusedRefundToAvailable} unused` : ''
      })`,
      metadata: {
        reservedAmount: params.reservedAmount,
        deducted,
        unusedRefundToAvailable,
      },
    });

    return { wallet: updated, deducted };
  });
}

export async function releaseReservedCredits(params: {
  userId: Types.ObjectId | string;
  jobId: Types.ObjectId | string;
  reservedAmount: number;
  reason: string;
}): Promise<ICreditWallet> {
  const uid = new Types.ObjectId(String(params.userId));
  const jid = String(params.jobId);
  const releaseKey = `release:job:${jid}`;
  const settleKey = `settle:job:${jid}`;

  return withUserWalletLock(String(uid), async () => {
    const wallet = await CreditWallet.findOne({ userId: uid });
    if (!wallet) throw new BadRequestError('Wallet missing');

    const existingRelease = await CreditTransaction.findOne({
      idempotencyKey: { $in: [releaseKey, settleKey] },
    });
    if (existingRelease || params.reservedAmount <= 0) {
      return wallet;
    }

    const toRelease = Math.min(wallet.reservedCredits, Math.max(0, params.reservedAmount));
    if (toRelease <= 0) return wallet;

    const updated = await CreditWallet.findOneAndUpdate(
      { _id: wallet._id },
      {
        $inc: {
          reservedCredits: -toRelease,
          availableCredits: toRelease,
        },
      },
      { new: true }
    );

    if (!updated) return wallet;

    await CreditTransaction.create({
      userId: uid,
      walletId: updated._id,
      type: 'release_reserve',
      amount: toRelease,
      balanceAfter: updated.availableCredits,
      reservedAfter: updated.reservedCredits,
      referenceType: 'job',
      referenceId: jid,
      idempotencyKey: releaseKey,
      description: `Released ${toRelease} reserved credits (${params.reason})`,
    });

    return updated;
  });
}

export async function grantPurchasedCredits(params: {
  userId: Types.ObjectId | string;
  paymentId: string;
  credits: number;
  idempotencyKey: string;
  description: string;
}): Promise<ICreditWallet> {
  const uid = new Types.ObjectId(String(params.userId));
  return withUserWalletLock(String(uid), async () => {
    const existing = await CreditTransaction.findOne({ idempotencyKey: params.idempotencyKey });
    const wallet = await ensureUserWalletUnlocked(uid, false);
    if (existing) return wallet;

    const updated = await CreditWallet.findOneAndUpdate(
      { _id: wallet._id },
      {
        $inc: {
          availableCredits: params.credits,
          lifetimePurchasedCredits: params.credits,
        },
      },
      { new: true }
    );
    if (!updated) throw new BadRequestError('Wallet update failed');

    await CreditTransaction.create({
      userId: uid,
      walletId: updated._id,
      type: 'purchase',
      amount: params.credits,
      balanceAfter: updated.availableCredits,
      reservedAfter: updated.reservedCredits,
      referenceType: 'payment',
      referenceId: params.paymentId,
      idempotencyKey: params.idempotencyKey,
      description: params.description,
    });

    await Notification.create({
      userId: uid,
      type: 'credits_added',
      title: 'Credits Added to Wallet',
      message: `${params.credits} credits have been credited to your account.`,
      actionUrl: '/dashboard/wallet',
    });

    return updated;
  });
}

export async function reverseRefundedCredits(params: {
  userId: Types.ObjectId | string;
  paymentId: string;
  credits: number;
  reason: string;
  adminId?: Types.ObjectId;
}): Promise<ICreditWallet> {
  const uid = new Types.ObjectId(String(params.userId));
  const idem = `refund:payment:${params.paymentId}`;

  return withUserWalletLock(String(uid), async () => {
    const existing = await CreditTransaction.findOne({ idempotencyKey: idem });
    const wallet = await ensureUserWalletUnlocked(uid, false);
    if (existing) return wallet;

    const deductible = Math.min(wallet.availableCredits, Math.max(0, params.credits));
    const updated = await CreditWallet.findOneAndUpdate(
      { _id: wallet._id },
      {
        $inc: {
          availableCredits: -deductible,
          lifetimeRefundedCredits: deductible,
        },
      },
      { new: true }
    );
    if (!updated) throw new BadRequestError('Refund wallet update failed');

    await CreditTransaction.create({
      userId: uid,
      walletId: updated._id,
      type: 'refund',
      amount: -deductible,
      balanceAfter: updated.availableCredits,
      reservedAfter: updated.reservedCredits,
      referenceType: 'payment',
      referenceId: params.paymentId,
      idempotencyKey: idem,
      description: `Payment refund reversal (${params.reason})`,
      createdBy: params.adminId,
    });

    return updated;
  });
}

export async function adminAdjustCredits(params: {
  userId: Types.ObjectId | string;
  delta: number;
  reason: string;
  adminId: Types.ObjectId;
}): Promise<ICreditWallet> {
  const uid = new Types.ObjectId(String(params.userId));
  return withUserWalletLock(String(uid), async () => {
    const wallet = await ensureUserWalletUnlocked(uid, false);
    if (params.delta < 0 && wallet.availableCredits + params.delta < 0) {
      throw new BadRequestError(
        `Cannot deduct ${Math.abs(params.delta)} credits; user only has ${wallet.availableCredits} available.`
      );
    }

    const updated = await CreditWallet.findOneAndUpdate(
      { _id: wallet._id },
      {
        $inc: {
          availableCredits: params.delta,
          ...(params.delta > 0 ? { lifetimeEarnedCredits: params.delta } : {}),
        },
      },
      { new: true }
    );
    if (!updated) throw new BadRequestError('Wallet adjustment failed');

    await CreditTransaction.create({
      userId: uid,
      walletId: updated._id,
      type: 'admin_adjustment',
      amount: params.delta,
      balanceAfter: updated.availableCredits,
      reservedAfter: updated.reservedCredits,
      referenceType: 'admin',
      referenceId: String(params.adminId),
      idempotencyKey: `admin-adj:${String(uid)}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      description: `Admin adjustment: ${params.reason}`,
      createdBy: params.adminId,
    });

    return updated;
  });
}
