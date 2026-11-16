# REST API Reference (`/api/v1`)

All endpoints return a consistent JSON envelope:

```json
{
  "success": true,
  "data": { ... }
}
```

Error responses include a machine-readable `code` and trace `requestId`:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "Insufficient available credits (10 available, 20 required).",
    "requestId": "8f21b9d2-..."
  }
}
```

Authentication uses an HTTP-only signed JWT cookie (`clipforge_access_token`) or `Authorization: Bearer <token>`.

---

## 1. Health & System Capabilities
- `GET /api/v1/health` — Liveness probe (`200 OK`).
- `GET /api/v1/jobs/capabilities` — Reports FFmpeg/FFprobe availability, active AI provider configuration status, transcription engine status, Razorpay vs. sandbox payment readiness, queue mode, and dynamic `SystemConfig` upload/credit limits.

## 2. Authentication (`/api/v1/auth`)
- `POST /api/v1/auth/register` — Body: `{ name, email, password }`. Hashes password with bcrypt, provisions `CreditWallet` + welcome bonus `CreditTransaction`, sets HTTP-only auth cookie.
- `POST /api/v1/auth/login` — Body: `{ email, password }`. Verifies credentials and sets HTTP-only cookie.
- `POST /api/v1/auth/logout` — Clears session cookie.
- `GET /api/v1/auth/me` *(Auth)* — Returns current user profile and `CreditWallet`.
- `POST /api/v1/auth/forgot-password` — Body: `{ email }`. Generates single-use expiring token (stored as SHA-256 hash in `PasswordResetToken`).
- `POST /api/v1/auth/reset-password` — Body: `{ token, password }`. Validates token, updates `passwordHash`, marks token consumed.

## 3. User & Studio Overview (`/api/v1/users`)
- `GET /api/v1/users/overview` *(Auth)* — Aggregated project/clip/job stats, wallet balance, active jobs, recent projects, and recent clips.
- `PATCH /api/v1/users/profile` *(Auth)* — Updates `name` and studio `preferences` (default aspect ratio, duration preset, language, email notifications).
- `POST /api/v1/users/password` *(Auth)* — Body: `{ currentPassword, newPassword }`.
- `GET /api/v1/users/search?q=...` *(Auth)* — Tenant-scoped search across the authenticated user's projects and clips.

## 4. Projects & Videos (`/api/v1/projects`, `/api/v1/videos`)
- `GET /api/v1/projects` *(Auth)* — Paginated list (`page`, `limit`, `status`, `search`).
- `GET /api/v1/projects/:id` *(Auth)* — Project details, source `Video` metadata, latest `ProcessingJob`, and decorated `Clip` list with signed preview/download/thumbnail URLs.
- `DELETE /api/v1/projects/:id` *(Auth)* — Deletes project, removes stored media artifacts, cancels active jobs, and releases any unsettled reserved credits.
- `POST /api/v1/videos/check-url` — Body: `{ url }`. Performs DNS/IP SSRF validation, detects platform (`youtube`, `instagram`, `tiktok`, `vimeo`, `facebook`, `direct_url`), and returns honest direct-import capability vs. upload fallback guidance.
- `POST /api/v1/videos/upload` *(Auth, Multipart)* — Fields: `video` (file), `title` (optional), `settings` (JSON string). Validates container with FFprobe, stores source video, reserves credits, creates `Project` + `ProcessingJob`, and dispatches worker.
- `POST /api/v1/videos/import-url` *(Auth)* — Body: `{ url, title?, settings? }`. Streams public direct video file (`mp4`/`webm`/`mov`) with SSRF and byte-size enforcement, validates via FFprobe, reserves credits, and dispatches worker.

## 5. Clips & Downloads (`/api/v1/clips`)
- `GET /api/v1/clips` *(Auth)* — Filterable by `projectId`, `aspectRatio`, `search`, `sort` (`newest` | `score` | `duration`).
- `GET /api/v1/clips/:id` *(Auth)* — Single clip with signed media URLs.
- `PATCH /api/v1/clips/:id` *(Auth)* — Body: `{ title }`. Renames clip.
- `PATCH /api/v1/clips/:id/metadata` *(Auth)* — Body: `{ metadata?, captions? }`. Field-wise merge of platform descriptions/hashtags/keywords/title options; sanitises hashtags (`#`-prefixed, deduped) and syncs the clip title from `titleOptions[0]`.
- `PATCH /api/v1/clips/:id/captions` *(Auth)* — Body: `{ captions: [{ startSec, endSec, text, words? }] }`. Persists word-timed caption cues (clip-relative seconds) for display, editing and SRT export.
- `GET /api/v1/clips/:id/metadata?format=json|txt` *(Auth)* — Downloads the clip's publishing metadata (JSON includes captions; TXT is human-readable copy).
- `GET /api/v1/clips/:id/captions.srt` *(Auth)* — Downloads word-timed captions as SRT (falls back to the transcript).
- `GET /api/v1/clips/:id/package` *(Auth)* — ZIP containing the MP4 + metadata `TXT` + metadata `JSON` + captions `SRT`.
- `POST /api/v1/clips/:id/regenerate-metadata` *(Auth)* — Re-runs AI/NLP social copy generation on the clip's transcript.
- `POST /api/v1/clips/:id/regenerate` *(Auth)* — Body: `{ aspectRatio?, captionStyle?, captions? }`. Reserves 5 credits and queues a `regenerate_clip` FFmpeg render job. Passing `captions` re-burns the edited cues through the same ASS caption generator.
- `DELETE /api/v1/clips/:id` *(Auth)* — Removes clip record and underlying video/thumbnail files.
- `POST /api/v1/clips/bulk-download-token` *(Auth)* — Body: `{ clipIds: string[] }`. Verifies ownership and issues a short-lived signed ZIP download URL.
- `GET /api/v1/clips/:id/stream?token=...` — Signed HTTP `206` Range video stream.
- `GET /api/v1/clips/:id/thumbnail?token=...` — Signed JPEG thumbnail stream.
- `GET /api/v1/clips/:id/download?token=...` — Signed MP4 attachment download.
- `GET /api/v1/clips/bulk-download?token=...` — Streams an on-the-fly ZIP of owned clips. Each clip contributes `NN_title.mp4` **plus** `NN_title.txt` (publishing copy), `NN_title.json` (metadata + caption cues) and `NN_title.srt`, together with a top-level `clipforge_manifest.json`.

