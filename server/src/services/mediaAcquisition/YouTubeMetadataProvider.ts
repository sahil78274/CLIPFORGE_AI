import fs from 'fs';
import net from 'net';
import path from 'path';
import type { YouTubeVideoMetadata } from '@clipforge/shared';
import { env } from '../../config/env';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';
import { isPrivateOrReservedIp } from '../urlSafetyService';
import {
  GOOGLE_YOUTUBE_READONLY_SCOPE,
  GoogleOAuthProvider,
} from './GoogleOAuthProvider';

const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export interface ParsedYouTubeUrl {
  videoId: string;
  canonicalUrl: string;
  isShortUrl: boolean;
}

export function isYouTubeWebUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseYouTubeVideoUrl(rawUrl: string): ParsedYouTubeUrl {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new BadRequestError('Please enter a YouTube video URL.', 'INVALID_YOUTUBE_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new BadRequestError(
      'Invalid URL syntax. Example: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'INVALID_YOUTUBE_URL'
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestError(
      'Only HTTP and HTTPS YouTube URLs are supported.',
      'INVALID_YOUTUBE_URL'
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (net.isIP(host) && isPrivateOrReservedIp(host))
  ) {
    throw new ForbiddenError(
      'Private, loopback, and internal network addresses are blocked (SSRF protection).',
      'SSRF_BLOCKED'
    );
  }

  if (!YOUTUBE_HOSTS.has(host)) {
    throw new BadRequestError(
      `Unsupported domain "${host}". Paste a valid youtube.com or youtu.be video link.`,
      'INVALID_YOUTUBE_URL'
    );
  }

  let candidateId: string | null = null;
  let isShortUrl = false;
  const pathSegments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    candidateId = pathSegments[0] || null;
  } else if (parsed.pathname === '/watch') {
    candidateId = parsed.searchParams.get('v');
  } else if (
    pathSegments.length >= 2 &&
    ['shorts', 'embed', 'live', 'v'].includes(pathSegments[0].toLowerCase())
  ) {
    isShortUrl = pathSegments[0].toLowerCase() === 'shorts';
    candidateId = pathSegments[1];
  } else if (parsed.searchParams.has('v')) {
    candidateId = parsed.searchParams.get('v');
  }

  if (!candidateId || !YOUTUBE_VIDEO_ID_REGEX.test(candidateId)) {
    throw new BadRequestError(
      'Could not detect a valid 11-character YouTube video ID in this URL. Channel and playlist-only URLs without a video ID are not supported.',
      'MISSING_YOUTUBE_VIDEO_ID'
    );
  }

  return {
    videoId: candidateId,
    canonicalUrl: `https://www.youtube.com/watch?v=${candidateId}`,
    isShortUrl,
  };
}

export function parseIso8601DurationSec(isoDuration?: string | null): number | null {
  if (!isoDuration || typeof isoDuration !== 'string') return null;
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      isoDuration.trim()
    );
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

export interface ExportSidecarMetadata {
  title?: string;
  channelId?: string;
  channelName?: string;
  thumbnailUrl?: string;
  durationSec?: number | null;
  privacyStatus?: 'public' | 'unlisted' | 'private' | 'unavailable';
  isLiveStream?: boolean;
  mediaAccessError?: string;
}

/**
 * Strictly fetches YouTube video metadata and verifies channel ownership where Google OAuth is connected.
 * Never treats oEmbed or YouTube Data API JSON responses as downloadable video files.
 */
export class YouTubeMetadataProvider {
  constructor(private readonly googleOAuthProvider: GoogleOAuthProvider) {}

