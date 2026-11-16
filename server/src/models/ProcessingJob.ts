import mongoose, { Document, Schema, Types } from 'mongoose';
import type { PipelineStage } from '@clipforge/shared';

export interface IProcessingJob extends Document {
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  videoId?: Types.ObjectId;
  targetClipId?: Types.ObjectId;
  type: 'full_pipeline' | 'regenerate_clip';
  overrides?: Record<string, unknown>;
  queueMode: 'bullmq' | 'local_worker';
  bullJobId?: string;
  idempotencyKey?: string;
  stage: PipelineStage;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progressPercent: number;
  currentMessage: string;
  stageHistory: Array<{
    stage: string;
    startedAt: Date;
    completedAt?: Date;
    message?: string;
  }>;
  diagnostics: {
    aiProvider: string;
    aiConfigured: boolean;
    whisperStatus: string;
    ffmpegAvailable: boolean;
    warnings: string[];
  };
  chunkProgress?: {
    enabled: boolean;
    chunkDurationSec: number;
    chunkOverlapSec: number;
    totalChunks: number;
    completedChunks: number;
    currentChunkIndex: number;
    checkpointPath?: string;
  };
  youtubeImport?: {
    videoId: string;
    canonicalUrl: string;
    authorizedMediaUrl?: string;
    metadata?: Record<string, unknown>;
  };
  attempts: number;
  maxAttempts: number;
  creditsReserved: number;
  creditsDeducted: number;
  creditReservationReleased: boolean;
  error?: {
    code: string;
    message: string;
    stage: string;
  };
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const processingJobSchema = new Schema<IProcessingJob>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    videoId: { type: Schema.Types.ObjectId, ref: 'Video' },
    targetClipId: { type: Schema.Types.ObjectId, ref: 'Clip' },
    type: { type: String, enum: ['full_pipeline', 'regenerate_clip'], default: 'full_pipeline' },
    overrides: { type: Schema.Types.Mixed },
    queueMode: { type: String, enum: ['bullmq', 'local_worker'], default: 'local_worker' },
    bullJobId: { type: String },
    idempotencyKey: { type: String, unique: true, sparse: true },
    stage: { type: String, default: 'importing' },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    progressPercent: { type: Number, min: 0, max: 100, default: 0 },
    currentMessage: { type: String, default: 'Job queued for background worker' },
    stageHistory: { type: [Schema.Types.Mixed] as any, default: [] },
    diagnostics: {
      aiProvider: { type: String, default: 'gemini' },
      aiConfigured: { type: Boolean, default: false },
      whisperStatus: { type: String, default: 'pending' },
      ffmpegAvailable: { type: Boolean, default: true },
      warnings: { type: [String], default: [] },
    },
    chunkProgress: { type: Schema.Types.Mixed },
    youtubeImport: { type: Schema.Types.Mixed },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    creditsReserved: { type: Number, default: 0 },
    creditsDeducted: { type: Number, default: 0 },
    creditReservationReleased: { type: Boolean, default: false },
    error: { type: Schema.Types.Mixed },
    startedAt: { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
  },
  { timestamps: true }
);

processingJobSchema.index({ status: 1, createdAt: -1 });
processingJobSchema.index({ userId: 1, createdAt: -1 });

export const ProcessingJob = mongoose.model<IProcessingJob>('ProcessingJob', processingJobSchema);