## 6. Processing Jobs (`/api/v1/jobs`)
- `GET /api/v1/jobs` *(Auth)* — Lists user's jobs (`status` filter optional).
- `GET /api/v1/jobs/:id` *(Auth)* — Live stage, percentage, stage history, credit settlement status, and structured error details.
- `POST /api/v1/jobs/:id/cancel` *(Auth)* — Terminates running Python/FFmpeg subprocess and releases reserved credits.
- `POST /api/v1/jobs/:id/retry` *(Auth)* — Re-reserves credits and queues a fresh job for a failed/cancelled job.

## 6b. Google Drive Import (`/api/v1/google-drive`)

Minimum scope: `https://www.googleapis.com/auth/drive.file` (+ `openid email profile`).
Refresh tokens are encrypted with AES-256-GCM at rest; access tokens are never persisted and
never returned except as a short-lived Picker token. No endpoint returns the OAuth client secret.

- `GET /api/v1/google-drive/config` — Public, browser-safe Picker configuration: `apiKey`, `projectNumber`, `oauthClientId`, `redirectUri`, `scopes`, `supportedMimeTypes`, `maxFileSizeBytes`, `maxDurationSec`, plus `oauthConfigured` / `pickerConfigured` and setup guidance. Never includes the client secret.
- `POST /api/v1/google-drive/oauth/authorize` *(Auth)* — Body: `{ redirectPath?, loginHint? }`. Returns `{ authorizationUrl, expiresAt }`. Signed, single-use, 10-minute state; `access_type=offline`, `prompt=consent`, no `include_granted_scopes`.
- `GET /api/v1/google-drive/oauth/callback` — Google redirect target (`GOOGLE_REDIRECT_URI`). Exchanges the authorization code server-side, verifies `drive.file` was granted, requires an offline refresh token, fetches the OIDC profile, encrypts and upserts the refresh token. HTML callers are redirected to the client with `driveConnected=1` or `driveError=cancelled|<message>`; `?format=json` returns JSON. Also mounted at `/api/v1/youtube/oauth/google/callback` as a dispatcher.
- `GET /api/v1/google-drive/status` *(Auth)* — `connected`, `email`, `displayName`, `avatarUrl`, `scopes`, `hasRequiredScope`, `status` (`active` | `revoked`).
- `POST /api/v1/google-drive/oauth/disconnect` *(Auth)* — Revokes the token at Google and deletes the connection, selections, and pending states.
- `GET /api/v1/google-drive/picker-token` *(Auth)* — `{ accessToken, expiresAt, expiresInSec, scopes }` for the official Picker widget only (`Cache-Control: no-store`). 401 `GOOGLE_DRIVE_REAUTH_REQUIRED` when revoked.
- `POST /api/v1/google-drive/files/select` *(Auth)* — Body: `{ fileId }` from the Picker. Re-verifies with the user's own token (`404 GOOGLE_DRIVE_FILE_NOT_FOUND`, `403 GOOGLE_DRIVE_ACCESS_DENIED`, `400 GOOGLE_DRIVE_NOT_VIDEO`), then returns an opaque user-bound selection: `{ selectionId, fileId, name, mimeType, sizeBytes, durationSec, width, height, thumbnailUrl, modifiedTime, expiresAt }`.
- `GET /api/v1/google-drive/selections/:id` *(Auth)* — Re-reads a selection. Another user's selection returns the same `404 GOOGLE_DRIVE_SELECTION_NOT_FOUND`; expired returns `400 GOOGLE_DRIVE_SELECTION_EXPIRED`.
- `GET /api/v1/google-drive/selections/:id/thumbnail` *(Auth)* — Same-origin proxied Drive thumbnail (host allowlist, access token never exposed).
- `POST /api/v1/google-drive/generate` *(Auth)* — Body: `{ selectionId, title?, settings?, autoStart? }`. Re-verifies the file, computes credits/chunk plan, reserves credits, creates a `Project` (`sourcePlatform: 'google_drive'`, `googleDriveMetadata`) and a `ProcessingJob` (`driveImport`), and enqueues. Returns `{ project, job, file, estimatedCredits, chunkPlan }`.

