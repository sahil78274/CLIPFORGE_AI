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
- `PATCH /api/v1/clips/:id/metadata` *(Auth)* — Updates platform descriptions, hashtags, CTA, or title options.
- `POST /api/v1/clips/:id/regenerate-metadata` *(Auth)* — Re-runs AI/NLP social copy generation on the clip's transcript.
- `POST /api/v1/clips/:id/regenerate` *(Auth)* — Body: `{ startSec?, endSec?, aspectRatio?, captionStyle? }`. Reserves 4 credits and queues a `regenerate_clip` FFmpeg render job.
- `DELETE /api/v1/clips/:id` *(Auth)* — Removes clip record and underlying video/thumbnail files.
- `POST /api/v1/clips/bulk-download-token` *(Auth)* — Body: `{ clipIds: string[] }`. Verifies ownership and issues a short-lived signed ZIP download URL.
- `GET /api/v1/clips/:id/stream?token=...` — Signed HTTP `206` Range video stream.
- `GET /api/v1/clips/:id/thumbnail?token=...` — Signed JPEG thumbnail stream.
- `GET /api/v1/clips/:id/download?token=...` — Signed MP4 attachment download.
- `GET /api/v1/clips/bulk-download?token=...` — Streams on-the-fly ZIP archive of owned clips.

## 6. Processing Jobs (`/api/v1/jobs`)
- `GET /api/v1/jobs` *(Auth)* — Lists user's jobs (`status` filter optional).
- `GET /api/v1/jobs/:id` *(Auth)* — Live stage, percentage, stage history, credit settlement status, and structured error details.
- `POST /api/v1/jobs/:id/cancel` *(Auth)* — Terminates running Python/FFmpeg subprocess and releases reserved credits.
- `POST /api/v1/jobs/:id/retry` *(Auth)* — Re-reserves credits and queues a fresh job for a failed/cancelled job.

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
