import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { env } from '../config/env';
import { probeMediaFile, type MediaProbeInfo } from './mediaProbeService';
import { assertUrlSafeFromSsrf } from './urlSafetyService';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';

export interface YouTubeExportSidecarMeta {
  title?: string;
  channelName?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  privacyStatus?: 'public' | 'unlisted' | 'private' | 'unavailable';
  mediaAccessError?: string;
}

export interface MediaAccessOptions {
  authorizedMediaUrl?: string;
}

export interface MediaAvailabilityReport {
  available: boolean;
  adapterName: string;
  configured: boolean;
  reason?: string;
  setupInstructions?: string;
  probedDurationSec?: number | null;
  sidecarMeta?: YouTubeExportSidecarMeta;
}

export interface AcquiredYouTubeMedia {
  localFilePath: string;
  adapterName: string;
  mimeType: string;
  probe: MediaProbeInfo;
  cleanupAfterStore: boolean;
}

export interface YouTubeMediaSourceAdapter {
  readonly name: string;
  isConfigured(): boolean;
  getSetupInstructions(): string;
  checkAvailability(
    videoId: string,
    canonicalUrl: string,
    options?: MediaAccessOptions
  ): Promise<MediaAvailabilityReport>;
  acquireMedia(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAccessOptions & {
      onProgress?: (percent: number, message: string) => void;
      signal?: AbortSignal;
      maxDurationSec?: number;
    }
  ): Promise<AcquiredYouTubeMedia>;
}

const SUPPORTED_MEDIA_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'] as const;

function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.mov':
      return 'video/quicktime';
    default:
      return 'video/mp4';
  }
}