Rate limits: 20/15 min for OAuth endpoints, 120/15 min for Drive metadata endpoints, plus the standard job limiter on `/generate`.

## 7. Credit Wallet & Payments (`/api/v1/wallet`, `/api/v1/payments`)
- `GET /api/v1/wallet` *(Auth)* — Current `availableCredits`, `reservedCredits`, and lifetime totals.
- `GET /api/v1/wallet/transactions` *(Auth)* — Paginated immutable `CreditTransaction` ledger (`type` filter optional).
- `GET /api/v1/payments/packages` — Active admin-configurable INR credit packages.
- `GET /api/v1/payments/history` *(Auth)* — User's payment & invoice history.
- `POST /api/v1/payments/create-order` *(Auth)* — Body: `{ packageId, useSandboxSimulator? }`. Creates server-side Razorpay order (or labelled dev sandbox order in non-production).
- `POST /api/v1/payments/verify` *(Auth)* — Body: `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }`. Verifies HMAC-SHA256 signature and idempotently grants credits.
- `POST /api/v1/payments/webhook` — Verifies `X-Razorpay-Signature` against raw request bytes, deduplicates `X-Razorpay-Event-Id`, and handles `payment.captured`, `order.paid`, `payment.failed`, and `refund.processed`.

## 8. Notifications & Support (`/api/v1/notifications`)
- `POST /api/v1/notifications/contact` — Public support/contact ticket submission (`ticketRef`).
- `GET /api/v1/notifications` *(Auth)* — Recent notifications and `unreadCount`.
- `PATCH /api/v1/notifications/:id/read` *(Auth)* — Marks notification read.
- `POST /api/v1/notifications/read-all` *(Auth)* — Marks all user notifications read.

## 9. Admin Console (`/api/v1/admin` — `requireAuth` + `requireAdmin`)
- `GET /api/v1/admin/overview` — Platform metrics (separating `liveRevenuePaise` from `sandboxVolumePaise`), infrastructure health, and queue counts.
- `GET /api/v1/admin/users` — Searchable user directory with attached `CreditWallet` balances.
- `PATCH /api/v1/admin/users/:id/status` — Suspend or restore user (`AdminAuditLog` recorded).
- `POST /api/v1/admin/users/:id/credits` — Positive or negative credit adjustment with mandatory reason (`AdminAuditLog` + `CreditTransaction` recorded).
- `GET /api/v1/admin/users/:id/activity` — User's projects, jobs, and ledger history.
- `GET /api/v1/admin/jobs` — Cross-platform job monitor.
- `GET /api/v1/admin/payments` & `POST /api/v1/admin/payments/:id/refund` — Payment monitor and administrative refund + credit reversal.
- `GET /api/v1/admin/packages`, `POST /api/v1/admin/packages`, `PATCH /api/v1/admin/packages/:id` — Manage configurable INR credit packages.
- `GET /api/v1/admin/config` & `PATCH /api/v1/admin/config` — Update welcome credits, credit rates, upload/duration limits, and platform toggles.
- `GET /api/v1/admin/audit-logs` — Immutable admin audit trail and recent pipeline error diagnostics.
