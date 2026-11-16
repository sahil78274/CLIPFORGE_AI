import { z } from 'zod';
import { DEFAULT_CAPTION_STYLE, DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().trim().email('Valid email address required').max(180),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password cannot exceed 128 characters'),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Valid email address required'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Valid email address required'),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(16, 'Valid reset token required'),
  password: z.string().min(8, 'New password must be at least 8 characters').max(128),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  preferences: z
    .object({
      defaultAspectRatio: z.enum(['9:16', '1:1', '16:9']).optional(),
      defaultLanguage: z.string().max(16).optional(),
      watermarkText: z.string().max(60).optional(),
      emailNotifications: z.boolean().optional(),
    })
    .optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

export const captionStyleSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_CAPTION_STYLE.enabled),
    font: z.string().max(80).default(DEFAULT_CAPTION_STYLE.font),
    fontSize: z.number().min(18).max(96).default(DEFAULT_CAPTION_STYLE.fontSize),
    position: z.enum(['bottom', 'middle', 'top']).default(DEFAULT_CAPTION_STYLE.position),
    textColor: z.string().max(20).default(DEFAULT_CAPTION_STYLE.textColor),
    highlightColor: z.string().max(20).default(DEFAULT_CAPTION_STYLE.highlightColor),
    backgroundColor: z.string().max(20).default(DEFAULT_CAPTION_STYLE.backgroundColor),
    backgroundOpacity: z.number().min(0).max(1).default(DEFAULT_CAPTION_STYLE.backgroundOpacity),
    animation: z
      .enum(['word_pop', 'karaoke', 'fade', 'none'])
      .default(DEFAULT_CAPTION_STYLE.animation),
  })
  .default(DEFAULT_CAPTION_STYLE);

export const processingSettingsSchema = z
  .object({
    durationPreset: z
      .enum(['15-30', '30-45', '45-60', '60-90', 'custom'])
      .default(DEFAULT_PROCESSING_SETTINGS.durationPreset),
    customMinDuration: z.number().min(5).max(180).default(15),
    customMaxDuration: z.number().min(8).max(240).default(30),
    clipCount: z.number().int().min(1).max(10).default(3),
    aspectRatio: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
    language: z.string().max(16).default('en'),
    editingIntensity: z.enum(['subtle', 'balanced', 'dynamic']).default('balanced'),
    silenceRemovalEnabled: z.boolean().default(true),
    silenceThresholdDb: z.number().min(-70).max(-15).default(-38),
    silenceMinDurationSec: z.number().min(0.2).max(5).default(0.6),
    audioNormalization: z.boolean().default(true),
    noiseReduction: z.boolean().default(true),
    zoomEffects: z.boolean().default(true),
    backgroundMusic: z.enum(['none', 'ambient_focus', 'subtle_pulse']).default('none'),
    watermarkEnabled: z.boolean().default(false),
    watermarkText: z.string().max(60).default(''),
    introText: z.string().max(80).default(''),
    outroText: z.string().max(80).default(''),
    chunkDurationSec: z.number().int().min(15).max(3600).optional(),
    captionStyle: captionStyleSchema,
  })
  .default(DEFAULT_PROCESSING_SETTINGS);

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(1000).optional(),
  settings: processingSettingsSchema.optional(),
});

export const checkUrlSchema = z.object({
  url: z.string().trim().url('Please enter a valid HTTP or HTTPS URL').max(2048),
});

export const importUrlSchema = z.object({
  title: z.string().trim().min(1).max(180),
  url: z.string().trim().url('Please enter a valid HTTP or HTTPS URL').max(2048),
  settings: processingSettingsSchema.optional(),
  autoStart: z.boolean().optional().default(true),
});

const optionalUrlField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().url('Please enter a valid HTTP or HTTPS media URL').max(2048).optional()
);

const optionalDriveFileIdField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{3,128}$/, 'Invalid Google Drive file ID')
    .optional()
);

export const youtubeFetchSchema = z.object({
  url: z.string().trim().min(5, 'Please enter a YouTube video URL').max(2048),
  authorizedMediaUrl: optionalUrlField,
  googleDriveFileId: optionalDriveFileIdField,
});

export const youtubeGenerateClipsSchema = z.object({
  url: z.string().trim().min(5, 'Please enter a YouTube video URL').max(2048),
  title: z.string().trim().max(180).optional(),
  authorizedMediaUrl: optionalUrlField,
  googleDriveFileId: optionalDriveFileIdField,
  settings: processingSettingsSchema.optional(),
  autoStart: z.boolean().optional().default(true),
});

export const googleOAuthAuthorizeSchema = z.object({
  redirectPath: z.string().trim().max(512).optional(),
  loginHint: z.string().trim().email().max(180).optional(),
});

export const renameClipSchema = z.object({
  title: z.string().trim().min(1).max(180),
});

export const createPaymentOrderSchema = z.object({
  packageId: z.string().min(1),
  useSandboxSimulator: z.boolean().optional().default(false),
});

export const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(3),
  razorpayPaymentId: z.string().min(3),
  razorpaySignature: z.string().min(8),
});

export const contactSubmissionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(5).max(3000),
});

export const adminUserStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(3).max(500),
});

export const adminCreditAdjustSchema = z.object({
  amount: z.number().int().refine((n) => n !== 0, 'Adjustment amount cannot be zero'),
  reason: z.string().trim().min(3).max(500),
});
