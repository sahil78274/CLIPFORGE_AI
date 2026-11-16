import type { Request, Response } from 'express';
import { DEFAULT_PROCESSING_SETTINGS } from '@clipforge/shared';
import { env } from '../config/env';
import {
  fetchYouTubeVideoMetadataAndAccess,
  initiateYouTubeClipGeneration,
} from '../services/youtubeImportService';
import { getYouTubeMediaSourceAdapter } from '../services/youtubeMediaSourceAdapter';
import { processingSettingsSchema } from '../validators/schemas';

export const youtubeController = {
  async adapterStatus(_req: Request, res: Response) {
    const adapter = getYouTubeMediaSourceAdapter();
    res.json({
      success: true,
      data: {
        adapterName: adapter.name,
        configured: adapter.isConfigured(),
        youtubeDataApiConfigured: Boolean(
          env.YOUTUBE_DATA_API_KEY && env.YOUTUBE_DATA_API_KEY.trim().length > 8
        ),
        maxDurationSec: env.MAX_VIDEO_DURATION_SEC,
        defaultChunkDurationSec: env.VIDEO_CHUNK_DURATION_SEC,
        setupInstructions: adapter.getSetupInstructions(),
      },
    });
  },

  async fetchVideo(req: Request, res: Response) {
    const report = await fetchYouTubeVideoMetadataAndAccess(req.body.url, {
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
