import dns from 'dns/promises';
import net from 'net';
import fs from 'fs';
import { Readable } from 'stream';
import { env } from '../config/env';
import { getOrCreateSystemConfig } from '../models';
import { BadRequestError, ForbiddenError } from '../utils/errors';

export type DetectedPlatform =
  | 'youtube'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'direct_mp4'
  | 'unknown';

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 RFC1918
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 cloud metadata / link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    return false;
  }

  return true;
}

export async function assertUrlSafeFromSsrf(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError('Invalid URL format', 'INVALID_URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestError('Only HTTP and HTTPS video URLs are allowed', 'UNSAFE_URL_SCHEME');
  }

  if (parsed.username || parsed.password) {
    throw new BadRequestError('Embedded URL credentials are not permitted', 'UNSAFE_URL_CREDENTIALS');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new ForbiddenError(
      'Internal, loopback, and local network hostnames are blocked for security (SSRF protection).',
      'SSRF_BLOCKED'
    );
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new ForbiddenError(
        'Private, loopback, and metadata IP addresses are blocked (SSRF protection).',
        'SSRF_BLOCKED'
      );
    }
    return parsed;
  }

  // Resolve DNS records if online; block if any record resolves to private/reserved IP
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      throw new BadRequestError('Could not resolve URL hostname', 'DNS_UNRESOLVED');
    }
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        throw new ForbiddenError(
          'Hostname resolved to a restricted internal IP address (SSRF protection).',
          'SSRF_BLOCKED'
        );
      }
    }
  } catch (err: any) {
    if (err instanceof ForbiddenError || err instanceof BadRequestError) {
      throw err;
    }
    // In restricted network environments where external DNS is unavailable, fail gracefully
    throw new BadRequestError(
      `Unable to resolve external host "${hostname}" in this network environment. Please download the video and use Direct File Upload.`,
      'HOST_UNREACHABLE'
    );
  }

  return parsed;
}

export function detectVideoPlatform(parsed: URL): DetectedPlatform {
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'youtube';
  if (host.endsWith('instagram.com') || host === 'instagr.am') return 'instagram';
  if (host.endsWith('facebook.com') || host === 'fb.watch') return 'facebook';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (/\.(mp4|webm|mov|m4v)$/i.test(pathname)) return 'direct_mp4';

  return 'unknown';
}