async function streamUrlToLocalFile(params: {
  url: string;
  headers?: Record<string, string>;
  destPath: string;
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}): Promise<void> {
  fs.mkdirSync(path.dirname(params.destPath), { recursive: true });

  const res = await fetch(params.url, {
    method: 'GET',
    headers: params.headers,
    redirect: 'follow',
    signal: params.signal,
  });

  if (res.status === 401 || res.status === 403) {
    throw new ForbiddenError(
      `Authorized media source denied access (HTTP ${res.status}). Verify owner authorization or media token.`,
      'YOUTUBE_MEDIA_ACCESS_FAILED'
    );
  }
  if (res.status === 404) {
    throw new NotFoundError(
      'Video stream was not found on the configured authorized media source.',
      'YOUTUBE_VIDEO_UNAVAILABLE'
    );
  }
  if (!res.ok || !res.body) {
    throw new AppError(
      `Authorized media source failed with HTTP ${res.status}`,
      502,
      'YOUTUBE_MEDIA_ACCESS_FAILED'
    );
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (
    contentType.includes('application/json') ||
    contentType.includes('text/html') ||
    contentType.startsWith('image/')
  ) {
    throw new BadRequestError(
      `Media endpoint returned non-video payload (${contentType}). Metadata/oEmbed responses cannot be used as video media.`,
      'YOUTUBE_MEDIA_NOT_VIDEO'
    );
  }

  const contentLen = Number(res.headers.get('content-length') || 0);
  const nodeReadable = Readable.fromWeb(res.body as any);
  let downloaded = 0;
  let lastReportedPct = -1;

  nodeReadable.on('data', (chunk: Buffer) => {
    downloaded += chunk.length;
    if (contentLen > 0 && params.onProgress) {
      const pct = Math.min(99, Math.floor((downloaded / contentLen) * 100));
      if (pct >= lastReportedPct + 5) {
        lastReportedPct = pct;
        params.onProgress(pct, `Streaming authorized media to disk (${pct}%)...`);
      }
    }
  });

  const writeStream = fs.createWriteStream(params.destPath);
  try {
    await pipeline(nodeReadable, writeStream);
  } catch (err) {
    if (fs.existsSync(params.destPath)) {
      fs.unlinkSync(params.destPath);
    }
    throw err;
  }
}

/**
 * Adapter 1: Owner-Authorized Exports Directory & Signed Export URLs
 * Supports creator/channel-owner authorized video exports placed in YOUTUBE_AUTHORIZED_EXPORTS_DIR
 * (<videoId>.mp4|.mkv|.webm|.mov + optional <videoId>.meta.json) or an explicit SSRF-safe signed export URL.
 */
export class OwnerAuthorizedExportAdapter implements YouTubeMediaSourceAdapter {
  public readonly name = 'owner_export_dir';

  isConfigured(): boolean {
    return Boolean(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR);
  }

  getSetupInstructions(): string {
    return (
      `Place owner-authorized YouTube video exports in YOUTUBE_AUTHORIZED_EXPORTS_DIR ` +
      `(${env.YOUTUBE_AUTHORIZED_EXPORTS_DIR}/<videoId>.mp4), provide an owner-authorized signed media URL, ` +
      `or configure YOUTUBE_MEDIA_PROVIDER_URL in .env.`
    );
  }

  public readSidecarMeta(videoId: string): YouTubeExportSidecarMeta | undefined {
    const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, '');
    const metaPath = path.join(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR, `${safeId}.meta.json`);
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as YouTubeExportSidecarMeta;
    } catch {
      return undefined;
    }
  }

  public findLocalExportFile(videoId: string): string | null {
    const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, '');
    const baseDir = path.resolve(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR);
    if (!fs.existsSync(baseDir)) return null;

    for (const ext of SUPPORTED_MEDIA_EXTENSIONS) {
      const candidate = path.resolve(baseDir, `${safeId}${ext}`);
      if (candidate.startsWith(baseDir + path.sep) && fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) {
          return candidate;
        }
      }
    }
    return null;
  }

  async checkAvailability(
    videoId: string,
    _canonicalUrl: string,
    options?: MediaAccessOptions
  ): Promise<MediaAvailabilityReport> {
    const sidecar = this.readSidecarMeta(videoId);

    if (sidecar?.privacyStatus === 'private') {
      throw new ForbiddenError(
        'This YouTube video is marked private and cannot be accessed.',
        'YOUTUBE_VIDEO_PRIVATE'
      );
    }
    if (sidecar?.privacyStatus === 'unavailable') {
      throw new NotFoundError(
        'This YouTube video is unavailable or has been removed.',
        'YOUTUBE_VIDEO_UNAVAILABLE'
      );
    }
    if (sidecar?.mediaAccessError) {
      return {
        available: false,
        adapterName: this.name,
        configured: true,
        reason: sidecar.mediaAccessError,
        setupInstructions: this.getSetupInstructions(),
        sidecarMeta: sidecar,
      };
    }

    if (options?.authorizedMediaUrl) {
      await assertUrlSafeFromSsrf(options.authorizedMediaUrl);
      return {
        available: true,
        adapterName: 'owner_signed_url',
        configured: true,
        probedDurationSec: sidecar?.durationSec ?? null,
        sidecarMeta: sidecar,
      };
    }

    const localFile = this.findLocalExportFile(videoId);
    if (localFile) {
      let probedDurationSec: number | null = sidecar?.durationSec ?? null;
      if (probedDurationSec === null) {
        const probe = await probeMediaFile(localFile);
        probedDurationSec = probe.durationSec;
      }
      return {
        available: true,
        adapterName: this.name,
        configured: true,
        probedDurationSec,
        sidecarMeta: sidecar,
      };
    }

    return {
      available: false,
      adapterName: this.name,
      configured: fs.existsSync(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR),
      reason: `No authorized video media file found for YouTube ID "${videoId}". YouTube oEmbed/Data API provides metadata only, not raw video streams.`,
      setupInstructions: this.getSetupInstructions(),
      sidecarMeta: sidecar,
    };
  }

  async acquireMedia(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAccessOptions & {
      onProgress?: (percent: number, message: string) => void;
      signal?: AbortSignal;
      maxDurationSec?: number;
    }
  ): Promise<AcquiredYouTubeMedia> {
    const availability = await this.checkAvailability(videoId, canonicalUrl, options);
    if (!availability.available) {
      throw new AppError(
        availability.reason || 'Authorized media stream is not available for this YouTube video.',
        422,
        'YOUTUBE_MEDIA_ACCESS_FAILED'
      );
    }

    if (options?.authorizedMediaUrl) {
      await assertUrlSafeFromSsrf(options.authorizedMediaUrl);
      const parsedUrl = new URL(options.authorizedMediaUrl);
      const ext =
        SUPPORTED_MEDIA_EXTENSIONS.find((e) =>
          parsedUrl.pathname.toLowerCase().endsWith(e)
        ) || '.mp4';
      const destPath = path.join(destDir, `yt_${videoId}${ext}`);
      await streamUrlToLocalFile({
        url: options.authorizedMediaUrl,
        destPath,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      const probe = await probeMediaFile(destPath);
      if (options.maxDurationSec && probe.durationSec > options.maxDurationSec + 5) {
        fs.unlinkSync(destPath);
        throw new BadRequestError(
          `Video duration (${Math.round(probe.durationSec)}s) exceeds maximum limit (${options.maxDurationSec}s).`,
          'VIDEO_DURATION_LIMIT_EXCEEDED'
        );
      }
      return {
        localFilePath: destPath,
        adapterName: 'owner_signed_url',
        mimeType: mimeForExtension(ext),
        probe,
        cleanupAfterStore: true,
      };
    }

    const localExport = this.findLocalExportFile(videoId);
    if (!localExport) {
      throw new AppError(
        `Authorized export file for YouTube ID "${videoId}" could not be read.`,
        422,
        'YOUTUBE_MEDIA_ACCESS_FAILED'
      );
    }

    options?.onProgress?.(60, 'Validating owner-authorized media container with FFprobe...');
    const probe = await probeMediaFile(localExport);
    if (options?.maxDurationSec && probe.durationSec > options.maxDurationSec + 5) {
      throw new BadRequestError(
        `Video duration (${Math.round(probe.durationSec)}s) exceeds maximum limit (${options.maxDurationSec}s).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    const ext = path.extname(localExport) || '.mp4';
    return {
      localFilePath: localExport,
      adapterName: this.name,
      mimeType: mimeForExtension(ext),
      probe,
      cleanupAfterStore: false,
    };
  }
}

/**
 * Adapter 2: Authorized HTTP Media Bridge
 * Connects to an organization's licensed media ingestion API (YOUTUBE_MEDIA_PROVIDER_URL)
 * and streams video directly to disk without buffering in RAM.
 */
export class AuthorizedHttpBridgeAdapter implements YouTubeMediaSourceAdapter {
  public readonly name = 'authorized_http_provider';

  isConfigured(): boolean {
    return Boolean(env.YOUTUBE_MEDIA_PROVIDER_URL && env.YOUTUBE_MEDIA_PROVIDER_URL.trim());
  }

  getSetupInstructions(): string {
    return 'Set YOUTUBE_MEDIA_PROVIDER_URL (and optional YOUTUBE_MEDIA_PROVIDER_TOKEN) in .env to connect an authorized HTTP media provider.';
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (env.YOUTUBE_MEDIA_PROVIDER_TOKEN) {
      headers.Authorization = `Bearer ${env.YOUTUBE_MEDIA_PROVIDER_TOKEN}`;
    }
    return headers;
  }

  async checkAvailability(
    videoId: string,
    canonicalUrl: string
  ): Promise<MediaAvailabilityReport> {
    if (!this.isConfigured()) {
      return {
        available: false,
        adapterName: this.name,
        configured: false,
        reason: 'YOUTUBE_MEDIA_PROVIDER_URL is NOT CONFIGURED.',
        setupInstructions: this.getSetupInstructions(),
      };
    }

    const base = env.YOUTUBE_MEDIA_PROVIDER_URL.replace(/\/$/, '');
    const checkEndpoint = `${base}/availability?videoId=${encodeURIComponent(
      videoId
    )}&url=${encodeURIComponent(canonicalUrl)}`;

    try {
      const res = await fetch(checkEndpoint, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      if (res.status === 403) {
        throw new ForbiddenError(
          'This YouTube video is private or not authorized for media access.',
          'YOUTUBE_VIDEO_PRIVATE'
        );
      }
      if (res.status === 404) {
        throw new NotFoundError(
          'This YouTube video is unavailable on the authorized media provider.',
          'YOUTUBE_VIDEO_UNAVAILABLE'
        );
      }
      if (!res.ok) {
        return {
          available: false,
          adapterName: this.name,
          configured: true,
          reason: `Authorized HTTP media provider returned status ${res.status}.`,
          setupInstructions: this.getSetupInstructions(),
        };
      }
      const data: any = await res.json();
      return {
        available: Boolean(data.available !== false),
        adapterName: this.name,
        configured: true,
        reason: data.reason,
        probedDurationSec: typeof data.durationSec === 'number' ? data.durationSec : null,
        sidecarMeta: data.metadata,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      return {
        available: false,
        adapterName: this.name,
        configured: true,
        reason: `Unable to reach configured YOUTUBE_MEDIA_PROVIDER_URL: ${(err as Error).message}`,
        setupInstructions: this.getSetupInstructions(),
      };
    }
  }

  async acquireMedia(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAccessOptions & {
      onProgress?: (percent: number, message: string) => void;
      signal?: AbortSignal;
      maxDurationSec?: number;
    }
  ): Promise<AcquiredYouTubeMedia> {
    if (!this.isConfigured()) {
      throw new AppError(
        `Authorized HTTP media provider is NOT CONFIGURED. ${this.getSetupInstructions()}`,
        503,
        'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED'
      );
    }

    const base = env.YOUTUBE_MEDIA_PROVIDER_URL.replace(/\/$/, '');
    const streamEndpoint = `${base}/stream?videoId=${encodeURIComponent(
      videoId
    )}&url=${encodeURIComponent(canonicalUrl)}`;
    const destPath = path.join(destDir, `yt_${videoId}.mp4`);

    await streamUrlToLocalFile({
      url: streamEndpoint,
      headers: this.buildHeaders(),
      destPath,
      signal: options?.signal,
      onProgress: options?.onProgress,
    });

    const probe = await probeMediaFile(destPath);
    if (options?.maxDurationSec && probe.durationSec > options.maxDurationSec) {
      fs.unlinkSync(destPath);
      throw new BadRequestError(
        `Video duration (${Math.round(probe.durationSec)}s) exceeds maximum limit (${options.maxDurationSec}s).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    return {
      localFilePath: destPath,
      adapterName: this.name,
      mimeType: 'video/mp4',
      probe,
      cleanupAfterStore: true,
    };
  }
}

/**
 * Adapter 3: Configurable Command Media Adapter (strictly shell: false)
 * Invokes an administrator-configured authorized acquisition binary without shell interpolation.
 */
export class AuthorizedCommandMediaAdapter implements YouTubeMediaSourceAdapter {
  public readonly name = 'custom_command';

  isConfigured(): boolean {
    return Boolean(env.YOUTUBE_MEDIA_COMMAND_BIN && env.YOUTUBE_MEDIA_COMMAND_BIN.trim());
  }

  getSetupInstructions(): string {
    return 'Set YOUTUBE_MEDIA_COMMAND_BIN and YOUTUBE_MEDIA_COMMAND_ARGS_JSON (using {videoId}, {url}, {outputPath} placeholders) in .env.';
  }

  async checkAvailability(): Promise<MediaAvailabilityReport> {
    if (!this.isConfigured()) {
      return {
        available: false,
        adapterName: this.name,
        configured: false,
        reason: 'YOUTUBE_MEDIA_COMMAND_BIN is NOT CONFIGURED.',
        setupInstructions: this.getSetupInstructions(),
      };
    }
    return {
      available: true,
      adapterName: this.name,
      configured: true,
    };
  }

  async acquireMedia(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAccessOptions & {
      onProgress?: (percent: number, message: string) => void;
      signal?: AbortSignal;
      maxDurationSec?: number;
    }
  ): Promise<AcquiredYouTubeMedia> {
    if (!this.isConfigured()) {
      throw new AppError(
        `Custom media command adapter is NOT CONFIGURED. ${this.getSetupInstructions()}`,
        503,
        'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED'
      );
    }

    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, `yt_${videoId}.mp4`);

    let rawTemplate: string[] = ['{url}', '-o', '{outputPath}'];
    if (env.YOUTUBE_MEDIA_COMMAND_ARGS_JSON) {
      const parsed = JSON.parse(env.YOUTUBE_MEDIA_COMMAND_ARGS_JSON);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        rawTemplate = parsed;
      }
    }

    const args = rawTemplate.map((arg) =>
      arg
        .replace(/\{videoId\}/g, videoId)
        .replace(/\{url\}/g, canonicalUrl)
        .replace(/\{outputPath\}/g, destPath)
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(env.YOUTUBE_MEDIA_COMMAND_BIN, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-1500);
      });

      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGTERM');
            reject(new AppError('Media acquisition aborted', 499, 'JOB_CANCELLED'));
          },
          { once: true }
        );
      }

      child.on('error', (err) => {
        reject(
          new AppError(
            `Authorized media command failed to start: ${err.message}`,
            502,
            'YOUTUBE_MEDIA_ACCESS_FAILED'
          )
        );
      });

      child.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(destPath)) {
          reject(
            new AppError(
              `Authorized media command failed (exit ${code}): ${stderr.slice(-300) || 'no media file produced'}`,
              422,
              'YOUTUBE_MEDIA_ACCESS_FAILED'
            )
          );
          return;
        }
        resolve();
      });
    });

    const probe = await probeMediaFile(destPath);
    if (options?.maxDurationSec && probe.durationSec > options.maxDurationSec) {
      fs.unlinkSync(destPath);
      throw new BadRequestError(
        `Video duration (${Math.round(probe.durationSec)}s) exceeds maximum limit (${options.maxDurationSec}s).`,
        'VIDEO_DURATION_LIMIT_EXCEEDED'
      );
    }

    return {
      localFilePath: destPath,
      adapterName: this.name,
      mimeType: 'video/mp4',
      probe,
      cleanupAfterStore: true,
    };
  }
}

