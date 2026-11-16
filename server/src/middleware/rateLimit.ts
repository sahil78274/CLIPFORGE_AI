import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const isTest = env.NODE_ENV === 'test';

export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 5000 : 800,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests from this IP. Please slow down and retry shortly.',
    },
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many authentication attempts. Please wait 15 minutes before trying again.',
    },
  },
});

/** OAuth authorize/callback/disconnect: tight limit against state brute force & token churn. */
export const googleOAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'GOOGLE_OAUTH_RATE_LIMITED',
      message: 'Too many Google connection attempts. Please wait 15 minutes and try again.',
    },
  },
});

/** Drive metadata / picker-token / file-selection endpoints. */
export const googleDriveApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'GOOGLE_DRIVE_RATE_LIMITED',
      message: 'Too many Google Drive requests. Please slow down and retry shortly.',
    },
  },
});

export const uploadAndJobLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'JOB_RATE_LIMITED',
      message: 'Too many upload or processing job requests. Please wait shortly.',
    },
  },
});
