import path from 'path';
import {
  DEFAULT_PROCESSING_SETTINGS,
  type GoogleDriveVideoFile,
  type YouTubeVideoMetadata,
} from '@clipforge/shared';
import { env } from '../../config/env';
import { getOrCreateSystemConfig } from '../../models';
import { AppError, BadRequestError, ForbiddenError, UnauthorizedError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { calculateJobCreditCost } from '../walletService';
import { getCustomYouTubeMediaAdapterForTesting } from '../youtubeMediaSourceAdapter';
import { AuthorizedDirectMediaProvider } from './AuthorizedDirectMediaProvider';
import { GoogleDriveMediaProvider } from './GoogleDriveMediaProvider';
import { GoogleOAuthProvider } from './GoogleOAuthProvider';
import { parseYouTubeVideoUrl, YouTubeMetadataProvider } from './YouTubeMetadataProvider';
import type {
  AcquiredMediaResult,
  MediaAccessEvaluation,
  MediaAcquireOptions,
  MediaResolutionOption,
  YouTubeSourceInspectionResult,
} from './types';

export class MediaAcquisitionService {
  public readonly googleOAuthProvider: GoogleOAuthProvider;
  public readonly youtubeMetadataProvider: YouTubeMetadataProvider;
  public readonly googleDriveMediaProvider: GoogleDriveMediaProvider;
  public readonly authorizedDirectMediaProvider: AuthorizedDirectMediaProvider;

  constructor() {
    this.googleOAuthProvider = new GoogleOAuthProvider();
    this.youtubeMetadataProvider = new YouTubeMetadataProvider(this.googleOAuthProvider);
    this.googleDriveMediaProvider = new GoogleDriveMediaProvider(this.googleOAuthProvider);
    this.authorizedDirectMediaProvider = new AuthorizedDirectMediaProvider();
  }

  getSetupInstructions(): string {
    return (
      'To process YouTube links without bypassing platform access controls or DRM: ' +
      '(1) Connect your Google account (OAuth 2.0) and select your original video export from Google Drive, ' +
      '(2) Provide a Direct Authorized Media URL (presigned S3/GCS/R2/CDN MP4/MOV/WebM), ' +
      `or (3) Place owner-authorized exports in ${path.resolve(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR)} / upload the video file directly.`
    );
  }

  async getStatus(userId?: string) {
    const googleAuth = await this.googleOAuthProvider.getConnectionStatus(userId);
    const bridge = this.authorizedDirectMediaProvider.hasExternalBridgeConfigured();
    const exportsDir = path.resolve(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR);

    const anyProviderConfigured =
      Boolean(googleAuth.connected && googleAuth.hasDriveScope) ||
      bridge.configured ||
      env.ALLOW_DIRECT_MEDIA_URL_IMPORT;

    return {
      adapterName:
        googleAuth.connected && googleAuth.hasDriveScope
          ? 'google_drive'
          : bridge.configured
            ? bridge.adapterName
            : 'media_acquisition_service',
      configured: anyProviderConfigured,
      configuredMode: env.YOUTUBE_MEDIA_ADAPTER,
      anyProviderConfigured,
      allowDirectMediaUrl: env.ALLOW_DIRECT_MEDIA_URL_IMPORT,
      youtubeDataApiConfigured: Boolean(
        env.YOUTUBE_DATA_API_KEY && env.YOUTUBE_DATA_API_KEY.trim().length > 8
      ),
      maxDurationSec: env.MAX_VIDEO_DURATION_SEC,
      defaultChunkDurationSec: env.VIDEO_CHUNK_DURATION_SEC,
      setupInstructions: this.getSetupInstructions(),
      googleAuth,
      adapters: [
        {
          adapterName: 'google_drive',
          configured: Boolean(googleAuth.connected && googleAuth.hasDriveScope),
          description: googleAuth.connected
            ? `Connected as ${googleAuth.email} (${
                googleAuth.hasDriveScope
                  ? 'Google Drive video picker active'
                  : 'Google Drive scope not granted'
              })`
            : googleAuth.oauthConfigured
              ? 'Google OAuth configured — connect your Google account to select original exports from Google Drive'
              : this.googleOAuthProvider.getSetupInstructions(),
        },
        {
          adapterName: 'direct_authorized_url',
          configured: env.ALLOW_DIRECT_MEDIA_URL_IMPORT,
          description: env.ALLOW_DIRECT_MEDIA_URL_IMPORT
            ? 'Direct authorized HTTPS MP4/MOV/WebM presigned stream URLs enabled (SSRF-protected)'
            : 'Direct authorized media URLs disabled by server configuration',
        },
        {
          adapterName: 'owner_export_dir',
          configured: true,
          description: `Owner-authorized local exports directory (${exportsDir})`,
        },
        {
          adapterName: 'authorized_http_provider',
          configured: Boolean(
            env.YOUTUBE_MEDIA_PROVIDER_URL && env.YOUTUBE_MEDIA_PROVIDER_URL.trim()
          ),
          description: env.YOUTUBE_MEDIA_PROVIDER_URL
            ? 'Authorized HTTP media bridge configured'
            : 'Not configured (YOUTUBE_MEDIA_PROVIDER_URL is empty)',
        },
        {
          adapterName: 'custom_command',
          configured: Boolean(
            env.YOUTUBE_MEDIA_COMMAND_BIN && env.YOUTUBE_MEDIA_COMMAND_BIN.trim()
          ),
          description: env.YOUTUBE_MEDIA_COMMAND_BIN
            ? `Custom media acquisition command configured (${env.YOUTUBE_MEDIA_COMMAND_BIN})`
            : 'Not configured (YOUTUBE_MEDIA_COMMAND_BIN is empty)',
        },
      ],
    };
  }

  private buildResolutionOptions(
    googleConnected: boolean,
    oauthConfigured: boolean
  ): MediaResolutionOption[] {
    return [
      {
        id: 'connect_google_oauth',
        label: 'Connect Google Account (YouTube + Drive)',
        description: oauthConfigured
          ? 'Verify YouTube channel ownership and browse your original video exports in Google Drive.'
          : 'Requires GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET configured on server.',
        available: oauthConfigured && !googleConnected,
      },
      {
        id: 'select_google_drive_file',
        label: 'Select Original Export from Google Drive',
        description:
          'Choose the original MP4/MOV/WebM export from your connected Google Drive.',
        available: googleConnected,
      },
      {
        id: 'provide_direct_authorized_url',
        label: 'Provide Direct Authorized Media URL',
        description:
          'Paste a presigned HTTPS MP4/MOV/WebM URL (e.g., S3, Google Cloud Storage, Cloudflare R2, or authorized CDN).',
        available: env.ALLOW_DIRECT_MEDIA_URL_IMPORT,
      },
      {
        id: 'upload_local_file',
        label: 'Upload Video File Directly',
        description:
          'Download your video from YouTube Studio -> Content -> Download and upload it in the Direct Upload tab.',
        available: true,
      },
    ];
  }

  async inspectYouTubeSource(params: {
    url: string;
    userId?: string;
    googleDriveFileId?: string;
    authorizedMediaUrl?: string;
    clipCount?: number;
  }): Promise<YouTubeSourceInspectionResult> {
    const cfg = await getOrCreateSystemConfig();
    if (cfg.supportedPlatforms?.youtube?.enabled === false) {
      throw new ForbiddenError(
        'YouTube importing is currently disabled by the platform administrator.',
        'PLATFORM_DISABLED'
      );
    }

    const maxDurationSec = Math.min(
      env.MAX_VIDEO_DURATION_SEC,
      cfg.maxVideoDurationSec || 36000
    );

    const { videoId, canonicalUrl } = parseYouTubeVideoUrl(params.url);

    // Check custom testing adapter hook first if active in integration tests
    const customTestAdapter = getCustomYouTubeMediaAdapterForTesting();
    let customTestAvailability: Awaited<
      ReturnType<NonNullable<typeof customTestAdapter>['checkAvailability']>
    > | null = null;
    if (customTestAdapter) {
      customTestAvailability = await customTestAdapter.checkAvailability(
        videoId,
        canonicalUrl,
        { authorizedMediaUrl: params.authorizedMediaUrl }
      );
    }

    // Pre-probe local owner export if present so metadata fallback knows real container duration
    const localExportProbe = customTestAdapter
      ? null
      : await this.authorizedDirectMediaProvider.probeLocalOwnerExportIfPresent(videoId);

    // Pre-inspect explicit Google Drive file or Direct Authorized Media URL before metadata fallback
    let explicitDriveFile: GoogleDriveVideoFile | undefined;
    if (params.googleDriveFileId && params.googleDriveFileId.trim()) {
      if (!params.userId) {
        throw new UnauthorizedError(
          'Sign in and connect your Google account to select a Google Drive video file.',
          'GOOGLE_OAUTH_NOT_CONNECTED'
        );
      }
      explicitDriveFile = await this.googleDriveMediaProvider.inspectDriveFile(
        params.userId,
        params.googleDriveFileId.trim()
      );
    }

    let verifiedDirectUrl: {
      verifiedUrl: string;
      contentType: string;
      contentLength: number | null;
    } | null = null;
    if (
      !explicitDriveFile &&
      !customTestAdapter &&
      params.authorizedMediaUrl &&
      params.authorizedMediaUrl.trim()
    ) {
      verifiedDirectUrl =
        await this.authorizedDirectMediaProvider.preflightAuthorizedMediaUrl(
          params.authorizedMediaUrl.trim()
        );
    }

    const hasKnownMediaFallback = Boolean(
      customTestAvailability?.available ||
        localExportProbe ||
        explicitDriveFile ||
        verifiedDirectUrl
    );

    const metadata = await this.youtubeMetadataProvider.fetchVideoMetadata(params.url, {
      userId: params.userId,
      allowFallbackWhenMetadataUnreachable: hasKnownMediaFallback,
      fallbackDurationSec:
        customTestAvailability?.probedDurationSec ??
        localExportProbe?.durationSec ??
        explicitDriveFile?.durationSec ??
        null,
      fallbackTitleHint: explicitDriveFile
        ? explicitDriveFile.name.replace(/\.[a-z0-9]{2,5}$/i, '')
        : undefined,
    });

    // Re-score explicit Drive file now that full YouTube metadata (title & duration) is resolved
    if (explicitDriveFile && params.userId) {
      explicitDriveFile = await this.googleDriveMediaProvider.inspectDriveFile(
        params.userId,
        explicitDriveFile.id,
        metadata
      );
    }

    const googleAuth = await this.googleOAuthProvider.getConnectionStatus(params.userId);
    const resolutionOptions = this.buildResolutionOptions(
      Boolean(googleAuth.connected && googleAuth.hasDriveScope),
      googleAuth.oauthConfigured
    );
    const setupInstructions = this.getSetupInstructions();
    const sidecar = this.youtubeMetadataProvider.readExportManifestMetadata(videoId);

    let mediaAccess: MediaAccessEvaluation;
    let effectiveDurationSec = metadata.durationSec;

    if (customTestAdapter && customTestAvailability) {
      if (!effectiveDurationSec && customTestAvailability.probedDurationSec) {
        effectiveDurationSec = customTestAvailability.probedDurationSec;
      }
      mediaAccess = {
        available: customTestAvailability.available,
        configured: customTestAvailability.configured,
        adapterName: customTestAvailability.adapterName,
        sourceType: customTestAvailability.available
          ? 'authorized_http_provider'
          : 'unavailable',
        requiresAuthorizedMediaUrl: !customTestAvailability.available,
        requiresDriveFileSelection: !customTestAvailability.available,
        probedDurationSec: customTestAvailability.probedDurationSec ?? null,
        reason: customTestAvailability.reason,
        setupInstructions:
          customTestAvailability.setupInstructions || setupInstructions,
        guidance:
          customTestAvailability.reason ||
          `Custom adapter (${customTestAvailability.adapterName}) ready.`,
        resolutionOptions,
      };
    } else if (explicitDriveFile) {
      if (!effectiveDurationSec && explicitDriveFile.durationSec) {
        effectiveDurationSec = explicitDriveFile.durationSec;
      }
      const matchSummary =
        explicitDriveFile.match?.confidence === 'exact'
          ? `Matched to YouTube ID ${metadata.videoId}`
          : explicitDriveFile.match?.confidence === 'high'
            ? 'High-confidence title & duration match'
            : 'User-selected Google Drive video';
      const guidance = `${matchSummary}: "${explicitDriveFile.name}" ready to stream into FFmpeg & Faster-Whisper.${
        explicitDriveFile.match?.warning ? ` Note: ${explicitDriveFile.match.warning}` : ''
      }`;
      mediaAccess = {
        available: true,
        configured: true,
        adapterName: 'google_drive',
        sourceType: 'google_drive',
        requiresAuthorizedMediaUrl: false,
        requiresDriveFileSelection: false,
        probedDurationSec: explicitDriveFile.durationSec,
        matchedDriveFile: explicitDriveFile,
        guidance,
        setupInstructions,
        resolutionOptions,
      };
    } else if (verifiedDirectUrl) {
      const guidance = `Verified direct authorized media stream (${verifiedDirectUrl.contentType}) ready for download and processing.`;
      mediaAccess = {
        available: true,
        configured: true,
        adapterName: 'direct_authorized_url',
        sourceType: 'direct_authorized_url',
        requiresAuthorizedMediaUrl: false,
        requiresDriveFileSelection: false,
        guidance,
        setupInstructions,
        resolutionOptions,
      };
    } else if (localExportProbe) {
      if (!effectiveDurationSec) {
        effectiveDurationSec = localExportProbe.durationSec;
      }
      mediaAccess = {
        available: true,
        configured: true,
        adapterName: 'owner_export_dir',
        sourceType: 'owner_export_dir',
        requiresAuthorizedMediaUrl: false,
        requiresDriveFileSelection: false,
        probedDurationSec: localExportProbe.durationSec,
        guidance: `Verified owner-authorized export file found for video ${metadata.videoId}.`,
        setupInstructions,
        resolutionOptions,
      };
    } else if (sidecar?.mediaAccessError) {
      mediaAccess = {
        available: false,
        configured: true,
        adapterName: 'owner_export_dir',
        sourceType: 'unavailable',
        requiresAuthorizedMediaUrl: true,
        requiresDriveFileSelection: true,
        reason: sidecar.mediaAccessError,
        guidance: sidecar.mediaAccessError,
        setupInstructions,
        resolutionOptions,
      };
    } else if (params.userId && googleAuth.connected && googleAuth.hasDriveScope) {
      let autoMatchedFile: GoogleDriveVideoFile | undefined;
      let candidateDriveFiles: GoogleDriveVideoFile[] = [];

      try {
        const discovery =
          await this.googleDriveMediaProvider.findCandidateMatchesForYouTubeVideo(
            params.userId,
            metadata
          );
        autoMatchedFile = discovery.autoMatchedFile;
        candidateDriveFiles = discovery.candidates;
      } catch (err: any) {
        logger.warn(
          'Google Drive candidate auto-discovery failed during YouTube fetch',
          { err: err?.message, videoId: metadata.videoId }
        );
      }

      if (autoMatchedFile) {
        if (!effectiveDurationSec && autoMatchedFile.durationSec) {
          effectiveDurationSec = autoMatchedFile.durationSec;
        }
        mediaAccess = {
          available: true,
          configured: true,
          adapterName: 'google_drive',
          sourceType: 'google_drive',
          requiresAuthorizedMediaUrl: false,
          requiresDriveFileSelection: false,
          probedDurationSec: autoMatchedFile.durationSec,
          matchedDriveFile: autoMatchedFile,
          candidateDriveFiles,
          guidance: `Automatically matched Google Drive video "${autoMatchedFile.name}" with YouTube ID ${metadata.videoId}.`,
          setupInstructions,
          resolutionOptions,
        };
      } else {
        const bridge = this.authorizedDirectMediaProvider.hasExternalBridgeConfigured();
        if (bridge.configured) {
          mediaAccess = {
            available: true,
            configured: true,
            adapterName: bridge.adapterName,
            sourceType: bridge.sourceType,
            requiresAuthorizedMediaUrl: false,
            requiresDriveFileSelection: false,
            candidateDriveFiles,
            guidance: `Authorized media bridge (${bridge.adapterName}) configured for acquisition.`,
            setupInstructions,
            resolutionOptions,
          };
        } else {
          const reason =
            candidateDriveFiles.length > 0
              ? `YouTube metadata recognized, but no Drive file contained exact video ID "${metadata.videoId}". Select the matching export from your Google Drive files below, or paste a Direct Authorized Media URL.`
              : `YouTube metadata recognized, but no video files were found in your connected Google Drive for "${metadata.videoId}". Upload your export to Google Drive and refresh, paste a Direct Authorized Media URL, or use Direct Upload.`;
          mediaAccess = {
            available: false,
            configured: true,
            adapterName: 'google_drive',
            sourceType: 'unavailable',
            requiresAuthorizedMediaUrl: true,
            requiresDriveFileSelection: true,
            candidateDriveFiles,
            reason,
            guidance: reason,
            setupInstructions,
            resolutionOptions,
          };
        }
      }
    } else {
      const bridge = this.authorizedDirectMediaProvider.hasExternalBridgeConfigured();
      if (bridge.configured) {
        mediaAccess = {
          available: true,
          configured: true,
          adapterName: bridge.adapterName,
          sourceType: bridge.sourceType,
          requiresAuthorizedMediaUrl: false,
          requiresDriveFileSelection: false,
          guidance: `Authorized media bridge (${bridge.adapterName}) is configured and ready.`,
          setupInstructions,
          resolutionOptions,
        };
      } else {
        const reason = googleAuth.oauthConfigured
          ? `YouTube metadata was recognized, but YouTube public metadata APIs (oEmbed / Data API v3) do not provide raw video streams. Connect your Google account to select your original export from Google Drive, paste a Direct Authorized Media URL (MP4/MOV/WebM), or use Direct Upload.`
          : `YouTube metadata was recognized, but raw video media requires an authorized source. Paste a Direct Authorized Media URL (presigned S3/GCS/R2/CDN MP4/MOV/WebM), configure Google OAuth for Google Drive exports, or upload your video file directly.`;
        mediaAccess = {
          available: false,
          configured: false,
          adapterName: 'unavailable',
          sourceType: 'unavailable',
          requiresAuthorizedMediaUrl: true,
          requiresDriveFileSelection: true,
          reason,
          guidance: reason,
          setupInstructions,
          resolutionOptions,
        };
      }
    }

    if (effectiveDurationSec !== null && effectiveDurationSec > maxDurationSec + 5) {
      throw new BadRequestError(
        `YouTube video duration (${Math.round(
          effectiveDurationSec / 3600
        )}h ${Math.round(
          (effectiveDurationSec % 3600) / 60
        )}m) exceeds the maximum supported length of ${Math.round(
          maxDurationSec / 3600
        )} hours (${maxDurationSec}s).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    const effectiveMetadata: YouTubeVideoMetadata = {
      ...metadata,
      durationSec: effectiveDurationSec,
    };

    const clipCount = params.clipCount || DEFAULT_PROCESSING_SETTINGS.clipCount;
    const estimatedCredits = await calculateJobCreditCost(
      effectiveDurationSec ?? 600,
      clipCount
    );

    return {
      metadata: effectiveMetadata,
      estimatedCredits,
      mediaAccess,
      googleAuth,
    };
  }

  async acquireMedia(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAcquireOptions & {
      targetVideo?: Pick<YouTubeVideoMetadata, 'videoId' | 'title' | 'durationSec'>;
    }
  ): Promise<AcquiredMediaResult> {
    // 0. Custom testing adapter override (used in integration tests)
    const customTestAdapter = getCustomYouTubeMediaAdapterForTesting();
    if (customTestAdapter) {
      const acquired = await customTestAdapter.acquireMedia(videoId, canonicalUrl, destDir, {
        authorizedMediaUrl: options?.authorizedMediaUrl,
        maxDurationSec: options?.maxDurationSec,
        signal: options?.signal,
        onProgress: options?.onProgress,
      });
      return {
        ...acquired,
        sourceType: 'authorized_http_provider',
      };
    }

    // 1. Explicit Google Drive file selected
    if (options?.googleDriveFileId && options.googleDriveFileId.trim()) {
      if (!options.userId) {
        throw new UnauthorizedError(
          'User context is required to download an authorized Google Drive video.',
          'GOOGLE_OAUTH_NOT_CONNECTED'
        );
      }
      return this.googleDriveMediaProvider.acquireDriveFileToDisk(videoId, destDir, {
        ...options,
        userId: options.userId,
        googleDriveFileId: options.googleDriveFileId.trim(),
      });
    }

    // 2. Explicit Direct Authorized Media URL provided
    if (options?.authorizedMediaUrl && options.authorizedMediaUrl.trim()) {
      return this.authorizedDirectMediaProvider.acquireFromDirectUrl(
        videoId,
        options.authorizedMediaUrl.trim(),
        destDir,
        options
      );
    }

    // 3. Local owner-authorized export directory
    if (this.authorizedDirectMediaProvider.findLocalOwnerExportFile(videoId)) {
      return this.authorizedDirectMediaProvider.acquireFromLocalOwnerExport(
        videoId,
        options
      );
    }

    const sidecar = this.youtubeMetadataProvider.readExportManifestMetadata(videoId);
    if (sidecar?.mediaAccessError) {
      throw new AppError(sidecar.mediaAccessError, 422, 'YOUTUBE_MEDIA_ACCESS_FAILED');
    }

    // 4. Auto-matched Google Drive file by exact videoId if user has Drive connected
    if (options?.userId) {
      const status = await this.googleOAuthProvider.getConnectionStatus(options.userId);
      if (status.connected && status.hasDriveScope) {
        const discovery =
          await this.googleDriveMediaProvider.findCandidateMatchesForYouTubeVideo(
            options.userId,
            options.targetVideo || {
              videoId,
              title: `YouTube Video ${videoId}`,
              durationSec: null,
            }
          );
        if (discovery.autoMatchedFile) {
          return this.googleDriveMediaProvider.acquireDriveFileToDisk(videoId, destDir, {
            ...options,
            userId: options.userId,
            googleDriveFileId: discovery.autoMatchedFile.id,
          });
        }
      }
    }

    // 5. Configured external HTTP bridge or custom command
    const bridge = this.authorizedDirectMediaProvider.hasExternalBridgeConfigured();
    if (bridge.configured) {
      return this.authorizedDirectMediaProvider.acquireFromConfiguredBridge(
        videoId,
        canonicalUrl,
        destDir,
        options
      );
    }

    throw new AppError(
      `Cannot acquire video stream for YouTube ID "${videoId}": YouTube metadata APIs (oEmbed / Data API v3) only provide metadata, not raw video files, and ClipForge AI never bypasses access controls or DRM. ${this.getSetupInstructions()}`,
      422,
      'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED'
    );
  }
}

let singletonMediaAcquisitionService: MediaAcquisitionService | null = null;

export function getMediaAcquisitionService(): MediaAcquisitionService {
  if (!singletonMediaAcquisitionService) {
    singletonMediaAcquisitionService = new MediaAcquisitionService();
  }
  return singletonMediaAcquisitionService;
}
