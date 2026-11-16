import mongoose, { Document, Schema, Types } from 'mongoose';

export type CreditTransactionType =
  | 'welcome_bonus'
  | 'purchase'
  | 'reserve'
  | 'deduct'
  | 'release_reserve'
  | 'refund'
  | 'admin_adjustment';

export interface ICreditTransaction extends Document {
  userId: Types.ObjectId;
  walletId: Types.ObjectId;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  reservedAfter: number;
  referenceType: 'signup' | 'job' | 'payment' | 'admin';
  referenceId?: string;
  idempotencyKey: string;
  description: string;
  metadata?: Record<string, unknown>;
  createdBy?: Types.ObjectId;
  createdAt: Date;
}

const creditTransactionSchema = new Schema<ICreditTransaction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true, immutable: true },
    walletId: {
      type: Schema.Types.ObjectId,
      ref: 'CreditWallet',
      required: true,
      index: true,
      immutable: true,
    },
    type: {
      type: String,
      enum: [
        'welcome_bonus',
        'purchase',
        'reserve',
        'deduct',
        'release_reserve',
        'refund',
        'admin_adjustment',
      ],
      required: true,
      immutable: true,
    },
    amount: { type: Number, required: true, immutable: true },
    balanceAfter: { type: Number, required: true, immutable: true },
    reservedAfter: { type: Number, required: true, immutable: true },
    referenceType: {
      type: String,
      enum: ['signup', 'job', 'payment', 'admin'],
      required: true,
      immutable: true,
    },
    referenceId: { type: String, index: true, immutable: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true, immutable: true },
    description: { type: String, required: true, immutable: true },
    metadata: { type: Schema.Types.Mixed, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

creditTransactionSchema.index({ userId: 1, createdAt: -1 });

// Enforce strict ledger immutability: block updates and deletions
const blockMutation = function (next: (err?: Error) => void) {
  next(new Error('CreditTransaction ledger entries are strictly immutable.'));
};

creditTransactionSchema.pre('updateOne', blockMutation);
creditTransactionSchema.pre('updateMany', blockMutation);
creditTransactionSchema.pre('findOneAndUpdate', blockMutation);
creditTransactionSchema.pre('deleteOne', blockMutation);
creditTransactionSchema.pre('deleteMany', blockMutation);
creditTransactionSchema.pre('findOneAndDelete', blockMutation);

export const CreditTransaction = mongoose.model<ICreditTransaction>(
  'CreditTransaction',
  creditTransactionSchema
);
