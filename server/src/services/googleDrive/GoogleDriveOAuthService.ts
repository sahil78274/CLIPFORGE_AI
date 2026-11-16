import crypto from 'crypto';
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_OAUTH_SCOPES,
  GOOGLE_DRIVE_SUPPORTED_MIME_TYPES,
  MAX_GOOGLE_DRIVE_FILE_BYTES,
  type GoogleDriveConnectionStatus,
  type GoogleDrivePickerConfig,
} from '@clipforge/shared';
import { env } from '../../config/env';
import {
  GoogleDriveFileSelection,
  GoogleDriveOAuthState,
  UserGoogleDriveConnection,
  type IUserGoogleDriveConnection,
} from '../../models';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';
import { decryptOAuthToken, encryptOAuthToken } from '../mediaAcquisition/GoogleOAuthProvider';

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_HMAC_DOMAIN = 'clipforge-drive-oauth-state-v1';
const ACCESS_TOKEN_CACHE_SAFETY_MS = 60_000;
/** Picker / Drive API tokens are kept in RAM for at most 5 minutes. Never persisted. */
const ACCESS_TOKEN_MAX_CACHE_MS = 5 * 60 * 1000;

interface DriveOAuthStatePayload {
  v: 1;
  flow: 'drive';
  userId: string;
  nonce: string;
  exp: number;
  redirectPath: string;
}

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  scopes: string[];
  googleAccountId: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface DriveOAuthCallbackResult {
  cancelled: boolean;
  redirectPath: string;
  status?: GoogleDriveConnectionStatus;
}

function signState(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`${STATE_HMAC_DOMAIN}:${encodedPayload}`)
    .digest('base64url');
}

function hashNonce(nonce: string): string {
  return crypto.createHash('sha256').update(`drive-oauth-nonce:${nonce}`).digest('hex');
}

function safeRedirectPath(raw: string | undefined): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && raw.length <= 512
    ? raw
    : '/dashboard/create?tab=drive';
}

/**
 * Google OAuth 2.0 service for the "Connect Google Drive" flow.
 *
 * - Requests ONLY the minimum Drive permission (drive.file) plus OIDC identity scopes.
 * - Uses offline access; exchanges the authorization code exclusively on the backend.
 * - HMAC-signed, single-use, expiring state (CSRF + replay protection).
 * - Encrypts refresh tokens with AES-256-GCM before writing them to MongoDB.
 * - Access tokens live in a bounded in-memory cache and are never written to disk/DB.
 */
export class GoogleDriveOAuthService {
  private readonly accessTokenCache = new Map<string, CachedAccessToken>();
  private readonly refreshInFlight = new Map<string, Promise<CachedAccessToken>>();

  isConfigured(): boolean {
    return Boolean(
      env.GOOGLE_CLIENT_ID?.trim() &&
        env.GOOGLE_CLIENT_SECRET?.trim() &&
        env.GOOGLE_REDIRECT_URI?.trim()
    );
  }

  isPickerConfigured(): boolean {
    return Boolean(env.GOOGLE_API_KEY?.trim() && env.GOOGLE_PROJECT_NUMBER?.trim());
  }

