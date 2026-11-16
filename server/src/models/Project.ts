import mongoose, { Document, Schema, Types } from 'mongoose';
import {
  DEFAULT_PROCESSING_SETTINGS,
  type ProjectProcessingSettings,
} from '@clipforge/shared';

export interface IProject extends Document {
  userId: Types.ObjectId;
  title: string;
  description?: string;
  sourceType: 'upload' | 'url';
  sourceUrl?: string;
  sourcePlatform: 'upload' | 'youtube' | 'instagram' | 'facebook' | 'tiktok' | 'direct_mp4';
  status: 'draft' | 'importing' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  settings: ProjectProcessingSettings;
  videoId?: Types.ObjectId;
  latestJobId?: Types.ObjectId;
  clipsCount: number;
  creditsReserved: number;
  creditsConsumed: number;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    description: { type: String, trim: true, maxlength: 1000 },
    sourceType: { type: String, enum: ['upload', 'url'], default: 'upload' },
    sourceUrl: { type: String, trim: true },
    sourcePlatform: {
      type: String,
      enum: ['upload', 'youtube', 'instagram', 'facebook', 'tiktok', 'direct_mp4'],
      default: 'upload',
    },
    status: {
      type: String,
      enum: ['draft', 'importing', 'queued', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'draft',
      index: true,
    },
    settings: {
      type: Schema.Types.Mixed,
      default: () => ({ ...DEFAULT_PROCESSING_SETTINGS }),
    },
    videoId: { type: Schema.Types.ObjectId, ref: 'Video' },
    latestJobId: { type: Schema.Types.ObjectId, ref: 'ProcessingJob' },
    clipsCount: { type: Number, default: 0 },
    creditsReserved: { type: Number, default: 0 },
    creditsConsumed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

projectSchema.index({ userId: 1, createdAt: -1 });

export const Project = mongoose.model<IProject>('Project', projectSchema);
