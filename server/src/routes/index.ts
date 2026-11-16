import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { optionalAuth, requireAdmin, requireAuth } from '../middleware/auth';
import {
  authRateLimiter,
  googleDriveApiLimiter,
  googleOAuthLimiter,
  uploadAndJobLimiter,
} from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { asyncHandler, BadRequestError } from '../utils/errors';
import {
  adminCreditAdjustSchema,
  adminUserStatusSchema,
  changePasswordSchema,
  googleDriveAuthorizeSchema,
  googleDriveGenerateSchema,
  googleDriveSelectFileSchema,
  checkUrlSchema,
  contactSubmissionSchema,
  createPaymentOrderSchema,
  createProjectSchema,
  forgotPasswordSchema,
  googleOAuthAuthorizeSchema,
  importUrlSchema,
  loginSchema,
  registerSchema,
  renameClipSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyPaymentSchema,
  youtubeFetchSchema,
  youtubeGenerateClipsSchema,
} from '../validators/schemas';

import { authController } from '../controllers/authController';
import { userController } from '../controllers/userController';
import { projectController, videoController } from '../controllers/projectAndVideoController';
import { youtubeController } from '../controllers/youtubeController';
import { googleDriveController } from '../controllers/googleDriveController';
import { clipController } from '../controllers/clipController';
import {
  jobController,
  notificationController,
  paymentController,
  walletController,
} from '../controllers/jobWalletPaymentNotificationController';
import { adminController } from '../controllers/adminController';

const uploadTmpDir = path.join(env.TEMP_WORKING_DIR, 'uploads');
fs.mkdirSync(uploadTmpDir, { recursive: true });

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-m4v',
  'application/octet-stream',
]);

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);

const videoUploadMulter = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(uploadTmpDir, { recursive: true });
      cb(null, uploadTmpDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '.mp4').toLowerCase() || '.mp4';
      const safeExt = ALLOWED_VIDEO_EXTS.has(ext) ? ext : '.mp4';
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024, // Hard ceiling 500MB; dynamic SystemConfig limit enforced inside controller
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_VIDEO_EXTS.has(ext) || !ALLOWED_VIDEO_MIMES.has(file.mimetype)) {
      cb(
        new BadRequestError(
          'Unsupported file type. Upload a valid MP4, MOV, WebM, or MKV video file.',
          'UNSUPPORTED_MEDIA_TYPE'
        )
      );
      return;
    }
    cb(null, true);
  },
});

export const apiV1Router = Router();

/* --- Health --- */
apiV1Router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', service: 'clipforge-api-v1' } });
});

/* --- /api/v1/auth --- */
const authRouter = Router();
authRouter.post(
  '/register',
  authRateLimiter,
  validateBody(registerSchema),
  asyncHandler(authController.register)
);
authRouter.post(
  '/login',
  authRateLimiter,
  validateBody(loginSchema),
  asyncHandler(authController.login)
);
authRouter.post('/logout', asyncHandler(authController.logout));
authRouter.get('/me', requireAuth, asyncHandler(authController.me));
authRouter.post(
  '/forgot-password',
  authRateLimiter,
  validateBody(forgotPasswordSchema),
  asyncHandler(authController.forgotPassword)
);
authRouter.post(
  '/reset-password',
  authRateLimiter,
  validateBody(resetPasswordSchema),
  asyncHandler(authController.resetPassword)
);
apiV1Router.use('/auth', authRouter);

/* --- /api/v1/users --- */
const usersRouter = Router();
usersRouter.use(requireAuth);
usersRouter.get('/overview', asyncHandler(userController.overview));
usersRouter.patch(
  '/profile',
  validateBody(updateProfileSchema),
  asyncHandler(userController.updateProfile)
);
usersRouter.post(
  '/password',
  validateBody(changePasswordSchema),
  asyncHandler(userController.changePassword)
);
usersRouter.get('/search', asyncHandler(userController.globalSearch));
apiV1Router.use('/users', usersRouter);

/* --- /api/v1/projects --- */
const projectsRouter = Router();
projectsRouter.use(requireAuth);
projectsRouter.get('/', asyncHandler(projectController.list));
projectsRouter.post(
  '/',
  validateBody(createProjectSchema),
  asyncHandler(projectController.create)
);
projectsRouter.get('/:id', asyncHandler(projectController.getById));
projectsRouter.delete('/:id', asyncHandler(projectController.remove));
apiV1Router.use('/projects', projectsRouter);

