import type { Request, Response } from 'express';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';
import { env } from '../config/env';
import { getGoogleDriveImportService } from '../services/googleDrive/GoogleDriveImportService';
import { getGoogleDriveOAuthService } from '../services/googleDrive/GoogleDriveOAuthService';
import { AppError, BadRequestError } from '../utils/errors';
import { processingSettingsSchema } from '../validators/schemas';
import { youtubeController } from './youtubeController';

function buildClientRedirectUrl(
  redirectPath: string,
  extraParams: Record<string, string>
): string {
  const base = env.CLIENT_URL.replace(/\/+$/, '');
  const safePath =
    redirectPath.startsWith('/') && !redirectPath.startsWith('//')
      ? redirectPath
      : '/dashboard/create?tab=drive';
  const target = new URL(safePath, `${base}/`);
  for (const [k, v] of Object.entries(extraParams)) {
    target.searchParams.set(k, v);
  }
  return target.toString();
}

function wantsJson(req: Request): boolean {
  return (
    req.query.format === 'json' ||
    (typeof req.headers.accept === 'string' &&
      req.headers.accept.includes('application/json') &&
      !req.headers.accept.includes('text/html'))
  );
}

export const googleDriveController = {
  /** Public identifiers for the official Google Picker API — never a client secret. */
  async config(_req: Request, res: Response) {
    res.json({ success: true, data: getGoogleDriveOAuthService().getPublicConfig() });
  },

  async status(req: Request, res: Response) {
    const status = await getGoogleDriveOAuthService().getConnectionStatus(String(req.user!._id));
    res.json({ success: true, data: status });
  },

  async authorize(req: Request, res: Response) {
    const result = await getGoogleDriveOAuthService().createAuthorizationUrl(
      String(req.user!._id),
      req.body?.redirectPath,
      req.body?.loginHint || req.user?.email
    );
    // The signed state is server-side single-use; only the Google URL is returned.
    res.json({
      success: true,
      data: {
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt,
      },
    });
  },

  /**
   * Canonical Google OAuth 2.0 callback (GOOGLE_REDIRECT_URI).
   * Dispatches Drive-import states to the Drive service; legacy YouTube states
   * continue through the existing YouTube OAuth controller unchanged.
   */
  async oauthCallback(req: Request, res: Response) {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const service = getGoogleDriveOAuthService();
    // Route by the signed `flow` claim. Malformed/unknown states fall through to the
    // Drive verification path, which rejects them with GOOGLE_DRIVE_INVALID_STATE.
    const isLegacyYouTubeState =
      state.length > 0 && service.peekStateFlow(state) === 'legacy_youtube';
    if (isLegacyYouTubeState) {
      return youtubeController.googleOAuthCallback(req, res);
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const oauthError = typeof req.query.error === 'string' ? req.query.error.trim() : '';
    const errorDescription =
      typeof req.query.error_description === 'string' ? req.query.error_description : '';

    try {
      const result = await service.handleCallback({
        code,
        state,
        error: oauthError || undefined,
        errorDescription: errorDescription || undefined,
      });

      if (result.cancelled) {
        if (wantsJson(req)) {
          throw new BadRequestError(
            `Google Drive connection was cancelled (${errorDescription || oauthError}).`,
            'GOOGLE_DRIVE_OAUTH_CANCELLED'
          );
        }
        res.redirect(
          buildClientRedirectUrl(result.redirectPath, { driveError: 'cancelled' })
        );
        return;
      }

      if (wantsJson(req)) {
        res.json({ success: true, data: result });
        return;
      }
      res.redirect(buildClientRedirectUrl(result.redirectPath, { driveConnected: '1' }));
    } catch (err: any) {
      if (wantsJson(req)) throw err;
      res.redirect(
        buildClientRedirectUrl('/dashboard/create?tab=drive', {
          driveError: String(err?.message || 'Google Drive connection failed').slice(0, 300),
        })
      );
    }
  },

  async disconnect(req: Request, res: Response) {
    const status = await getGoogleDriveOAuthService().disconnect(String(req.user!._id));
    res.json({ success: true, data: status });
  },

  /** Short-lived access token used only by the official Picker (never a refresh token). */
  async pickerToken(req: Request, res: Response) {
    const service = getGoogleDriveOAuthService();
    if (!service.isPickerConfigured()) {
      throw new AppError(
        service.getSetupInstructions(),
        503,
        'GOOGLE_PICKER_NOT_CONFIGURED'
      );
    }
    const token = await service.getPickerAccessToken(String(req.user!._id));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: token });
  },

  /** Verifies a Picker-selected file ID with this user's own credentials. */
  async selectFile(req: Request, res: Response) {
    const file = await getGoogleDriveImportService().registerSelection(
      String(req.user!._id),
      String(req.body.fileId)
    );
    res.status(201).json({ success: true, data: file });
  },

  async getSelection(req: Request, res: Response) {
    const file = await getGoogleDriveImportService().getSelectionPublic(
      String(req.user!._id),
      String(req.params.id)
    );
    res.json({ success: true, data: file });
  },

  async thumbnail(req: Request, res: Response) {
    const { stream, contentType } = await getGoogleDriveImportService().getThumbnailStream(
      String(req.user!._id),
      String(req.params.id)
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
      else res.end();
    });
    stream.pipe(res);
  },

  async generate(req: Request, res: Response) {
    const settings = processingSettingsSchema.parse(
      req.body.settings || DEFAULT_PROCESSING_SETTINGS
    );
    const result = await getGoogleDriveImportService().createGenerationJob({
      userId: req.user!._id,
      selectionId: String(req.body.selectionId),
      title: req.body.title,
      settings,
      autoStart: req.body.autoStart !== false,
    });
    res.status(201).json({
      success: true,
      data: {
        project: result.project,
        job: result.job,
        file: result.file,
        estimatedCredits: result.estimatedCredits,
        chunkPlan: result.chunkPlan,
      },
    });
  },
};
