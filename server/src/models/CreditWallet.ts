import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ICreditWallet extends Document {
  userId: Types.ObjectId;
  availableCredits: number;
  reservedCredits: number;
  lifetimeEarnedCredits: number;
  lifetimePurchasedCredits: number;
  lifetimeUsedCredits: number;
  lifetimeRefundedCredits: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const creditWalletSchema = new Schema<ICreditWallet>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    availableCredits: { type: Number, required: true, min: 0, default: 0 },
    reservedCredits: { type: Number, required: true, min: 0, default: 0 },
    lifetimeEarnedCredits: { type: Number, default: 0 },
    lifetimePurchasedCredits: { type: Number, default: 0 },
    lifetimeUsedCredits: { type: Number, default: 0 },
    lifetimeRefundedCredits: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
  },
  { timestamps: true }
);

export const CreditWallet = mongoose.model<ICreditWallet>('CreditWallet', creditWalletSchema);
