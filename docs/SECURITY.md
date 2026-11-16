# Security & Platform Compliance

## 1. Authentication & Session Hardening
- Passwords hashed with `bcryptjs` (cost factor 12); `passwordHash` has `select: false` at the schema layer.
- Access tokens signed with `JWT_ACCESS_SECRET` and issued inside `HttpOnly`, `SameSite=Lax` cookies (`Secure` enabled automatically in production).
- Password reset tokens generated with 32 bytes of `crypto.randomBytes`, stored only as a SHA-256 `tokenHash` with a 30-minute TTL and single-use `usedAt` check.
- Suspended accounts (`status: 'suspended'`) are rejected immediately inside `requireAuth` even if holding an unexpired token.

## 2. Authorization & Strict Tenant Isolation
- Every Project, Video, Clip, ProcessingJob, CreditWallet, CreditTransaction, Payment, and Notification query scopes by `req.user._id` or explicitly verifies ownership (`403 FORBIDDEN` on cross-tenant IDs).
- All `/api/v1/admin/*` routes enforce both `requireAuth` and `requireAdmin`, writing an `AdminAuditLog` entry with `adminId`, `adminEmail`, `ipAddress`, `requestId`, `before`, `after`, and `reason`.

## 3. Upload Validation & Command Execution Safety
- Multipart uploads enforce extension + MIME allowlists (`mp4`, `mov`, `webm`, `mkv`, `m4v`), byte size ceilings, randomized temporary filenames, and mandatory **FFprobe stream inspection** (`probeMediaFile`) before storage or credit reservation. Spoofed non-video files are deleted immediately and rejected (`400 INVALID_MEDIA_CONTAINER`).
- Every Python, FFmpeg, and FFprobe invocation uses `child_process.spawn` / `execFile` / `subprocess.run([...])` with explicit argument arrays (`shell: false`), preventing command injection through filenames, titles, or watermarks.
- Local storage reads resolve canonical paths and enforce containment within `LOCAL_STORAGE_DIR` to prevent path traversal (`../`).

## 4. Signed Short-Lived Media Tokens
- Clip streaming, thumbnails, MP4 downloads, and Bulk ZIP downloads require an HMAC-SHA256 signed token (`userId:resourceType:resourceId:expiresAtUnix`) validated in constant time after strict hex length/character checks.

## 5. SSRF Protection & Respect for Platform Protections
- `urlSafetyService.ts` blocks non-HTTP(S) schemes, `localhost`, `.local`/`.internal` suffixes, IPv4 loopback/private/link-local/cloud-metadata ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`), and IPv6 loopback/unique-local addresses both before DNS lookup and across all resolved DNS A/AAAA records.
- **Ethical Platform Compliance**: ClipForge AI never bypasses DRM, login walls, private video permissions, or anti-scraping protections on YouTube, Instagram, TikTok, Vimeo, or Facebook. When a user pastes a restricted platform link, `/api/v1/videos/check-url` clearly explains platform restrictions and guides the creator to upload their authorized source file directly.

## 6. Google Drive Import (OAuth 2.0 + Official Picker)

- **Minimum scope.** The Drive import flow requests only `https://www.googleapis.com/auth/drive.file` plus OIDC identity scopes. `include_granted_scopes` is intentionally omitted so an existing broader YouTube consent never silently widens Drive access.
- **State validation.** The `state` parameter is `base64url(payload)` + HMAC-SHA256 signed with a domain-separated `JWT_ACCESS_SECRET` key, and it carries a 32-byte nonce whose SHA-256 hash is stored in `GoogleDriveOAuthState`. The callback verifies the signature in constant time (`crypto.timingSafeEqual`), checks the 10-minute expiry, then atomically **consumes** the record via `findOneAndDelete`, so replay, CSRF, and login-CSRF attempts are rejected (`GOOGLE_DRIVE_INVALID_STATE` / `GOOGLE_DRIVE_STATE_EXPIRED`).
- **Token handling.** The authorization code is exchanged only on the backend. The refresh token is encrypted with AES-256-GCM (`GOOGLE_TOKEN_ENCRYPTION_KEY`, `v1:iv:tag:data`) before being written to `usergoogledriveconnections`; rotated refresh tokens are re-encrypted. **Access tokens are never persisted** — they exist only in a bounded in-process cache (≤ 5 minutes) and are refreshed on demand. `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, and refresh tokens are never included in any API response, log line, or frontend bundle. `GET /api/v1/google-drive/config` exposes only the referrer-restricted Picker API key, project number, and OAuth client ID, which are public identifiers by design.
- **Authorized-selection enforcement.** The browser only sends the Picker's file ID to `POST /files/select`. The backend re-fetches `files.get` with *that user's* bearer token, requires an exact ID match, rejects trashed / non-video / non-downloadable / oversized / overlong items, and stores an opaque `GoogleDriveFileSelection` bound to the user with a TTL. Processing jobs reference only the `selectionId`, and every selection read is scoped by `userId` (cross-tenant reads and generation attempts return an indistinguishable `404`). Selections are re-verified at job creation and again at download time; expired handles return `GOOGLE_DRIVE_SELECTION_EXPIRED`.
- **SSRF-safe streaming downloads.** `files.get?alt=media` is fetched with explicit `Range` chunks written directly to a `*.part` file (constant RAM, never whole-file buffering). Redirects are followed manually with a strict allowlist of Google media hosts, the user's bearer token is re-attached only for allowlisted hosts, non-HTTPS redirects are refused, and resume metadata is keyed by file ID + modified time + ETag so a changed object never resumes onto stale bytes.
- **Integrity & lifecycle.** Downloads must match Drive's byte count and (when provided) SHA-256/MD5 checksum and pass FFprobe stream validation before entering the FFmpeg/Faster-Whisper pipeline. `401`/`invalid_grant` marks the connection `revoked` and clears the encrypted secret; disconnect revokes at Google and deletes the connection, selections, and pending states. The worker removes the entire per-job temp directory in a `finally` block, including partial downloads, after both success and failure.
- **Rate limiting.** OAuth authorize/callback/disconnect are limited to 20 requests / 15 min / IP and Drive metadata endpoints to 120 / 15 min / IP, on top of the global API limiter and the job limiter on `/generate`.
