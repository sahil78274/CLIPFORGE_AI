import mongoose, { Document, Schema, Types } from 'mongoose';

export interface INotification extends Document {
  userId?: Types.ObjectId;
  type: 'job_completed' | 'job_failed' | 'credits_added' | 'welcome' | 'system' | 'security';
  title: string;
  message: string;
  actionUrl?: string;
  isRead: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    type: {
      type: String,
      enum: ['job_completed', 'job_failed', 'credits_added', 'welcome', 'system', 'security'],
      default: 'system',
    },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    actionUrl: { type: String },
    isRead: { type: Boolean, default: false, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
