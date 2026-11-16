import crypto from 'crypto';
import type { GoogleConnectedChannel, GoogleOAuthStatus } from '@clipforge/shared';
import { env } from '../../config/env';
import { UserGoogleIntegration, type IUserGoogleIntegration } from '../../models';
import { AppError, BadRequestError, UnauthorizedError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export const GOOGLE_YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const GOOGLE_DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export const DEFAULT_GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  GOOGLE_YOUTUBE_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
];

interface SignedOAuthStatePayload {
  userId: string;
  nonce: string;
  exp: number;
  redirectPath: string;
}

interface GoogleTokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function deriveEncryptionKey(): Buffer {
  const secretMaterial =
    (env.GOOGLE_TOKEN_ENCRYPTION_KEY && env.GOOGLE_TOKEN_ENCRYPTION_KEY.trim()) ||
    env.JWT_ACCESS_SECRET;
  return crypto.createHash('sha256').update(`clipforge-google-oauth:${secretMaterial}`).digest();
}

export function encryptOAuthToken(plainText: string): string {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptOAuthToken(cipherPayload: string): string {
  const parts = cipherPayload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new UnauthorizedError(
      'Stored Google authorization token format is invalid. Please reconnect your Google account.',
      'GOOGLE_OAUTH_REAUTH_REQUIRED'
    );
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function signStatePayload(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`google-oauth-state:${encodedPayload}`)
    .digest('base64url');
}

export class GoogleOAuthProvider {
  isConfigured(): boolean {
    return Boolean(
      env.GOOGLE_CLIENT_ID &&
        env.GOOGLE_CLIENT_ID.trim().length > 0 &&
        env.GOOGLE_CLIENT_SECRET &&
        env.GOOGLE_CLIENT_SECRET.trim().length > 0
    );
  }

  getSetupInstructions(): string {
    return (
      'Google OAuth is not configured on this server yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
      'and GOOGLE_REDIRECT_URI in your environment (with YouTube Data API v3 and Google Drive API enabled in Google Cloud Console), ' +
      'or provide a Direct Authorized Media URL / upload the video file directly.'
    );
  }

  createSignedState(userId: string, redirectPath = '/dashboard/create?tab=youtube'): string {
    const safeRedirectPath =
      redirectPath.startsWith('/') && !redirectPath.startsWith('//')
        ? redirectPath
        : '/dashboard/create?tab=youtube';

    const payload: SignedOAuthStatePayload = {
      userId,
      nonce: crypto.randomBytes(16).toString('hex'),
      exp: Date.now() + 10 * 60 * 1000,
      redirectPath: safeRedirectPath,
    };

    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = signStatePayload(encoded);
    return `${encoded}.${signature}`;
  }

  verifySignedState(stateToken: string): SignedOAuthStatePayload {
    if (!stateToken || typeof stateToken !== 'string' || !stateToken.includes('.')) {
      throw new BadRequestError('Invalid Google OAuth state parameter.', 'GOOGLE_OAUTH_INVALID_STATE');
    }

    const [encoded, providedSig] = stateToken.split('.');
    if (!encoded || !providedSig) {
      throw new BadRequestError('Malformed Google OAuth state parameter.', 'GOOGLE_OAUTH_INVALID_STATE');
    }

    const expectedSig = signStatePayload(encoded);
    const providedBuf = Buffer.from(providedSig);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new BadRequestError(
        'Google OAuth state signature verification failed.',
        'GOOGLE_OAUTH_INVALID_STATE'
      );
    }

    let parsed: SignedOAuthStatePayload;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestError('Unreadable Google OAuth state payload.', 'GOOGLE_OAUTH_INVALID_STATE');
    }

    if (!parsed.userId || !parsed.exp || Date.now() > parsed.exp) {
      throw new BadRequestError(
        'Google OAuth session expired. Please click Connect Google Account again.',
        'GOOGLE_OAUTH_STATE_EXPIRED'
      );
    }

    return parsed;
  }

  createAuthorizationUrl(
    userId: string,
    options?: { redirectPath?: string; loginHint?: string }
  ): { authorizationUrl: string; state: string; scopes: string[] } {
    if (!this.isConfigured()) {
      throw new AppError(this.getSetupInstructions(), 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
    }

    const state = this.createSignedState(userId, options?.redirectPath);
    const authUrl = new URL(env.GOOGLE_OAUTH_AUTH_URL);
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID.trim());
    authUrl.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI.trim());
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', DEFAULT_GOOGLE_OAUTH_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    if (options?.loginHint) {
      authUrl.searchParams.set('login_hint', options.loginHint);
    }

    return {
      authorizationUrl: authUrl.toString(),
      state,
      scopes: [...DEFAULT_GOOGLE_OAUTH_SCOPES],
    };
  }

  async handleCallback(params: {
    code: string;
    state: string;
  }): Promise<{ userId: string; redirectPath: string; status: GoogleOAuthStatus }> {
    if (!this.isConfigured()) {
      throw new AppError(this.getSetupInstructions(), 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
    }
    if (!params.code || !params.code.trim()) {
      throw new BadRequestError('Missing authorization code from Google OAuth callback.', 'GOOGLE_OAUTH_MISSING_CODE');
    }

    const verifiedState = this.verifySignedState(params.state);

    const tokenRes = await fetch(env.GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        code: params.code.trim(),
        client_id: env.GOOGLE_CLIENT_ID.trim(),
        client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
        redirect_uri: env.GOOGLE_REDIRECT_URI.trim(),
        grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });

    const tokenJson = (await tokenRes.json().catch(() => ({}))) as GoogleTokenEndpointResponse;
    if (!tokenRes.ok || !tokenJson.access_token) {
      const reason =
        tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`;
      throw new BadRequestError(
        `Google OAuth code exchange failed (${reason}). Please try connecting again.`,
        'GOOGLE_OAUTH_EXCHANGE_FAILED'
      );
    }

    const accessToken = tokenJson.access_token;
    const scopes = tokenJson.scope
      ? tokenJson.scope.split(/\s+/).filter(Boolean)
      : [...DEFAULT_GOOGLE_OAUTH_SCOPES];
    const expiresAt = tokenJson.expires_in
      ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000)
      : new Date(Date.now() + 3600 * 1000);

    // Fetch Google user profile
    const profile = await this.fetchGoogleUserProfile(accessToken);

    // Fetch owned/managed YouTube channels if youtube.readonly scope is granted
    let channels: GoogleConnectedChannel[] = [];
    if (scopes.includes(GOOGLE_YOUTUBE_READONLY_SCOPE)) {
      channels = await this.fetchManagedYouTubeChannels(accessToken);
    }

    const existing = await UserGoogleIntegration.findOne({ userId: verifiedState.userId });
    const encryptedAccessToken = encryptOAuthToken(accessToken);
    const encryptedRefreshToken = tokenJson.refresh_token
      ? encryptOAuthToken(tokenJson.refresh_token)
      : existing?.encryptedRefreshToken;

    await UserGoogleIntegration.findOneAndUpdate(
      { userId: verifiedState.userId },
      {
        $set: {
          googleAccountId: profile.id,
          email: profile.email,
          displayName: profile.name,
          avatarUrl: profile.picture,
          encryptedAccessToken,
          ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
          tokenExpiresAt: expiresAt,
          scopes,
          channels,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const status = await this.getConnectionStatus(verifiedState.userId);
    return {
      userId: verifiedState.userId,
      redirectPath: verifiedState.redirectPath,
      status,
    };
  }

  private async fetchGoogleUserProfile(accessToken: string): Promise<{
    id: string;
    email: string;
    name?: string;
    picture?: string;
  }> {
    const res = await fetch(env.GOOGLE_OAUTH_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new BadRequestError(
        `Failed to verify Google account profile (HTTP ${res.status}).`,
        'GOOGLE_OAUTH_PROFILE_FAILED'
      );
    }

    const data: any = await res.json();
    const id = String(data.id || data.sub || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    if (!id || !email) {
      throw new BadRequestError(
        'Google account profile did not return a valid account ID and email.',
        'GOOGLE_OAUTH_PROFILE_INCOMPLETE'
      );
    }

    return {
      id,
      email,
      name: data.name ? String(data.name) : undefined,
      picture: data.picture ? String(data.picture) : undefined,
    };
  }

  async fetchManagedYouTubeChannels(accessToken: string): Promise<GoogleConnectedChannel[]> {
    try {
      const base = env.YOUTUBE_API_BASE_URL.replace(/\/+$/, '');
      const url = new URL(`${base}/channels`);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('mine', 'true');
      url.searchParams.set('maxResults', '50');

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        logger.warn('Unable to list YouTube channels for OAuth user', {
          status: res.status,
        });
        return [];
      }

      const data: any = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      return items
        .filter((item: any) => item?.id)
        .map((item: any) => ({
          channelId: String(item.id),
          title: String(item.snippet?.title || 'YouTube Channel'),
          customUrl: item.snippet?.customUrl ? String(item.snippet.customUrl) : undefined,
          thumbnailUrl:
            item.snippet?.thumbnails?.default?.url ||
            item.snippet?.thumbnails?.medium?.url ||
            undefined,
        }));
    } catch (err: any) {
      logger.warn('Failed to fetch managed YouTube channels', {
        err: err?.message,
      });
      return [];
    }
  }

  async getConnectionStatus(userId?: string): Promise<GoogleOAuthStatus> {
    const oauthConfigured = this.isConfigured();
    if (!userId) {
      return {
        oauthConfigured,
        connected: false,
        setupInstructions: oauthConfigured ? undefined : this.getSetupInstructions(),
      };
    }

    const integration = await UserGoogleIntegration.findOne({ userId }).lean();
    if (!integration) {
      return {
        oauthConfigured,
        connected: false,
        setupInstructions: oauthConfigured ? undefined : this.getSetupInstructions(),
      };
    }

    const scopes = Array.isArray(integration.scopes) ? integration.scopes : [];
    return {
      oauthConfigured,
      connected: true,
      email: integration.email,
      displayName: integration.displayName,
      avatarUrl: integration.avatarUrl,
      scopes,
      hasYouTubeScope: scopes.includes(GOOGLE_YOUTUBE_READONLY_SCOPE),
      hasDriveScope: scopes.includes(GOOGLE_DRIVE_READONLY_SCOPE),
      channels: integration.channels || [],
    };
  }

  async getIntegrationRecord(userId: string): Promise<IUserGoogleIntegration | null> {
    return UserGoogleIntegration.findOne({ userId });
  }

  async getValidAccessToken(
    userId: string,
    requiredScope?: string
  ): Promise<{ accessToken: string; integration: IUserGoogleIntegration }> {
    const integration = await UserGoogleIntegration.findOne({ userId });
    if (!integration) {
      throw new UnauthorizedError(
        'Google account is not connected. Connect your Google account first to access your YouTube channel or Google Drive videos.',
        'GOOGLE_OAUTH_NOT_CONNECTED'
      );
    }

    if (requiredScope && !integration.scopes.includes(requiredScope)) {
      throw new UnauthorizedError(
        `Your Google connection does not include required permission (${requiredScope}). Please reconnect your Google account and approve access.`,
        'GOOGLE_OAUTH_MISSING_SCOPE'
      );
    }

    const expiresAtMs = integration.tokenExpiresAt ? integration.tokenExpiresAt.getTime() : 0;
    const isExpiringSoon = expiresAtMs > 0 && expiresAtMs <= Date.now() + 60_000;

    if (!isExpiringSoon) {
      return {
        accessToken: decryptOAuthToken(integration.encryptedAccessToken),
        integration,
      };
    }

    // Token expired or expiring within 60s -> refresh via refresh_token
    if (!integration.encryptedRefreshToken) {
      throw new UnauthorizedError(
        'Your Google session has expired and no refresh token is available. Please reconnect your Google account.',
        'GOOGLE_OAUTH_REAUTH_REQUIRED'
      );
    }

    if (!this.isConfigured()) {
      throw new AppError(this.getSetupInstructions(), 503, 'GOOGLE_OAUTH_NOT_CONFIGURED');
    }

    const refreshToken = decryptOAuthToken(integration.encryptedRefreshToken);
    const res = await fetch(env.GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID.trim(),
        client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });

    const data = (await res.json().catch(() => ({}))) as GoogleTokenEndpointResponse;
    if (!res.ok || !data.access_token) {
      throw new UnauthorizedError(
        'Your Google authorization expired or was revoked. Please reconnect your Google account.',
        'GOOGLE_OAUTH_REAUTH_REQUIRED'
      );
    }

    integration.encryptedAccessToken = encryptOAuthToken(data.access_token);
    if (data.refresh_token) {
      integration.encryptedRefreshToken = encryptOAuthToken(data.refresh_token);
    }
    integration.tokenExpiresAt = data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000)
      : new Date(Date.now() + 3600 * 1000);
    if (data.scope) {
      integration.scopes = data.scope.split(/\s+/).filter(Boolean);
    }
    await integration.save();

    return {
      accessToken: data.access_token,
      integration,
    };
  }

  async disconnect(userId: string): Promise<void> {
    const integration = await UserGoogleIntegration.findOne({ userId });
    if (!integration) return;

    try {
      const tokenToRevoke = integration.encryptedRefreshToken
        ? decryptOAuthToken(integration.encryptedRefreshToken)
        : decryptOAuthToken(integration.encryptedAccessToken);

      await fetch(env.GOOGLE_OAUTH_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokenToRevoke }).toString(),
        signal: AbortSignal.timeout(6000),
      }).catch(() => undefined);
    } catch {
      // Ignore decrypt/revoke errors during disconnect cleanup
    }

    await UserGoogleIntegration.deleteOne({ _id: integration._id });
  }
}