/* --- /api/v1/videos --- */
const videosRouter = Router();
videosRouter.post(
  '/check-url',
  validateBody(checkUrlSchema),
  asyncHandler(videoController.checkUrl)
);
videosRouter.post(
  '/upload',
  requireAuth,
  uploadAndJobLimiter,
  videoUploadMulter.single('video'),
  asyncHandler(videoController.uploadVideo)
);
videosRouter.post(
  '/import-url',
  requireAuth,
  uploadAndJobLimiter,
  validateBody(importUrlSchema),
  asyncHandler(videoController.importFromUrl)
);
apiV1Router.use('/videos', videosRouter);

/* --- /api/v1/youtube --- */
const youtubeRouter = Router();
youtubeRouter.get(
  '/adapter-status',
  optionalAuth,
  asyncHandler(youtubeController.adapterStatus)
);
youtubeRouter.get(
  '/oauth/google/status',
  requireAuth,
  asyncHandler(youtubeController.googleOAuthStatus)
);
youtubeRouter.post(
  '/oauth/google/authorize',
  requireAuth,
  validateBody(googleOAuthAuthorizeSchema),
  asyncHandler(youtubeController.googleOAuthAuthorize)
);
youtubeRouter.get(
  '/oauth/google/callback',
  // Backwards-compatible alias: a single Google OAuth client may have either the
  // legacy YouTube callback or the new /api/v1/google-drive/oauth/callback registered
  // as its authorized redirect URI. This dispatcher routes Drive states to the Drive
  // service and legacy YouTube states to the YouTube controller.
  asyncHandler(googleDriveController.oauthCallback)
);
youtubeRouter.post(
  '/oauth/google/disconnect',
  requireAuth,
  asyncHandler(youtubeController.googleOAuthDisconnect)
);
youtubeRouter.get(
  '/drive/files',
  requireAuth,
  asyncHandler(youtubeController.listGoogleDriveFiles)
);
youtubeRouter.post(
  '/fetch',
  requireAuth,
  validateBody(youtubeFetchSchema),
  asyncHandler(youtubeController.fetchVideo)
);
youtubeRouter.post(
  '/generate',
  requireAuth,
  uploadAndJobLimiter,
  validateBody(youtubeGenerateClipsSchema),
  asyncHandler(youtubeController.generateClips)
);
apiV1Router.use('/youtube', youtubeRouter);

/* --- /api/v1/google-drive (OAuth 2.0 + official Picker API + streamed import) --- */
const googleDriveRouter = Router();
// Public Picker configuration (API key & project number are browser-safe identifiers).
googleDriveRouter.get('/config', googleDriveApiLimiter, asyncHandler(googleDriveController.config));
// Canonical Google OAuth 2.0 callback — no session cookie required (Google redirects here).
googleDriveRouter.get(
  '/oauth/callback',
  googleOAuthLimiter,
  asyncHandler(googleDriveController.oauthCallback)
);

googleDriveRouter.use(requireAuth);
googleDriveRouter.get(
  '/status',
  googleDriveApiLimiter,
  asyncHandler(googleDriveController.status)
);
googleDriveRouter.post(
  '/oauth/authorize',
  googleOAuthLimiter,
  validateBody(googleDriveAuthorizeSchema),
  asyncHandler(googleDriveController.authorize)
);
googleDriveRouter.post(
  '/oauth/disconnect',
  googleOAuthLimiter,
  asyncHandler(googleDriveController.disconnect)
);
googleDriveRouter.get(
  '/picker-token',
  googleDriveApiLimiter,
  asyncHandler(googleDriveController.pickerToken)
);
googleDriveRouter.post(
  '/files/select',
  googleDriveApiLimiter,
  validateBody(googleDriveSelectFileSchema),
  asyncHandler(googleDriveController.selectFile)
);
googleDriveRouter.get(
  '/selections/:id',
  googleDriveApiLimiter,
  asyncHandler(googleDriveController.getSelection)
);
googleDriveRouter.get(
  '/selections/:id/thumbnail',
  googleDriveApiLimiter,
  asyncHandler(googleDriveController.thumbnail)
);
googleDriveRouter.post(
  '/generate',
  uploadAndJobLimiter,
  validateBody(googleDriveGenerateSchema),
  asyncHandler(googleDriveController.generate)
);
apiV1Router.use('/google-drive', googleDriveRouter);

/* --- /api/v1/clips --- */
const clipsRouter = Router();
// Signed-token media endpoints (usable directly in <video>, <img>, and browser downloads)
clipsRouter.get('/bulk-download', asyncHandler(clipController.streamBulkZip));
clipsRouter.get('/:id/stream', asyncHandler(clipController.streamVideo));
clipsRouter.get('/:id/thumbnail', asyncHandler(clipController.streamThumbnail));
clipsRouter.get('/:id/download', asyncHandler(clipController.downloadVideo));

