import type { Request, Response } from 'express';
import {
  DEFAULT_PROCESSING_SETTINGS,
  type YouTubeVideoMetadata,
} from '@clipforge/shared';
import { env } from '../config/env';
import {
  getMediaAcquisitionService,
  parseYouTubeVideoUrl,
} from '../services/mediaAcquisition';
import {
  fetchYouTubeVideoMetadataAndAccess,
  initiateYouTubeClipGeneration,
} from '../services/youtubeImportService';
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
      : '/dashboard/create?tab=youtube';
  const target = new URL(safePath, `${base}/`);
  for (const [k, v] of Object.entries(extraParams)) {
    target.searchParams.set(k, v);
  }
  return target.toString();
}

export const youtubeController = {
  async adapterStatus(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const status = await mediaService.getStatus(
      req.user ? String(req.user._id) : undefined
    );
    res.json({
      success: true,
      data: status,
    });
  },

  async googleOAuthStatus(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const status = await mediaService.googleOAuthProvider.getConnectionStatus(
      String(req.user!._id)
    );
    res.json({
      success: true,
      data: status,
    });
  },

  async googleOAuthAuthorize(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const result = mediaService.googleOAuthProvider.createAuthorizationUrl(
      String(req.user!._id),
      {
        redirectPath: req.body?.redirectPath,
        loginHint: req.body?.loginHint || req.user?.email,
      }
    );
    res.json({
      success: true,
      data: result,
    });
  },

  async googleOAuthCallback(req: Request, res: Response) {
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
          : oauthError;
      if (wantsJson) {
        throw new BadRequestError(
          `Google authorization was cancelled or denied: ${desc}`,
          'GOOGLE_OAUTH_DENIED'
        );
      }
      res.redirect(
        buildClientRedirectUrl('/dashboard/create?tab=youtube', {
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
        buildClientRedirectUrl('/dashboard/create?tab=youtube', {
          googleError: err?.message || 'Google OAuth connection failed',
        })
      );
    }
  },

  async googleOAuthDisconnect(req: Request, res: Response) {
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

  async listGoogleDriveFiles(req: Request, res: Response) {
    const mediaService = getMediaAcquisitionService();
    const userId = String(req.user!._id);
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const pageToken =
      typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined;
    const pageSize =
      typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : 25;
    const youtubeUrl =
      typeof req.query.youtubeUrl === 'string' ? req.query.youtubeUrl.trim() : '';

    let targetVideo:
      | Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>
      | undefined;

    if (youtubeUrl) {
      try {
        const meta = await mediaService.youtubeMetadataProvider.fetchVideoMetadata(
          youtubeUrl,
          { userId }
        );
        targetVideo = {
          videoId: meta.videoId,
          title: meta.title,
          durationSec: meta.durationSec,
        };
      } catch {
        // If full metadata is unreachable, still match against the parsed 11-char videoId!
        try {
          const parsed = parseYouTubeVideoUrl(youtubeUrl);
          targetVideo = {
            videoId: parsed.videoId,
            title:
              typeof req.query.titleHint === 'string'
                ? req.query.titleHint
                : `YouTube Video ${parsed.videoId}`,
            durationSec:
              typeof req.query.durationSec === 'string' &&
              Number.isFinite(Number(req.query.durationSec))
                ? Number(req.query.durationSec)
                : null,
          };
        } catch {
          targetVideo = undefined;
        }
      }
    }

    const result = await mediaService.googleDriveMediaProvider.listUserVideoFiles(
      userId,
      {
        query,
        pageToken,
        pageSize: Number.isFinite(pageSize) ? pageSize : 25,
        targetVideo,
      }
    );

    res.json({
      success: true,
      data: result,
    });
  },

  async fetchVideo(req: Request, res: Response) {
    const report = await fetchYouTubeVideoMetadataAndAccess(req.body.url, {
      userId: String(req.user!._id),
      googleDriveFileId: req.body.googleDriveFileId,
      authorizedMediaUrl: req.body.authorizedMediaUrl,
    });
    res.json({
      success: true,
      data: report,
    });
  },

  async generateClips(req: Request, res: Response) {
    const settings = processingSettingsSchema.parse(
      req.body.settings || DEFAULT_PROCESSING_SETTINGS
    );
    const result = await initiateYouTubeClipGeneration({
      userId: req.user!._id,
      url: req.body.url,
      title: req.body.title,
      googleDriveFileId: req.body.googleDriveFileId,
      authorizedMediaUrl: req.body.authorizedMediaUrl,
      settings,
      autoStart: req.body.autoStart !== false,
    });
    res.status(201).json({
      success: true,
      data: result,
    });
  },
};
