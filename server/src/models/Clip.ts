import mongoose, { Document, Schema, Types } from 'mongoose';
import { DEFAULT_CAPTION_STYLE, type AspectRatio, type CaptionStyleConfig } from '@clipforge/shared';

export type MetadataFallbackCode =
  | 'not_configured'
  | 'http_error'
  | 'network_error'
  | 'malformed_response'
  | 'incomplete_response'
  | 'provider_error';

export interface IMetadataFallbackReason {
  provider: 'gemini' | 'openai_compatible';
  code: MetadataFallbackCode;
  message: string;
  statusCode?: number;
}

export interface IClipMetadata {
  titleOptions: string[];
  descriptions: {
    youtubeShorts: string;
    instagramReels: string;
    tiktok: string;
    facebookReels: string;
  };
  hashtags: string[];
  keywords: string[];
  openingHook: string;
  thumbnailText: string;
  category: string;
  suggestedPostingWindow: {
    configured: boolean;
    note: string;
    windowsByPlatform?: Record<string, string>;
  };
  generatedBy: 'gemini' | 'openai_compatible' | 'deterministic_nlp';
  fallbackReason?: IMetadataFallbackReason;
}

export interface IClip extends Document {
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  videoId: Types.ObjectId;
  jobId: Types.ObjectId;
  title: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  aspectRatio: AspectRatio;
  transcript: string;
  selectionReason: string;
  category: string;
  engagementScore: number;
  storageKey: string;
  storageProvider: 'local' | 's3';
  thumbnailKey?: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  captionStyle: CaptionStyleConfig;
  editingApplied: string[];
  metadata: IClipMetadata;
  createdAt: Date;
  updatedAt: Date;
}

const clipSchema = new Schema<IClip>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    videoId: { type: Schema.Types.ObjectId, ref: 'Video', required: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'ProcessingJob', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    startSec: { type: Number, required: true },
    endSec: { type: Number, required: true },
    durationSec: { type: Number, required: true },
    aspectRatio: { type: String, enum: ['9:16', '1:1', '16:9'], default: '9:16', index: true },
    transcript: { type: String, default: '' },
    selectionReason: { type: String, default: '' },
    category: { type: String, default: 'insight' },
    engagementScore: { type: Number, min: 0, max: 100, default: 70 },
    storageKey: { type: String, required: true },
    storageProvider: { type: String, enum: ['local', 's3'], default: 'local' },
    thumbnailKey: { type: String },
    fileSizeBytes: { type: Number, default: 0 },
    width: { type: Number, default: 1080 },
    height: { type: Number, default: 1920 },
    status: {
      type: String,
      enum: ['pending', 'rendering', 'ready', 'failed'],
      default: 'pending',
      index: true,
    },
    captionStyle: { type: Schema.Types.Mixed, default: () => ({ ...DEFAULT_CAPTION_STYLE }) },
    editingApplied: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

clipSchema.index({ userId: 1, createdAt: -1 });
clipSchema.index({ projectId: 1, startSec: 1 });

export const Clip = mongoose.model<IClip>('Clip', clipSchema);