// Authenticated JSON endpoints
clipsRouter.use(requireAuth);
clipsRouter.get('/', asyncHandler(clipController.list));
clipsRouter.post('/bulk-download-token', asyncHandler(clipController.createBulkDownloadToken));
clipsRouter.get('/:id', asyncHandler(clipController.getById));
clipsRouter.patch('/:id', validateBody(renameClipSchema), asyncHandler(clipController.rename));
clipsRouter.patch('/:id/metadata', asyncHandler(clipController.updateMetadata));
clipsRouter.post('/:id/regenerate-metadata', asyncHandler(clipController.regenerateMetadata));
clipsRouter.post(
  '/:id/regenerate',
  uploadAndJobLimiter,
  asyncHandler(clipController.regenerateVideo)
);
clipsRouter.delete('/:id', asyncHandler(clipController.remove));
apiV1Router.use('/clips', clipsRouter);

/* --- /api/v1/jobs --- */
const jobsRouter = Router();
jobsRouter.get('/capabilities', asyncHandler(jobController.capabilities));
jobsRouter.use(requireAuth);
jobsRouter.get('/', asyncHandler(jobController.list));
jobsRouter.get('/:id', asyncHandler(jobController.getById));
jobsRouter.post(
  '/project/:projectId/start',
  uploadAndJobLimiter,
  asyncHandler(jobController.startForProject)
);
jobsRouter.post('/:id/cancel', asyncHandler(jobController.cancel));
jobsRouter.post('/:id/retry', uploadAndJobLimiter, asyncHandler(jobController.retry));
apiV1Router.use('/jobs', jobsRouter);

/* --- /api/v1/wallet --- */
const walletRouter = Router();
walletRouter.use(requireAuth);
walletRouter.get('/', asyncHandler(walletController.getWallet));
walletRouter.get('/transactions', asyncHandler(walletController.listTransactions));
apiV1Router.use('/wallet', walletRouter);

/* --- /api/v1/payments --- */
const paymentsRouter = Router();
paymentsRouter.get('/packages', asyncHandler(paymentController.listPackages));
paymentsRouter.post('/webhook', asyncHandler(paymentController.webhook));
paymentsRouter.use(requireAuth);
paymentsRouter.get('/history', asyncHandler(paymentController.history));
paymentsRouter.post(
  '/create-order',
  validateBody(createPaymentOrderSchema),
  asyncHandler(paymentController.createOrder)
);
paymentsRouter.post(
  '/verify',
  validateBody(verifyPaymentSchema),
  asyncHandler(paymentController.verify)
);
apiV1Router.use('/payments', paymentsRouter);

/* --- /api/v1/notifications --- */
const notificationsRouter = Router();
notificationsRouter.post(
  '/contact',
  validateBody(contactSubmissionSchema),
  asyncHandler(notificationController.submitContact)
);
notificationsRouter.use(requireAuth);
notificationsRouter.get('/', asyncHandler(notificationController.list));
notificationsRouter.patch('/:id/read', asyncHandler(notificationController.markRead));
notificationsRouter.post('/read-all', asyncHandler(notificationController.markAllRead));
apiV1Router.use('/notifications', notificationsRouter);

/* --- /api/v1/admin --- */
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);
adminRouter.get('/overview', asyncHandler(adminController.overview));
adminRouter.get('/users', asyncHandler(adminController.listUsers));
adminRouter.patch(
  '/users/:id/status',
  validateBody(adminUserStatusSchema),
  asyncHandler(adminController.updateUserStatus)
);
adminRouter.post(
  '/users/:id/credits',
  validateBody(adminCreditAdjustSchema),
  asyncHandler(adminController.adjustUserCredits)
);
adminRouter.get('/users/:id/activity', asyncHandler(adminController.getUserActivity));
adminRouter.get('/jobs', asyncHandler(adminController.listJobs));
adminRouter.get('/payments', asyncHandler(adminController.listPayments));
adminRouter.post('/payments/:id/refund', asyncHandler(adminController.refundPayment));
adminRouter.get('/packages', asyncHandler(adminController.listPackages));
adminRouter.post('/packages', asyncHandler(adminController.createPackage));
adminRouter.patch('/packages/:id', asyncHandler(adminController.updatePackage));
adminRouter.get('/config', asyncHandler(adminController.getConfig));
adminRouter.patch('/config', asyncHandler(adminController.updateConfig));
adminRouter.get('/audit-logs', asyncHandler(adminController.listAuditLogs));
apiV1Router.use('/admin', adminRouter);