/**
 * Composite Adapter: Checks owner-authorized exports / signed URLs first, then
 * configured HTTP provider bridge, then configured CLI command adapter.
 */
export class CompositeYouTubeMediaAdapter implements YouTubeMediaSourceAdapter {
  public readonly name = 'composite';
  private readonly ownerExport = new OwnerAuthorizedExportAdapter();
  private readonly httpBridge = new AuthorizedHttpBridgeAdapter();
  private readonly cmdAdapter = new AuthorizedCommandMediaAdapter();

  isConfigured(): boolean {
    return (
      fs.existsSync(env.YOUTUBE_AUTHORIZED_EXPORTS_DIR) ||
      this.httpBridge.isConfigured() ||
      this.cmdAdapter.isConfigured()
    );
  }

  getSetupInstructions(): string {
    return (
      `Configure an authorized media source for YouTube imports: ` +
      `(1) Place owner-authorized video exports in ${env.YOUTUBE_AUTHORIZED_EXPORTS_DIR}/<videoId>.mp4, ` +
      `(2) supply an owner-authorized signed media URL, or ` +
      `(3) configure YOUTUBE_MEDIA_PROVIDER_URL / YOUTUBE_MEDIA_COMMAND_BIN in .env.`
    );
  }

  async checkAvailability(
    videoId: string,
    canonicalUrl: string,
    options?: MediaAccessOptions
  ): Promise<MediaAvailabilityReport> {
    const ownerCheck = await this.ownerExport.checkAvailability(videoId, canonicalUrl, options);
    if (ownerCheck.available || ownerCheck.sidecarMeta?.mediaAccessError) {
      return ownerCheck;
    }

    if (this.httpBridge.isConfigured()) {
      const httpCheck = await this.httpBridge.checkAvailability(videoId, canonicalUrl);
      if (httpCheck.available) {
        return {
          ...httpCheck,
          sidecarMeta: httpCheck.sidecarMeta || ownerCheck.sidecarMeta,
        };
      }
      return httpCheck;
    }

    if (this.cmdAdapter.isConfigured()) {
      return this.cmdAdapter.checkAvailability();
    }

    return {
      available: false,
      adapterName: this.name,
      configured: false,
      reason:
        `Actual video media cannot be accessed for YouTube ID "${videoId}" because no authorized media source has this video. ` +
        `ClipForge AI separates metadata preview from media acquisition and never fakes clips from YouTube oEmbed metadata.`,
      setupInstructions: this.getSetupInstructions(),
      sidecarMeta: ownerCheck.sidecarMeta,
    };
  }

