import crypto from 'crypto';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { CreditPackage, Payment, type IPayment } from '../models';
import {
  BadRequestError,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
} from '../utils/errors';
import { grantPurchasedCredits, reverseRefundedCredits } from './walletService';

export function isRazorpayLiveOrTestConfigured(): boolean {
  return Boolean(
    env.RAZORPAY_KEY_ID &&
      env.RAZORPAY_KEY_ID.trim().length > 5 &&
      env.RAZORPAY_KEY_SECRET &&
      env.RAZORPAY_KEY_SECRET.trim().length > 5
  );
}

export function isSandboxSimulatorAllowed(): boolean {
  return env.NODE_ENV !== 'production' && env.PAYMENT_SANDBOX_SIMULATOR;
}

function computeHmacSha256Hex(payload: string | Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(sigA: string, sigB: string): boolean {
  try {
    if (
      !sigA ||
      !sigB ||
      sigA.length !== sigB.length ||
      !/^[0-9a-f]+$/i.test(sigA) ||
      !/^[0-9a-f]+$/i.test(sigB)
    ) {
      return false;
    }
    const bufA = Buffer.from(sigA, 'hex');
    const bufB = Buffer.from(sigB, 'hex');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export async function createPaymentOrder(params: {
  userId: Types.ObjectId;
  packageId: string;
  useSandboxSimulator?: boolean;
}) {
  const pkg = await CreditPackage.findById(params.packageId);
  if (!pkg || !pkg.active) {
    throw new NotFoundError('Selected credit package is unavailable');
  }

  // Path 1: Real Razorpay Orders API
  if (isRazorpayLiveOrTestConfigured() && !params.useSandboxSimulator) {
    const authHeader = Buffer.from(
      `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`
    ).toString('base64');

    const receipt = `cf_${String(params.userId).slice(-6)}_${Date.now()}`;
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${authHeader}`,
      },
      body: JSON.stringify({
        amount: pkg.amountPaise,
        currency: pkg.currency || 'INR',
        receipt,
        notes: {
          userId: String(params.userId),
          packageId: String(pkg._id),
          credits: String(pkg.credits),
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new BadRequestError(
        `Razorpay order creation failed (${res.status}): ${errBody.slice(0, 180)}`,
        'RAZORPAY_ORDER_FAILED'
      );
    }

    const rzpOrder: any = await res.json();
    const payment = await Payment.create({
      userId: params.userId,
      packageId: pkg._id,
      packageSnapshot: {
        name: pkg.name,
        credits: pkg.credits,
        amountPaise: pkg.amountPaise,
        currency: pkg.currency,
      },
      provider: 'razorpay',
      isDevelopmentMode: false,
      razorpayOrderId: rzpOrder.id,
      amountPaise: pkg.amountPaise,
      currency: pkg.currency,
      creditsGranted: pkg.credits,
      status: 'created',
    });

    return {
      paymentId: String(payment._id),
      orderId: payment.razorpayOrderId,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      keyId: env.RAZORPAY_KEY_ID,
      isDevelopmentMode: false,
    };
  }

  // Path 2: Explicitly Labelled Development Sandbox Simulator
  if (params.useSandboxSimulator && isSandboxSimulatorAllowed()) {
    const orderId = `order_sandbox_${crypto.randomBytes(8).toString('hex')}`;
    const sandboxPaymentId = `pay_sandbox_${crypto.randomBytes(8).toString('hex')}`;
    const sandboxSignaturePreview = computeHmacSha256Hex(
      `${orderId}|${sandboxPaymentId}`,
      env.PAYMENT_SANDBOX_SECRET
    );

    const payment = await Payment.create({
      userId: params.userId,
      packageId: pkg._id,
      packageSnapshot: {
        name: pkg.name,
        credits: pkg.credits,
        amountPaise: pkg.amountPaise,
        currency: pkg.currency,
      },
      provider: 'razorpay_sandbox_dev',
      isDevelopmentMode: true,
      razorpayOrderId: orderId,
      amountPaise: pkg.amountPaise,
      currency: pkg.currency,
      creditsGranted: pkg.credits,
      status: 'created',
    });

    return {
      paymentId: String(payment._id),
      orderId,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      keyId: 'rzp_dev_sandbox_simulator',
      isDevelopmentMode: true,
      sandboxPaymentId,
      sandboxSignaturePreview,
    };
  }

  throw new NotConfiguredError(
    'Razorpay credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are NOT CONFIGURED. Add them to .env to accept live INR payments.',
    'RAZORPAY_NOT_CONFIGURED'
  );
}

export async function verifyRazorpayClientPayment(params: {
  userId: Types.ObjectId;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}) {
  const payment = await Payment.findOne({ razorpayOrderId: params.razorpayOrderId });
  if (!payment) {
    throw new NotFoundError('Payment order record not found');
  }
  if (String(payment.userId) !== String(params.userId)) {
    throw new ForbiddenError('Cannot verify another user’s payment order');
  }

  // Idempotent return if already verified with same payment ID
  if (
    payment.status === 'verified' &&
    payment.razorpaySignatureVerified &&
    payment.razorpayPaymentId === params.razorpayPaymentId
  ) {
    const wallet = await grantPurchasedCredits({
      userId: payment.userId,
      paymentId: String(payment._id),
      credits: payment.creditsGranted,
      idempotencyKey: `payment:grant:${String(payment._id)}`,
      description: `${
        payment.isDevelopmentMode ? '[DEV SANDBOX] ' : ''
      }Purchased ${payment.packageSnapshot.name}`,
    });
    return { payment, wallet };
  }

  const secret =
    payment.provider === 'razorpay_sandbox_dev'
      ? env.PAYMENT_SANDBOX_SECRET
      : env.RAZORPAY_KEY_SECRET;

  if (!secret) {
    throw new NotConfiguredError('Payment verification secret is not configured');
  }

  const expectedSignature = computeHmacSha256Hex(
    `${params.razorpayOrderId}|${params.razorpayPaymentId}`,
    secret
  );

  if (!safeEqualHex(params.razorpaySignature, expectedSignature)) {
    payment.status = 'failed';
    payment.failureReason = 'Invalid HMAC-SHA256 payment signature';
    await payment.save();
    throw new BadRequestError(
      'Payment signature verification failed',
      'INVALID_PAYMENT_SIGNATURE'
    );
  }

  payment.razorpayPaymentId = params.razorpayPaymentId;
  payment.razorpaySignatureVerified = true;
  payment.status = 'verified';
  await payment.save();

  const wallet = await grantPurchasedCredits({
    userId: payment.userId,
    paymentId: String(payment._id),
    credits: payment.creditsGranted,
    idempotencyKey: `payment:grant:${String(payment._id)}`,
    description: `${
      payment.isDevelopmentMode ? '[DEV SANDBOX] ' : ''
    }Purchased ${payment.packageSnapshot.name} (${payment.creditsGranted} credits)`,
  });

  return { payment, wallet };
}

export async function processRazorpayWebhook(params: {
  rawBody: Buffer;
  signatureHeader: string;
  eventIdHeader?: string;
}): Promise<{ processed: boolean; duplicate: boolean; status: string }> {
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET || (isSandboxSimulatorAllowed() ? env.PAYMENT_SANDBOX_SECRET : '');
  if (!webhookSecret) {
    throw new NotConfiguredError(
      'RAZORPAY_WEBHOOK_SECRET is NOT CONFIGURED',
      'WEBHOOK_NOT_CONFIGURED'
    );
  }

  const expectedSig = computeHmacSha256Hex(params.rawBody, webhookSecret);
  if (!safeEqualHex(params.signatureHeader, expectedSig)) {
    throw new BadRequestError('Invalid Razorpay webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
  }

  const payload = JSON.parse(params.rawBody.toString('utf8'));
  const eventType: string = payload?.event || '';
  const eventId =
    params.eventIdHeader ||
    crypto.createHash('sha256').update(params.rawBody).digest('hex');

  const paymentEntity = payload?.payload?.payment?.entity;
  const refundEntity = payload?.payload?.refund?.entity;
  const orderId: string | undefined = paymentEntity?.order_id;

  if (!orderId && !refundEntity?.payment_id) {
    return { processed: false, duplicate: false, status: 'ignored_no_order_ref' };
  }

  const payment: IPayment | null = orderId
    ? await Payment.findOne({ razorpayOrderId: orderId })
    : await Payment.findOne({ razorpayPaymentId: refundEntity.payment_id });

  if (!payment) {
    return { processed: false, duplicate: false, status: 'order_not_found' };
  }

  if (payment.webhookEventIds.includes(eventId)) {
    return { processed: true, duplicate: true, status: payment.status };
  }

  // Atomically append eventId to prevent concurrent replay
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, webhookEventIds: { $ne: eventId } },
    { $push: { webhookEventIds: eventId } },
    { new: true }
  );

  if (!claimed) {
    return { processed: true, duplicate: true, status: payment.status };
  }

  if (eventType === 'payment.captured' || eventType === 'order.paid') {
    claimed.razorpayPaymentId = paymentEntity?.id || claimed.razorpayPaymentId;
    claimed.razorpaySignatureVerified = true;
    claimed.status = 'verified';
    await claimed.save();

    await grantPurchasedCredits({
      userId: claimed.userId,
      paymentId: String(claimed._id),
      credits: claimed.creditsGranted,
      idempotencyKey: `payment:grant:${String(claimed._id)}`,
      description: `${
        claimed.isDevelopmentMode ? '[DEV SANDBOX] ' : ''
      }Webhook captured ${claimed.packageSnapshot.name}`,
    });
  } else if (eventType === 'payment.failed') {
    if (claimed.status !== 'verified') {
      claimed.status = 'failed';
      claimed.failureReason = paymentEntity?.error_description || 'Payment failed at gateway';
      await claimed.save();
    }
  } else if (eventType === 'refund.processed') {
    claimed.status = 'refunded';
    claimed.refundAmountPaise = refundEntity?.amount || claimed.amountPaise;
    claimed.refundReason = 'Razorpay webhook refund.processed';
    claimed.refundedAt = new Date();
    await claimed.save();

    await reverseRefundedCredits({
      userId: claimed.userId,
      paymentId: String(claimed._id),
      credits: claimed.creditsGranted,
      reason: 'Razorpay webhook refund',
    });
  }

  return { processed: true, duplicate: false, status: claimed.status };
}
