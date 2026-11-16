import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IPayment extends Document {
  userId: Types.ObjectId;
  packageId: Types.ObjectId;
  packageSnapshot: {
    name: string;
    credits: number;
    amountPaise: number;
    currency: string;
  };
  provider: 'razorpay' | 'razorpay_sandbox_dev';
  isDevelopmentMode: boolean;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignatureVerified: boolean;
  webhookEventIds: string[];
  amountPaise: number;
  currency: string;
  creditsGranted: number;
  status: 'created' | 'authorized' | 'captured' | 'verified' | 'failed' | 'refunded';
  refundAmountPaise?: number;
  refundReason?: string;
  refundedAt?: Date;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packageId: { type: Schema.Types.ObjectId, ref: 'CreditPackage', required: true },
    packageSnapshot: {
      name: { type: String, required: true },
      credits: { type: Number, required: true },
      amountPaise: { type: Number, required: true },
      currency: { type: String, default: 'INR' },
    },
    provider: {
      type: String,
      enum: ['razorpay', 'razorpay_sandbox_dev'],
      required: true,
    },
    isDevelopmentMode: { type: Boolean, default: false, index: true },
    razorpayOrderId: { type: String, required: true, unique: true, index: true },
    razorpayPaymentId: { type: String, unique: true, sparse: true },
    razorpaySignatureVerified: { type: Boolean, default: false },
    webhookEventIds: { type: [String], default: [] },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    creditsGranted: { type: Number, required: true },
    status: {
      type: String,
      enum: ['created', 'authorized', 'captured', 'verified', 'failed', 'refunded'],
      default: 'created',
      index: true,
    },
    refundAmountPaise: { type: Number },
    refundReason: { type: String },
    refundedAt: { type: Date },
    failureReason: { type: String },
  },
  { timestamps: true }
);

paymentSchema.index({ userId: 1, createdAt: -1 });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
