import mongoose, { Document, Schema } from 'mongoose';
import { MAX_VIDEO_UPLOAD_SIZE_MB } from '@clipforge/shared';

export interface ICreditPackage extends Document {
  name: string;
  slug: string;
  description: string;
  credits: number;
  amountPaise: number;
  currency: string;
  popular: boolean;
  active: boolean;
  features: string[];
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const creditPackageSchema = new Schema<ICreditPackage>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    credits: { type: Number, required: true, min: 1 },
    amountPaise: { type: Number, required: true, min: 100 },
    currency: { type: String, default: 'INR' },
    popular: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    features: { type: [String], default: [] },
    sortOrder: { type: Number, default: 1 },
  },
  { timestamps: true }
);

export const CreditPackage = mongoose.model<ICreditPackage>('CreditPackage', creditPackageSchema);

export interface ISystemConfig extends Document {
  singletonKey: string;
  welcomeCredits: number;
  creditsPerMinuteProcessed: number;
  minCreditsPerJob: number;
  maxUploadSizeMb: number;
  uploadLimitMigrated: boolean;
  clipCountLimitMigrated: boolean;
  maxVideoDurationSec: number;
  chunkDurationSec: number;
  chunkOverlapSec: number;
  maxClipsPerJob: number;
  supportedPlatforms: Record<
    string,
    { enabled: boolean; directImportSupported: boolean; note: string }
  >;
  updatedAt: Date;
}

const systemConfigSchema = new Schema<ISystemConfig>(
  {
    singletonKey: { type: String, default: 'global', unique: true },
    welcomeCredits: { type: Number, default: 60 },
    creditsPerMinuteProcessed: { type: Number, default: 10 },
    minCreditsPerJob: { type: Number, default: 10 },
    maxUploadSizeMb: { type: Number, default: MAX_VIDEO_UPLOAD_SIZE_MB },
    uploadLimitMigrated: { type: Boolean, default: false },
    clipCountLimitMigrated: { type: Boolean, default: false },
    maxVideoDurationSec: { type: Number, default: 36000 },
    chunkDurationSec: { type: Number, default: 600 },
    chunkOverlapSec: { type: Number, default: 5 },
    maxClipsPerJob: {
      type: Number,
      default: 15,
      min: 1,
      max: 20,
      validate: { validator: Number.isInteger, message: 'Clip limit must be an integer' },
    },
    supportedPlatforms: {
      type: Schema.Types.Mixed,
      default: () => ({
        direct_mp4: {
          enabled: true,
          directImportSupported: true,
          note: 'Accessible public HTTPS MP4/WebM media URLs can be imported directly.',
        },
        youtube: {
          enabled: true,
          directImportSupported: true,
          note: 'Metadata verified via YouTube Data API / oEmbed; video media acquired through configured authorized media-source adapter with up to 10-hour chunk processing.',
        },
        instagram: {
          enabled: true,
          directImportSupported: false,
          note: 'Instagram restricts automated third-party video scraping. Please upload your original Reel/video file directly.',
        },
        facebook: {
          enabled: true,
          directImportSupported: false,
          note: 'Facebook video streams require creator authorization. Please upload your video file directly.',
        },
        tiktok: {
          enabled: true,
          directImportSupported: false,
          note: 'TikTok restricts unauthenticated media extraction. Please upload your source video file directly.',
        },
      }),
    },
  },
  { timestamps: true }
);

export const SystemConfig = mongoose.model<ISystemConfig>('SystemConfig', systemConfigSchema);