  async acquireMedia(
    videoId: string,
    canonicalUrl: string,
    destDir: string,
    options?: MediaAccessOptions & {
      onProgress?: (percent: number, message: string) => void;
      signal?: AbortSignal;
      maxDurationSec?: number;
    }
  ): Promise<AcquiredYouTubeMedia> {
    const ownerCheck = await this.ownerExport.checkAvailability(videoId, canonicalUrl, options);
    if (ownerCheck.available) {
      return this.ownerExport.acquireMedia(videoId, canonicalUrl, destDir, options);
    }
    if (ownerCheck.sidecarMeta?.mediaAccessError) {
      throw new AppError(
        ownerCheck.sidecarMeta.mediaAccessError,
        422,
        'YOUTUBE_MEDIA_ACCESS_FAILED'
      );
    }

    if (this.httpBridge.isConfigured()) {
      return this.httpBridge.acquireMedia(videoId, canonicalUrl, destDir, options);
    }

    if (this.cmdAdapter.isConfigured()) {
      return this.cmdAdapter.acquireMedia(videoId, canonicalUrl, destDir, options);
    }

    throw new AppError(
      `Cannot acquire video media for YouTube ID "${videoId}": authorized media source is not configured or does not contain an authorized export for this video. ${this.getSetupInstructions()}`,
      422,
      'YOUTUBE_MEDIA_ADAPTER_NOT_CONFIGURED'
    );
  }
}

let customTestingAdapter: YouTubeMediaSourceAdapter | null = null;

export function setCustomYouTubeMediaAdapterForTesting(
  adapter: YouTubeMediaSourceAdapter | null
): void {
  customTestingAdapter = adapter;
}

export function getYouTubeMediaSourceAdapter(): YouTubeMediaSourceAdapter {
  if (customTestingAdapter) return customTestingAdapter;

  switch (env.YOUTUBE_MEDIA_ADAPTER) {
    case 'owner_export_dir':
      return new OwnerAuthorizedExportAdapter();
    case 'authorized_http_provider':
      return new AuthorizedHttpBridgeAdapter();
    case 'custom_command':
      return new AuthorizedCommandMediaAdapter();
    default:
      return new CompositeYouTubeMediaAdapter();
  }
}
