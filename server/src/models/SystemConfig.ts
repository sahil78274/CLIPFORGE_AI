import mongoose, { Document, Schema } from 'mongoose';

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
  maxVideoDurationSec: number;
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
    maxUploadSizeMb: { type: Number, default: 250 },
    maxVideoDurationSec: { type: Number, default: 3600 },
    maxClipsPerJob: { type: Number, default: 6 },
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
          directImportSupported: false,
          note: 'Metadata verified via YouTube oEmbed/Data API. Direct stream downloading requires authorized owner exports; upload your MP4 directly.',
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