  getSetupInstructions(): string {
    const missing: string[] = [];
    if (!env.GOOGLE_CLIENT_ID?.trim()) missing.push('GOOGLE_CLIENT_ID');
    if (!env.GOOGLE_CLIENT_SECRET?.trim()) missing.push('GOOGLE_CLIENT_SECRET');
    if (!env.GOOGLE_API_KEY?.trim()) missing.push('GOOGLE_API_KEY');
    if (!env.GOOGLE_PROJECT_NUMBER?.trim()) missing.push('GOOGLE_PROJECT_NUMBER');
    if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim()) {
      missing.push('GOOGLE_TOKEN_ENCRYPTION_KEY (recommended, >=32 random characters)');
    }
    return missing.length
      ? `Google Drive import is not fully configured. Set ${missing.join(', ')} in your server .env, enable the Google Drive API and Google Picker API in Google Cloud Console, and register ${env.GOOGLE_REDIRECT_URI} as an authorized redirect URI. See docs/GOOGLE_DRIVE_SETUP.md.`
      : 'Google Drive import is ready.';
  }

  /** Public identifiers only. The OAuth client secret and refresh tokens are never returned. */
  getPublicConfig(): GoogleDrivePickerConfig {
    const oauthConfigured = this.isConfigured();
    const pickerConfigured = this.isPickerConfigured();
    return {
      oauthConfigured: oauthConfigured && Boolean(env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim()),
      pickerConfigured,
      apiKey: pickerConfigured ? env.GOOGLE_API_KEY.trim() : '',
      projectNumber: pickerConfigured ? env.GOOGLE_PROJECT_NUMBER.trim() : '',
      oauthClientId: env.GOOGLE_CLIENT_ID?.trim() || '',
      redirectUri: env.GOOGLE_REDIRECT_URI.trim(),
      scopes: [...GOOGLE_DRIVE_OAUTH_SCOPES],
      supportedMimeTypes: [...GOOGLE_DRIVE_SUPPORTED_MIME_TYPES],
      maxFileSizeBytes: Math.min(env.GOOGLE_DRIVE_MAX_FILE_BYTES, MAX_GOOGLE_DRIVE_FILE_BYTES),
      maxDurationSec: env.MAX_VIDEO_DURATION_SEC,
      setupInstructions:
        oauthConfigured && pickerConfigured ? undefined : this.getSetupInstructions(),
    };
  }

  private assertFullyConfigured(): void {
    if (!this.isConfigured()) {
      throw new AppError(this.getSetupInstructions(), 503, 'GOOGLE_DRIVE_NOT_CONFIGURED');
    }
    if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim()) {
      throw new AppError(
        'GOOGLE_TOKEN_ENCRYPTION_KEY is required before Google Drive accounts can be connected (refresh tokens are encrypted at rest).',
        503,
        'GOOGLE_DRIVE_NOT_CONFIGURED'
      );
    }
  }

  async createAuthorizationUrl(
    userId: string,
    redirectPath?: string,
    loginHint?: string
  ): Promise<{ authorizationUrl: string; state: string; expiresAt: number }> {
    this.assertFullyConfigured();

    // Opportunistic cleanup so expired state records never accumulate.
    await GoogleDriveOAuthState.deleteMany({ expiresAt: { $lte: new Date() } }).catch(
      () => undefined
    );

    const payload: DriveOAuthStatePayload = {
      v: 1,
      flow: 'drive',
      userId,
      nonce: crypto.randomBytes(32).toString('base64url'),
      exp: Date.now() + STATE_TTL_MS,
      redirectPath: safeRedirectPath(redirectPath),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const state = `${encoded}.${signState(encoded)}`;

    await GoogleDriveOAuthState.create({
      userId,
      nonceHash: hashNonce(payload.nonce),
      redirectPath: payload.redirectPath,
      expiresAt: new Date(payload.exp),
    });

    const authUrl = new URL(env.GOOGLE_OAUTH_AUTH_URL);
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID.trim());
    authUrl.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI.trim());
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_DRIVE_OAUTH_SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    // Omit include_granted_scopes so the flow never silently widens drive.file.
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    if (loginHint) authUrl.searchParams.set('login_hint', loginHint);

    return { authorizationUrl: authUrl.toString(), state, expiresAt: payload.exp };
  }

  /** Decode a state token WITHOUT trusting it — used only to route the callback. */
  peekStateFlow(stateToken: string): 'drive' | 'legacy_youtube' | 'unknown' {
    try {
      const encoded = stateToken.split('.')[0];
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (parsed?.flow === 'drive' && parsed?.v === 1) return 'drive';
      // Legacy YouTube states are signed JSON { userId, nonce, exp, redirectPath } with no flow.
      if (!parsed?.flow && parsed?.userId && parsed?.exp && parsed?.nonce) {
        return 'legacy_youtube';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private verifyState(stateToken: string): DriveOAuthStatePayload {
    if (!stateToken || typeof stateToken !== 'string' || !stateToken.includes('.')) {
      throw new BadRequestError('Invalid Google OAuth state parameter.', 'GOOGLE_DRIVE_INVALID_STATE');
    }
    const [encoded, providedSig, ...rest] = stateToken.split('.');
    if (!encoded || !providedSig || rest.length > 0 || encoded.length > 2048) {
      throw new BadRequestError('Malformed Google OAuth state parameter.', 'GOOGLE_DRIVE_INVALID_STATE');
    }

    const expectedBuf = Buffer.from(signState(encoded));
    const providedBuf = Buffer.from(providedSig);
    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new BadRequestError(
        'Google OAuth state signature verification failed. Please restart the connection.',
        'GOOGLE_DRIVE_INVALID_STATE'
      );
    }

    let parsed: DriveOAuthStatePayload;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestError('Unreadable Google OAuth state payload.', 'GOOGLE_DRIVE_INVALID_STATE');
    }

    if (
      parsed.v !== 1 ||
      parsed.flow !== 'drive' ||
      !parsed.userId ||
      !parsed.nonce ||
      !parsed.exp ||
      Date.now() > parsed.exp
    ) {
      throw new BadRequestError(
        'Google OAuth session expired. Please click Connect Google Drive again.',
        'GOOGLE_DRIVE_STATE_EXPIRED'
      );
    }
    return parsed;
  }

  /** Atomically consume a state record (single-use) or reject as invalid/replayed. */
  private async consumeState(
    payload: DriveOAuthStatePayload
  ): Promise<{ redirectPath: string; userId: string }> {
    const consumed = await GoogleDriveOAuthState.findOneAndDelete({
      nonceHash: hashNonce(payload.nonce),
      userId: payload.userId,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!consumed) {
      throw new BadRequestError(
        'Google OAuth state was already used, expired, or does not belong to this connection attempt. Please connect again.',
        'GOOGLE_DRIVE_INVALID_STATE'
      );
    }
    return { redirectPath: safeRedirectPath(consumed.redirectPath), userId: String(consumed.userId) };
  }

  async handleCallback(params: {
    code?: string;
    state: string;
    error?: string;
    errorDescription?: string;
  }): Promise<DriveOAuthCallbackResult> {
    this.assertFullyConfigured();

    const verified = this.verifyState(params.state);
    const consumed = await this.consumeState(verified);

    if (params.error) {
      const reason = params.errorDescription || params.error;
      logger.info('Google Drive OAuth cancelled or denied by user', {
        error: params.error,
        userId: consumed.userId,
      });
      return {
        cancelled: true,
        redirectPath: consumed.redirectPath,
      };
    }

    const code = params.code?.trim();
    if (!code) {
      throw new BadRequestError(
        'Missing authorization code from the Google OAuth callback.',
        'GOOGLE_DRIVE_MISSING_CODE'
      );
    }

    const tokenRes = await fetch(env.GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID.trim(),
        client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
        redirect_uri: env.GOOGLE_REDIRECT_URI.trim(),
        grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as GoogleTokenResponse;
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new BadRequestError(
        `Google authorization code exchange failed (${tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`}). Please try connecting again.`,
        'GOOGLE_DRIVE_OAUTH_EXCHANGE_FAILED'
      );
    }

    const scopes = tokenJson.scope
      ? tokenJson.scope.split(/\s+/).filter(Boolean)
      : [...GOOGLE_DRIVE_OAUTH_SCOPES];
    if (!scopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
      throw new BadRequestError(
        `Google Drive permission ${GOOGLE_DRIVE_FILE_SCOPE} was not granted. Reconnect and approve access to the selected video file.`,
        'GOOGLE_DRIVE_SCOPE_NOT_GRANTED'
      );
    }

    // Google only returns a refresh token on the first consent for a client+user pair.
    // We intentionally never persist an access token, so offline access is mandatory.
    if (!tokenJson.refresh_token) {
      throw new BadRequestError(
        'Google did not return an offline refresh token. Revoke ClipForge AI access at myaccount.google.com/permissions, then click Connect Google Drive again.',
        'GOOGLE_DRIVE_REFRESH_TOKEN_MISSING'
      );
    }

    const profile = await this.fetchUserProfile(tokenJson.access_token);

    await UserGoogleDriveConnection.findOneAndUpdate(
      { userId: consumed.userId },
      {
        $set: {
          googleAccountId: profile.id,
          email: profile.email,
          displayName: profile.name,
          avatarUrl: profile.picture,
          encryptedRefreshToken: encryptOAuthToken(tokenJson.refresh_token),
          scopes,
          status: 'active',
          connectedAt: new Date(),
          lastRefreshedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    this.accessTokenCache.set(consumed.userId, {
      accessToken: tokenJson.access_token,
      expiresAtMs: Date.now() + this.cacheLifetimeMs(tokenJson.expires_in),
      scopes,
      googleAccountId: profile.id,
    });

    return {
      cancelled: false,
      redirectPath: consumed.redirectPath,
      status: await this.getConnectionStatus(consumed.userId),
    };
  }

  private cacheLifetimeMs(expiresIn?: number): number {
    const seconds = Number(expiresIn) > 0 ? Number(expiresIn) : 3600;
    return Math.max(30_000, Math.min(seconds * 1000 - ACCESS_TOKEN_CACHE_SAFETY_MS, ACCESS_TOKEN_MAX_CACHE_MS));
  }

  private async fetchUserProfile(
    accessToken: string
  ): Promise<{ id: string; email: string; name?: string; picture?: string }> {
    const res = await fetch(env.GOOGLE_OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new BadRequestError(
        `Failed to verify the connected Google account (HTTP ${res.status}).`,
        'GOOGLE_DRIVE_PROFILE_FAILED'
      );
    }
    const data: any = await res.json();
    const id = String(data.id || data.sub || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    if (!id || !email) {
      throw new BadRequestError(
        'Google did not return a valid account ID and email address.',
        'GOOGLE_DRIVE_PROFILE_INCOMPLETE'
      );
    }
    return {
      id,
      email,
      name: data.name ? String(data.name) : undefined,
      picture: data.picture ? String(data.picture) : undefined,
    };
  }

  async getConnectionRecord(userId: string): Promise<IUserGoogleDriveConnection | null> {
    return UserGoogleDriveConnection.findOne({ userId });
  }

  async getConnectionStatus(userId?: string): Promise<GoogleDriveConnectionStatus> {
    const oauthConfigured = this.isConfigured() && Boolean(env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim());
    const pickerConfigured = this.isPickerConfigured();
    if (!userId) {
      return {
        oauthConfigured,
        pickerConfigured,
        connected: false,
        hasRequiredScope: false,
        setupInstructions: oauthConfigured && pickerConfigured ? undefined : this.getSetupInstructions(),
      };
    }
    const conn = await UserGoogleDriveConnection.findOne({ userId }).lean();
    if (!conn || conn.status !== 'active') {
      return {
        oauthConfigured,
        pickerConfigured,
        connected: false,
        hasRequiredScope: false,
        status: conn?.status,
        setupInstructions:
          oauthConfigured && pickerConfigured ? undefined : this.getSetupInstructions(),
      };
    }
    const scopes = Array.isArray(conn.scopes) ? conn.scopes : [];
    return {
      oauthConfigured,
      pickerConfigured,
      connected: true,
      email: conn.email,
      displayName: conn.displayName,
      avatarUrl: conn.avatarUrl,
      googleAccountId: conn.googleAccountId,
      scopes,
      hasRequiredScope: scopes.includes(GOOGLE_DRIVE_FILE_SCOPE),
      connectedAt: conn.connectedAt?.toISOString(),
      status: 'active',
    };
  }

  /** Returns a short-lived access token for the official Google Picker API. */
  async getPickerAccessToken(userId: string): Promise<{
    accessToken: string;
    expiresAt: string;
    expiresInSec: number;
    scopes: string[];
  }> {
    const token = await this.getValidAccessToken(userId);
    return {
      accessToken: token.accessToken,
      expiresAt: new Date(token.expiresAtMs).toISOString(),
      expiresInSec: Math.max(1, Math.floor((token.expiresAtMs - Date.now()) / 1000)),
      scopes: token.scopes,
    };
  }

  /**
   * Resolves a valid, in-memory-only access token, transparently refreshing via the
   * encrypted refresh token when needed. Result is never written to MongoDB.
   */
  async getValidAccessToken(userId: string): Promise<CachedAccessToken> {
    const conn = await UserGoogleDriveConnection.findOne({ userId });
    if (!conn || conn.status !== 'active' || !conn.encryptedRefreshToken) {
      throw new UnauthorizedError(
        'Google Drive is not connected (or access was revoked). Click Connect Google Drive to authorize access.',
        'GOOGLE_DRIVE_NOT_CONNECTED'
      );
    }
    if (!conn.scopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
      throw new UnauthorizedError(
        `The Google Drive connection is missing ${GOOGLE_DRIVE_FILE_SCOPE}. Please disconnect and reconnect.`,
        'GOOGLE_DRIVE_SCOPE_NOT_GRANTED'
      );
    }

    const cached = this.accessTokenCache.get(userId);
    if (cached && cached.expiresAtMs > Date.now() + ACCESS_TOKEN_CACHE_SAFETY_MS) {
      return cached;
    }

    const inFlight = this.refreshInFlight.get(userId);
    if (inFlight) return inFlight;

    const refreshPromise = this.refreshAccessToken(userId, conn).finally(() => {
      this.refreshInFlight.delete(userId);
    });
    this.refreshInFlight.set(userId, refreshPromise);
    return refreshPromise;
  }

  private async refreshAccessToken(
    userId: string,
    conn: IUserGoogleDriveConnection
  ): Promise<CachedAccessToken> {
    this.assertFullyConfigured();
    let refreshToken: string;
    try {
      refreshToken = decryptOAuthToken(conn.encryptedRefreshToken);
    } catch {
      await this.markRevoked(userId);
      throw new UnauthorizedError(
        'Stored Google Drive credentials could not be decrypted. Please reconnect your Google account.',
        'GOOGLE_DRIVE_REAUTH_REQUIRED'
      );
    }

    let res: Response;
    try {
      res = await fetch(env.GOOGLE_OAUTH_TOKEN_URL, {
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
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      throw new AppError(
        `Google Drive token refresh failed: ${err?.message || 'network error'}`,
        502,
        'GOOGLE_DRIVE_TOKEN_REFRESH_FAILED'
      );
    }

    const data = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
    if (!res.ok || !data.access_token) {
      const revoked =
        res.status === 400 ||
        res.status === 401 ||
        data.error === 'invalid_grant' ||
        data.error === 'invalid_token';
      if (revoked) {
        await this.markRevoked(userId);
        throw new UnauthorizedError(
          'Google Drive permission expired or was revoked. Disconnect and reconnect your Google account to continue.',
          'GOOGLE_DRIVE_REAUTH_REQUIRED'
        );
      }
      throw new AppError(
        `Google Drive token refresh failed (${data.error || `HTTP ${res.status}`}).`,
        502,
        'GOOGLE_DRIVE_TOKEN_REFRESH_FAILED'
      );
    }

    // Rotation: Google may issue a new refresh token; re-encrypt before storing.
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      conn.encryptedRefreshToken = encryptOAuthToken(data.refresh_token);
    }
    conn.lastRefreshedAt = new Date();
    await conn.save();

    const token: CachedAccessToken = {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + this.cacheLifetimeMs(data.expires_in),
      scopes: conn.scopes,
      googleAccountId: conn.googleAccountId,
    };
    this.accessTokenCache.set(userId, token);
    return token;
  }

  private async markRevoked(userId: string): Promise<void> {
    this.accessTokenCache.delete(userId);
    await UserGoogleDriveConnection.updateOne(
      { userId },
      { $set: { status: 'revoked', encryptedRefreshToken: '' } }
    ).catch(() => undefined);
    await GoogleDriveFileSelection.deleteMany({ userId }).catch(() => undefined);
  }

  async markReauthRequired(userId: string): Promise<never> {
    await this.markRevoked(userId);
    throw new UnauthorizedError(
      'Google Drive access was revoked. Disconnect and reconnect your Google account.',
      'GOOGLE_DRIVE_REAUTH_REQUIRED'
    );
  }

  /** Testing hook: force the next call to refresh from the encrypted refresh token. */
  clearAccessTokenCache(userId?: string): void {
    if (userId) this.accessTokenCache.delete(userId);
    else this.accessTokenCache.clear();
  }

  async disconnect(userId: string): Promise<GoogleDriveConnectionStatus> {
    const conn = await UserGoogleDriveConnection.findOne({ userId });
    if (conn?.encryptedRefreshToken) {
      try {
        const token = decryptOAuthToken(conn.encryptedRefreshToken);
        await fetch(env.GOOGLE_OAUTH_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(8_000),
        }).catch(() => undefined);
      } catch {
        // Undecryptable tokens are simply deleted below.
      }
    }

    await Promise.all([
      UserGoogleDriveConnection.deleteMany({ userId }),
      GoogleDriveFileSelection.deleteMany({ userId }),
      GoogleDriveOAuthState.deleteMany({ userId }),
    ]);
    this.accessTokenCache.delete(userId);
    this.refreshInFlight.delete(userId);
    return this.getConnectionStatus(userId);
  }
}

let singleton: GoogleDriveOAuthService | null = null;

export function getGoogleDriveOAuthService(): GoogleDriveOAuthService {
  if (!singleton) singleton = new GoogleDriveOAuthService();
  return singleton;
}