export async function inspectVideoUrl(rawUrl: string): Promise<{
  valid: boolean;
  platform: DetectedPlatform;
  importableDirectly: boolean;
  requiresUploadFallback: boolean;
  reason: string;
  metadata?: {
    title?: string;
    author?: string;
    contentType?: string;
    contentLengthBytes?: number;
  };
}> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError('Please enter a valid HTTP or HTTPS URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestError('Only HTTP/HTTPS URLs are supported');
  }

  // Always enforce SSRF check first!
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    (net.isIP(hostname) && isPrivateOrReservedIp(hostname))
  ) {
    throw new ForbiddenError(
      'Private, loopback, and internal network addresses are strictly blocked (SSRF protection).',
      'SSRF_BLOCKED'
    );
  }

  const platform = detectVideoPlatform(parsed);
  const cfg = await getOrCreateSystemConfig();
  const platCfg = cfg.supportedPlatforms?.[platform];

  if (platCfg && platCfg.enabled === false) {
    return {
      valid: true,
      platform,
      importableDirectly: false,
      requiresUploadFallback: true,
      reason: `Importing from ${platform.toUpperCase()} is currently disabled by the platform administrator. Use Direct Video Upload instead.`,
    };
  }

  if (platform === 'youtube') {
    try {
      const { fetchYouTubeVideoMetadataAndAccess } = await import('./youtubeImportService');
      const ytReport = await fetchYouTubeVideoMetadataAndAccess(rawUrl);
      return {
        valid: true,
        platform: 'youtube',
        importableDirectly: ytReport.mediaAccess.available,
        requiresUploadFallback: !ytReport.mediaAccess.available,
        reason: ytReport.mediaAccess.available
          ? `Authorized YouTube media ready via ${ytReport.mediaAccess.adapterName}.`
          : ytReport.mediaAccess.reason ||
            'YouTube metadata verified, but no authorized media stream is available for this video. Use the YouTube tab with an authorized media source or upload your MP4 directly.',
        metadata: {
          title: ytReport.video.title,
          author: ytReport.video.channelName,
        },
      };
    } catch (err: any) {
      if (err?.code === 'INVALID_YOUTUBE_URL' || err?.code === 'MISSING_YOUTUBE_VIDEO_ID') {
        throw err;
      }
      return {
        valid: true,
        platform: 'youtube',
        importableDirectly: false,
        requiresUploadFallback: true,
        reason:
          err?.message ||
          platCfg?.note ||
          'Actual YouTube media requires an authorized media-source integration or direct MP4 upload.',
      };
    }
  }

  if (
    platform === 'instagram' ||
    platform === 'facebook' ||
    platform === 'tiktok'
  ) {
    return {
      valid: true,
      platform,
      importableDirectly: false,
      requiresUploadFallback: true,
      reason:
        platCfg?.note ||
        `${platform.toUpperCase()} restricts unauthenticated automated stream extraction under platform Terms of Service. ClipForge AI never bypasses platform protections or DRM—please upload your original MP4/MOV video file directly.`,
    };
  }

  // Direct media link check
  await assertUrlSafeFromSsrf(rawUrl);

  if (!env.ALLOW_DIRECT_MEDIA_URL_IMPORT) {
    return {
      valid: true,
      platform: 'direct_mp4',
      importableDirectly: false,
      requiresUploadFallback: true,
      reason: 'Direct URL importing is disabled in server configuration. Please upload your file.',
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const headRes = await fetch(parsed.toString(), {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (headRes.status >= 300 && headRes.status < 400) {
      const loc = headRes.headers.get('location');
      if (loc) {
        const nextUrl = new URL(loc, parsed).toString();
        await assertUrlSafeFromSsrf(nextUrl);
      }
    }

    const contentType = headRes.headers.get('content-type') || '';
    const contentLength = Number(headRes.headers.get('content-length') || 0);
    const isVideoContent =
      contentType.startsWith('video/') ||
      contentType.includes('octet-stream') ||
      platform === 'direct_mp4';

    if (!headRes.ok && headRes.status !== 405) {
      return {
        valid: true,
        platform: platform === 'unknown' ? 'direct_mp4' : platform,
        importableDirectly: false,
        requiresUploadFallback: true,
        reason: `Remote server responded with HTTP ${headRes.status}. Upload the video file directly instead.`,
      };
    }

    if (!isVideoContent) {
      return {
        valid: true,
        platform: 'unknown',
        importableDirectly: false,
        requiresUploadFallback: true,
        reason: `URL returned "${contentType || 'non-video content'}" instead of a direct MP4/WebM media stream. Please upload the video file directly.`,
      };
    }

    return {
      valid: true,
      platform: 'direct_mp4',
      importableDirectly: true,
      requiresUploadFallback: false,
      reason: 'Accessible direct video stream verified and ready for server import.',
      metadata: {
        title: parsed.pathname.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Imported Media',
        contentType: contentType || 'video/mp4',
        contentLengthBytes: contentLength > 0 ? contentLength : undefined,
      },
    };
  } catch {
    return {
      valid: true,
      platform: platform === 'unknown' ? 'direct_mp4' : platform,
      importableDirectly: false,
      requiresUploadFallback: true,
      reason:
        'Outbound network could not reach this external media host from the server environment. Please upload your video file directly.',
    };
  }
}

export async function downloadSafeDirectMediaUrl(
  rawUrl: string,
  destPath: string,
  maxBytes: number
): Promise<{ sizeBytes: number; contentType: string }> {
  let currentUrl = rawUrl;
  let redirectCount = 0;

  while (redirectCount <= 3) {
    const safeUrl = await assertUrlSafeFromSsrf(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let res: Response;
    try {
      res = await fetch(safeUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new BadRequestError('Redirect missing Location header');
      currentUrl = new URL(location, safeUrl).toString();
      redirectCount += 1;
      continue;
    }

    if (!res.ok || !res.body) {
      throw new BadRequestError(`Remote media server returned HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || 'video/mp4';
    const declaredLen = Number(res.headers.get('content-length') || 0);
    if (declaredLen > maxBytes) {
      throw new BadRequestError('Remote video exceeds maximum allowed file size');
    }

    const fileOut = fs.createWriteStream(destPath);
    let bytesWritten = 0;
    const nodeStream = Readable.fromWeb(res.body as any);

    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > maxBytes) {
          nodeStream.destroy(new BadRequestError('Remote video exceeded size limit during download'));
          return;
        }
        fileOut.write(chunk);
      });
      nodeStream.on('end', () => {
        fileOut.end(() => resolve());
      });
      nodeStream.on('error', (err) => {
        fileOut.destroy();
        reject(err);
      });
    });

    return { sizeBytes: bytesWritten, contentType };
  }

  throw new BadRequestError('Too many URL redirects');
}