  readExportManifestMetadata(videoId: string): ExportSidecarMetadata | null {
    const dir = path.resolve(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR);
    const metaPath = path.join(dir, `${videoId}.meta.json`);
    if (!fs.existsSync(metaPath)) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return {
        title: typeof raw.title === 'string' ? raw.title : undefined,
        channelId: typeof raw.channelId === 'string' ? raw.channelId : undefined,
        channelName: typeof raw.channelName === 'string' ? raw.channelName : undefined,
        thumbnailUrl: typeof raw.thumbnailUrl === 'string' ? raw.thumbnailUrl : undefined,
        durationSec:
          typeof raw.durationSec === 'number' && raw.durationSec > 0 ? raw.durationSec : null,
        privacyStatus:
          raw.privacyStatus === 'private' ||
          raw.privacyStatus === 'unlisted' ||
          raw.privacyStatus === 'unavailable'
            ? raw.privacyStatus
            : 'public',
        isLiveStream: Boolean(raw.isLiveStream),
        mediaAccessError:
          typeof raw.mediaAccessError === 'string' ? raw.mediaAccessError : undefined,
      };
    } catch {
      return null;
    }
  }

  private parseYouTubeApiVideoItem(
    item: any,
    videoId: string,
    canonicalUrl: string,
    options: {
      source: 'youtube_oauth_api' | 'youtube_data_api';
      ownedChannelIds: Set<string>;
    }
  ): YouTubeVideoMetadata {
    const privacyStatus = (item.status?.privacyStatus || 'public') as
      | 'public'
      | 'unlisted'
      | 'private';
    const channelId = item.snippet?.channelId ? String(item.snippet.channelId) : undefined;
    const channelOwnershipVerified = Boolean(channelId && options.ownedChannelIds.has(channelId));

    if (privacyStatus === 'private' && !channelOwnershipVerified) {
      throw new ForbiddenError(
        'Private YouTube videos cannot be imported unless you connect the Google account that owns or manages this YouTube channel.',
        'YOUTUBE_VIDEO_PRIVATE'
      );
    }

    const liveBroadcastContent = String(item.snippet?.liveBroadcastContent || 'none');
    const durationSec = parseIso8601DurationSec(item.contentDetails?.duration);
    if (
      (liveBroadcastContent === 'live' || liveBroadcastContent === 'upcoming') &&
      !durationSec
    ) {
      throw new BadRequestError(
        'Active or upcoming YouTube live streams without a completed VOD duration cannot be processed until the broadcast finishes.',
        'YOUTUBE_LIVE_UNSUPPORTED'
      );
    }

    const thumbs = item.snippet?.thumbnails || {};
    const thumbnailUrl =
      thumbs.maxres?.url ||
      thumbs.standard?.url ||
      thumbs.high?.url ||
      thumbs.medium?.url ||
      thumbs.default?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    return {
      videoId,
      canonicalUrl,
      title: String(item.snippet?.title || `YouTube Video (${videoId})`),
      channelId,
      channelName: String(item.snippet?.channelTitle || 'YouTube Creator'),
      channelOwnershipVerified,
      thumbnailUrl,
      durationSec,
      privacyStatus,
      isLiveStream: liveBroadcastContent === 'live',
      metadataSource: options.source,
    };
  }

  private async tryFetchViaUserOAuth(
    userId: string,
    videoId: string,
    canonicalUrl: string
  ): Promise<{ metadata: YouTubeVideoMetadata | null; ownedChannelIds: Set<string> }> {
    const ownedChannelIds = new Set<string>();
    try {
      const { accessToken, integration } = await this.googleOAuthProvider.getValidAccessToken(
        userId,
        GOOGLE_YOUTUBE_READONLY_SCOPE
      );

      for (const ch of integration.channels || []) {
        if (ch?.channelId) ownedChannelIds.add(ch.channelId);
      }

      if (ownedChannelIds.size === 0) {
        const fetchedChannels =
          await this.googleOAuthProvider.fetchManagedYouTubeChannels(accessToken);
        if (fetchedChannels.length > 0) {
          integration.channels = fetchedChannels;
          await integration.save();
          for (const ch of fetchedChannels) {
            if (ch.channelId) ownedChannelIds.add(ch.channelId);
          }
        }
      }

      const base = env.YOUTUBE_API_BASE_URL.replace(/\/+$/, '');
      const apiUrl = new URL(`${base}/videos`);
      apiUrl.searchParams.set('part', 'snippet,contentDetails,status');
      apiUrl.searchParams.set('id', videoId);

      const res = await fetch(apiUrl.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        logger.warn(
          'User OAuth YouTube Data API lookup returned non-200; falling back to next metadata source',
          { status: res.status, videoId }
        );
        return { metadata: null, ownedChannelIds };
      }

      const data: any = await res.json();
      const item = Array.isArray(data?.items) ? data.items[0] : null;
      if (!item) {
        return { metadata: null, ownedChannelIds };
      }

      return {
        metadata: this.parseYouTubeApiVideoItem(item, videoId, canonicalUrl, {
          source: 'youtube_oauth_api',
          ownedChannelIds,
        }),
        ownedChannelIds,
      };
    } catch (err: any) {
      if (
        err instanceof ForbiddenError ||
        err instanceof BadRequestError ||
        err instanceof NotFoundError
      ) {
        throw err;
      }
      return { metadata: null, ownedChannelIds };
    }
  }

  async fetchVideoMetadata(
    rawUrl: string,
    options?: {
      userId?: string;
      allowFallbackWhenMetadataUnreachable?: boolean;
      fallbackDurationSec?: number | null;
      fallbackTitleHint?: string;
    }
  ): Promise<YouTubeVideoMetadata> {
    const { videoId, canonicalUrl } = parseYouTubeVideoUrl(rawUrl);

    let ownedChannelIds = new Set<string>();

    // 1. Authenticated Google OAuth YouTube Data API v3 (verifies channel ownership + owner unlisted/private metadata)
    if (options?.userId) {
      const oauthAttempt = await this.tryFetchViaUserOAuth(
        options.userId,
        videoId,
        canonicalUrl
      );
      ownedChannelIds = oauthAttempt.ownedChannelIds;
      if (oauthAttempt.metadata) {
        return oauthAttempt.metadata;
      }
    }

    const sidecar = this.readExportManifestMetadata(videoId);
    if (
      sidecar?.privacyStatus === 'private' &&
      !(sidecar.channelId && ownedChannelIds.has(sidecar.channelId))
    ) {
      throw new ForbiddenError(
        'This YouTube video is private and cannot be imported unless you connect the owning YouTube channel.',
        'YOUTUBE_VIDEO_PRIVATE'
      );
    }
    if (sidecar?.privacyStatus === 'unavailable') {
      throw new NotFoundError(
        'This YouTube video is unavailable, deleted, or restricted.',
        'YOUTUBE_VIDEO_UNAVAILABLE'
      );
    }

    // 2. Platform API key YouTube Data API v3
    if (env.YOUTUBE_DATA_API_KEY && env.YOUTUBE_DATA_API_KEY.trim().length > 8) {
      const base = env.YOUTUBE_API_BASE_URL.replace(/\/+$/, '');
      const apiUrl = new URL(`${base}/videos`);
      apiUrl.searchParams.set('part', 'snippet,contentDetails,status');
      apiUrl.searchParams.set('id', videoId);
      apiUrl.searchParams.set('key', env.YOUTUBE_DATA_API_KEY.trim());

      try {
        const res = await fetch(apiUrl.toString(), {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });

        if (res.ok) {
          const data: any = await res.json();
          const item = Array.isArray(data?.items) ? data.items[0] : null;
          if (!item) {
            throw new NotFoundError(
              'YouTube video was not found. It may be private, deleted, or unavailable.',
              'YOUTUBE_VIDEO_UNAVAILABLE'
            );
          }

          return this.parseYouTubeApiVideoItem(item, videoId, canonicalUrl, {
            source: 'youtube_data_api',
            ownedChannelIds,
          });
        }
      } catch (err: any) {
        if (err instanceof AppError) throw err;
        logger.warn(
          'YouTube Data API v3 request failed; trying fallback metadata providers',
          { err: err?.message, videoId }
        );
      }
    }

    // 3. Public YouTube oEmbed endpoint (strictly metadata; never used as video file)
    if (env.YOUTUBE_OEMBED_ENDPOINT) {
      try {
        const oembedUrl = new URL(env.YOUTUBE_OEMBED_ENDPOINT);
        oembedUrl.searchParams.set('url', canonicalUrl);
        oembedUrl.searchParams.set('format', 'json');

        const res = await fetch(oembedUrl.toString(), {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'ClipForgeAI-MetadataClient/1.0',
          },
          signal: AbortSignal.timeout(6000),
        });

        if (res.status === 401 || res.status === 403) {
          throw new ForbiddenError(
            'This YouTube video is private or embedding/access is restricted by the owner.',
            'YOUTUBE_VIDEO_PRIVATE'
          );
        }
        if (res.status === 404) {
          throw new NotFoundError(
            'This YouTube video is unavailable or does not exist.',
            'YOUTUBE_VIDEO_UNAVAILABLE'
          );
        }

        if (res.ok) {
          const data: any = await res.json();
          const channelId = sidecar?.channelId;
          return {
            videoId,
            canonicalUrl,
            title: String(sidecar?.title || data.title || `YouTube Video (${videoId})`),
            channelId,
            channelName: String(
              sidecar?.channelName || data.author_name || 'YouTube Channel'
            ),
            channelOwnershipVerified: Boolean(channelId && ownedChannelIds.has(channelId)),
            thumbnailUrl: String(
              sidecar?.thumbnailUrl ||
                data.thumbnail_url ||
                `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            ),
            durationSec: options?.fallbackDurationSec ?? sidecar?.durationSec ?? null,
            privacyStatus: 'public',
            isLiveStream: false,
            metadataSource: 'youtube_oembed',
          };
        }
      } catch (err: any) {
        if (err instanceof AppError) throw err;
        logger.warn(
          'YouTube oEmbed metadata lookup unreachable in current network',
          { err: err?.message, videoId }
        );
      }
    }

    // 4. Local owner-authorized export manifest or verified authorized media fallback
    if (sidecar || options?.allowFallbackWhenMetadataUnreachable) {
      const channelId = sidecar?.channelId;
      return {
        videoId,
        canonicalUrl,
        title:
          sidecar?.title ||
          options?.fallbackTitleHint ||
          `YouTube Export (${videoId})`,
        channelId,
        channelName: sidecar?.channelName || 'Authorized Channel Export',
        channelOwnershipVerified: Boolean(channelId && ownedChannelIds.has(channelId)),
        thumbnailUrl:
          sidecar?.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        durationSec: options?.fallbackDurationSec ?? sidecar?.durationSec ?? null,
        privacyStatus:
          sidecar?.privacyStatus === 'unlisted' || sidecar?.privacyStatus === 'private'
            ? sidecar.privacyStatus
            : 'public',
        isLiveStream: false,
        metadataSource: 'authorized_export_manifest',
      };
    }

    throw new AppError(
      `Unable to fetch YouTube metadata for video "${videoId}" (external YouTube API/oEmbed unreachable and no authorized export manifest found). Connect Google OAuth, configure YOUTUBE_DATA_API_KEY, or upload the video file directly.`,
      503,
      'YOUTUBE_METADATA_UNAVAILABLE'
    );
  }
}
