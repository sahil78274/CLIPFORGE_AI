export type {
  AspectRatio,
  CaptionStyleConfig,
  PipelineStage,
  ProjectProcessingSettings,
} from '@clipforge/shared';
import type {
  AspectRatio,
  CaptionStyleConfig,
  PipelineStage,
  ProjectProcessingSettings,
} from '@clipforge/shared';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  preferences: {
    defaultAspectRatio: AspectRatio;
    defaultLanguage: string;
    watermarkText: string;
    emailNotifications: boolean;
  };
  lastLoginAt?: string;
  createdAt: string;
}

export interface WalletSummary {
  availableCredits: number;
  reservedCredits: number;
  lifetimeEarnedCredits: number;
  lifetimePurchasedCredits: number;
  lifetimeUsedCredits: number;
  lifetimeRefundedCredits: number;
  currency: string;
}

export interface CreditTransactionItem {
  _id: string;
  type:
    | 'welcome_bonus'
    | 'purchase'
    | 'reserve'
    | 'deduct'
    | 'release_reserve'
    | 'refund'
    | 'admin_adjustment';
  amount: number;
  balanceAfter: number;
  reservedAfter: number;
  referenceType: 'signup' | 'job' | 'payment' | 'admin';
  referenceId?: string;
  description: string;
  createdAt: string;
}

export interface CreditPackageItem {
  _id: string;
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
}

export interface PaymentRecord {
  _id: string;
  packageSnapshot: {
    name: string;
    credits: number;
    amountPaise: number;
    currency: string;
  };
  provider: 'razorpay' | 'razorpay_sandbox_dev';
  isDevelopmentMode: boolean;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignatureVerified: boolean;
  amountPaise: number;
  currency: string;
  creditsGranted: number;
  status: 'created' | 'authorized' | 'captured' | 'verified' | 'failed' | 'refunded';
  refundAmountPaise?: number;
  refundReason?: string;
  failureReason?: string;
  createdAt: string;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface SceneItem {
  start: number;
  end: number;
  score: number;
  motionScore: number;
  hasFace: boolean;
  faceCenterX: number;
}

export interface VideoRecord {
  _id: string;
  projectId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec?: string;
  hasAudio: boolean;
  transcriptionEngine?: string;
  detectedLanguage?: string;
  transcript: TranscriptSegment[];
  scenes: SceneItem[];
  status: 'uploaded' | 'validated' | 'analyzed' | 'failed';
  createdAt: string;
}

export interface ClipMetadata {
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
}

export interface ClipItem {
  _id: string;
  projectId: string | { _id: string; title: string };
  videoId: string;
  jobId: string;
  title: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  aspectRatio: AspectRatio;
  transcript: string;
  selectionReason: string;
  category: string;
  engagementScore: number;
  fileSizeBytes: number;
  width: number;
  height: number;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  captionStyle: CaptionStyleConfig;
  editingApplied: string[];
  metadata: ClipMetadata;
  previewUrl?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  createdAt: string;
}

export interface ProcessingJobItem {
  _id: string;
  projectId: string | { _id: string; title: string };
  videoId?: string;
  type: 'full_pipeline' | 'regenerate_clip';
  queueMode: 'bullmq' | 'local_worker';
  stage: PipelineStage;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progressPercent: number;
  currentMessage: string;
  stageHistory: Array<{
    stage: string;
    startedAt: string;
    completedAt?: string;
    message?: string;
  }>;
  diagnostics: {
    aiProvider: string;
    aiConfigured: boolean;
    whisperStatus: string;
    ffmpegAvailable: boolean;
    warnings: string[];
  };
  creditsReserved: number;
  creditsDeducted: number;
  creditReservationReleased: boolean;
  error?: {
    code: string;
    message: string;
    stage: string;
  };
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface ProjectItem {
  _id: string;
  title: string;
  description?: string;
  sourceType: 'upload' | 'url';
  sourceUrl?: string;
  sourcePlatform: 'upload' | 'youtube' | 'instagram' | 'facebook' | 'tiktok' | 'direct_mp4';
  status: 'draft' | 'importing' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  settings: ProjectProcessingSettings;
  videoId?: VideoRecord | string;
  latestJobId?: ProcessingJobItem | string;
  clipsCount: number;
  creditsReserved: number;
  creditsConsumed: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationItem {
  _id: string;
  type: 'job_completed' | 'job_failed' | 'credits_added' | 'welcome' | 'system' | 'security';
  title: string;
  message: string;
  actionUrl?: string;
  isRead: boolean;
  createdAt: string;
}

export interface DashboardOverviewData {
  stats: {
    totalProjects: number;
    clipsGenerated: number;
    activeProcessingJobs: number;
    creditsRemaining: number;
    reservedCredits: number;
  };
  recentProjects: ProjectItem[];
  recentJobs: ProcessingJobItem[];
  recentClips: ClipItem[];
  recentActivity: NotificationItem[];
}

export interface UrlCheckResult {
  valid: boolean;
  platform: 'youtube' | 'instagram' | 'facebook' | 'tiktok' | 'direct_mp4' | 'unknown';
  importableDirectly: boolean;
  requiresUploadFallback: boolean;
  reason: string;
  metadata?: {
    title?: string;
    author?: string;
    thumbnailUrl?: string;
    contentType?: string;
    contentLengthBytes?: number;
  };
}

export interface SystemCapabilities {
  ffmpeg: { available: boolean; path?: string };
  ffprobe: { available: boolean; path?: string };
  ai: {
    provider: string;
    configured: boolean;
    model: string;
    setupInstructions?: string;
  };
  transcription: {
    primaryEngine: string;
    whisperModelCached: boolean;
    offlineFallbackEngine: string;
    setupInstructions?: string;
  };
  payments: {
    razorpayConfigured: boolean;
    sandboxSimulatorEnabled: boolean;
    keyId?: string;
  };
  queue: {
    mode: 'bullmq' | 'local_worker';
    redisConnected: boolean;
  };
  limits: {
    welcomeCredits: number;
    creditsPerMinuteProcessed: number;
    minCreditsPerJob: number;
    maxUploadSizeMb: number;
    maxVideoDurationSec: number;
    maxClipsPerJob: number;
  };
  supportedPlatforms: Record<
    string,
    { enabled: boolean; directImportSupported: boolean; note: string }
  >;
}
