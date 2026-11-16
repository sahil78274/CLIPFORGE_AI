import type { Request, Response } from 'express';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';
import { env } from '../config/env';
import {
  initiateGoogleDriveClipGeneration,
  verifyAndSelectGoogleDriveVideo,
} from '../services/googleDriveImportService';
import { getMediaAcquisitionService } from '../services/mediaAcquisition';
import { BadRequestError } from '../utils/errors';
import { processingSettingsSchema } from '../validators/schemas';

function buildClientRedirectUrl(
  redirectPath: string,
  extraParams: Record<string, string>
): string {
  const base = env.CLIENT_URL.replace(/\/+$/, '');
  const safePath =
    redirectPath.startsWith('/') && !redirectPath.startsWith('//')
      ? redirectPath
      : '/dashboard/create?tab=google_drive';
  const target = new URL(safePath, `${base}/`);
  for (const [k, v] of Object.entries(extraParams)) {
    target.searchParams.set(k, v);
  }
  return target.toString();
}

export const googleDriveController = {
  async oauthStatus(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const status = await mediaService.googleOAuthProvider.getConnectionStatus(
      String(req.user!._id)
    );
    res.json({
      success: true,
      data: status,
    });
  },

  async oauthAuthorize(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const result = mediaService.googleOAuthProvider.createAuthorizationUrl(
      String(req.user!._id),
      {
        redirectPath: req.body?.redirectPath || '/dashboard/create?tab=google_drive',
        loginHint: req.body?.loginHint || req.user?.email,
        includeYouTubeScope: false,
      }
    );
    res.json({
      success: true,
      data: result,
    });
  },

  async oauthCallback(req: Request, res: Response) {
    const wantsJson =
      req.query.format === 'json' ||
      (typeof req.headers.accept === 'string' &&
        req.headers.accept.includes('application/json') &&
        !req.headers.accept.includes('text/html'));

    const oauthError =
      typeof req.query.error === 'string' ? req.query.error.trim() : '';
    if (oauthError) {
      const desc =
        typeof req.query.error_description === 'string'
          ? req.query.error_description
          : oauthError === 'access_denied'
            ? 'Google Drive authorization was cancelled.'
            : oauthError;
      if (wantsJson) {
        throw new BadRequestError(
          `Google authorization was cancelled or denied: ${desc}`,
          'GOOGLE_OAUTH_CANCELLED'
        );
      }
      res.redirect(
        buildClientRedirectUrl('/dashboard/create?tab=google_drive', {
          googleError: desc,
        })
      );
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';

    const mediaService = getMediaAcquisitionService();
    try {
      const result = await mediaService.googleOAuthProvider.handleCallback({
        code,
        state,
      });

      if (wantsJson) {
        res.json({
          success: true,
          data: result,
        });
        return;
      }

      res.redirect(
        buildClientRedirectUrl(result.redirectPath, {
          googleConnected: '1',
        })
      );
    } catch (err: any) {
      if (wantsJson) {
        throw err;
      }
      res.redirect(
        buildClientRedirectUrl('/dashboard/create?tab=google_drive', {
          googleError: err?.message || 'Google Drive OAuth connection failed',
        })
      );
    }
  },

  async oauthDisconnect(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    await mediaService.googleOAuthProvider.disconnect(String(req.user!._id));
    const status = await mediaService.googleOAuthProvider.getConnectionStatus(
      String(req.user!._id)
    );
    res.json({
      success: true,
      data: status,
    });
  },

  async createPickerSession(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const session = await mediaService.googleOAuthProvider.createPickerSession(
      String(req.user!._id)
    );
    res.json({
      success: true,
      data: session,
    });
  },

  async selectFile(req: Request, res: Response) {
    const result = await verifyAndSelectGoogleDriveVideo({
      userId: req.user!._id,
      fileId: req.body.fileId,
      clipCount: req.body.clipCount,
    });
    res.json({
      success: true,
      data: result,
    });
  },

  async importVideo(req: Request, res: Response) {
    const settings = processingSettingsSchema.parse(
      req.body.settings || DEFAULT_PROCESSING_SETTINGS
    );
    const result = await initiateGoogleDriveClipGeneration({
      userId: req.user!._id,
      fileId: req.body.fileId,
      title: req.body.title,
      settings,
      autoStart: req.body.autoStart !== false,
    });
    res.status(201).json({
      success: true,
      data: result,
    });
  },
};
