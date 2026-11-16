# Database Schema & Indexes

ClipForge AI uses **MongoDB** with **Mongoose v8** schemas, strict validation, compound indexes, and ledger immutability hooks.

---

## Collections

### 1. `User` (`users`)
- **Fields**: `name`, `email` (unique, lowercase), `passwordHash` (`select: false`), `role` (`user` | `admin`), `status` (`active` | `suspended`), `preferences` (`defaultAspectRatio`, `defaultDurationPreset`, `defaultLanguage`, `emailNotifications`), `lastLoginAt`, `createdAt`, `updatedAt`.
- **Indexes**: `{ email: 1 }` (unique), `{ role: 1 }`, `{ status: 1 }`, `{ createdAt: -1 }`.

### 2. `CreditWallet` (`creditwallets`)
- **Fields**: `userId` (unique ref `User`), `availableCredits` (min `0`), `reservedCredits` (min `0`), `lifetimeEarnedCredits`, `lifetimePurchasedCredits`, `lifetimeUsedCredits`, `lifetimeRefundedCredits`.
- **Concurrency Safety**: Updated via serialized per-user locks combined with atomic `$gte` conditional `findOneAndUpdate` filters so balances can never go negative.

### 3. `CreditTransaction` (`credittransactions` — Append-Only Immutable Ledger)
- **Fields**: `userId`, `walletId`, `type` (`welcome_bonus` | `purchase` | `reserve` | `deduct` | `release_reserve` | `refund` | `admin_adjustment`), `amount`, `balanceAfter`, `reservedAfter`, `referenceType` (`signup` | `job` | `payment` | `admin`), `referenceId`, `idempotencyKey` (unique), `description`, `metadata`, `createdBy`, `createdAt`.
- **Immutability**: Mongoose `pre` hooks block `updateOne`, `findOneAndUpdate`, `deleteOne`, and `findOneAndDelete` operations with an explicit immutability error.
- **Indexes**: `{ idempotencyKey: 1 }` (unique), `{ userId: 1, createdAt: -1 }`, `{ referenceType: 1, referenceId: 1 }`.

### 4. `Project` (`projects`)
- **Fields**: `userId`, `title`, `description`, `sourceType` (`upload` | `direct_url`), `sourceUrl`, `sourcePlatform`, `videoId`, `latestJobId`, `status` (`draft` | `queued` | `processing` | `completed` | `failed` | `cancelled`), `settings` (`ProjectProcessingSettings`), `transcript` (`language`, `engine`, `fullText`, `segments`), `clipCountGenerated`, `creditsReserved`, `creditsCharged`, `errorMessage`.
- **Indexes**: `{ userId: 1, createdAt: -1 }`, `{ userId: 1, status: 1 }`.

### 5. `Video` (`videos`)
- **Fields**: `userId`, `projectId`, `originalFilename`, `storageProvider` (`local` | `s3`), `storageKey`, `mimeType`, `sizeBytes`, `durationSec`, `width`, `height`, `fps`, `videoCodec`, `audioCodec`, `hasAudio`, `checksumSha256`, `validatedAt`.
- **Indexes**: `{ userId: 1, projectId: 1 }`.

### 6. `ProcessingJob` (`processingjobs`)
- **Fields**: `userId`, `projectId`, `videoId`, `type` (`full_pipeline` | `regenerate_clip`), `targetClipId`, `overrides`, `queueMode` (`bullmq_redis` | `local_worker`), `stage` (12 pipeline stages + `failed` / `cancelled`), `status` (`queued` | `processing` | `completed` | `failed` | `cancelled`), `progressPercent`, `currentMessage`, `stageHistory[]`, `creditsReserved`, `creditsDeducted`, `creditReservationReleased`, `attempts`, `maxAttempts`, `workerPid`, `startedAt`, `completedAt`, `cancelledAt`, `error`, `idempotencyKey`.
- **Indexes**: `{ userId: 1, createdAt: -1 }`, `{ status: 1, createdAt: 1 }`, `{ projectId: 1, createdAt: -1 }`.

### 7. `Clip` (`clips`)
- **Fields**: `userId`, `projectId`, `videoId`, `jobId`, `orderIndex`, `title`, `startSec`, `endSec`, `durationSec`, `aspectRatio` (`9:16` | `1:1` | `16:9`), `width`, `height`, `storageProvider`, `storageKey`, `thumbnailKey`, `fileSizeBytes`, `transcript`, `segments`, `engagementScore` (`0–100`), `scoreBreakdown` (`hookStrength`, `clarity`, `emotionalPeak`, `pacing`, `completeness`, `rationale`), `captionStyle`, `metadata` (`titleOptions`, `descriptions`, `hashtags`, `hookSummary`, `ctaSuggestion`, `aiProviderUsed`), `status` (`ready` | `regenerating` | `failed`).
- **Indexes**: `{ userId: 1, createdAt: -1 }`, `{ projectId: 1, orderIndex: 1 }`, `{ userId: 1, engagementScore: -1 }`.

### 8. `Payment` (`payments`)
- **Fields**: `userId`, `packageId`, `packageSnapshot`, `provider` (`razorpay` | `razorpay_sandbox_dev`), `isDevelopmentMode`, `razorpayOrderId` (unique), `razorpayPaymentId`, `razorpaySignatureVerified`, `amountPaise`, `currency` (`INR`), `creditsGranted`, `status` (`created` | `captured` | `verified` | `failed` | `refunded`), `webhookEventIds[]`, `refundAmountPaise`, `refundReason`, `refundedAt`, `failureReason`.
- **Indexes**: `{ razorpayOrderId: 1 }` (unique), `{ userId: 1, createdAt: -1 }`, `{ status: 1 }`.

### 9. `Notification`, `AdminAuditLog`, `PasswordResetToken`, `CreditPackage`, `SystemConfig`
- **`Notification`**: `{ userId: 1, isRead: 1, createdAt: -1 }` — user alerts and contact submissions.
- **`AdminAuditLog`**: `{ createdAt: -1 }`, `{ adminId: 1 }` — immutable audit record of every privileged action.
- **`PasswordResetToken`**: `{ tokenHash: 1 }` (unique), `{ expiresAt: 1 }` (TTL index) — single-use SHA-256 hashed tokens.
- **`CreditPackage`** & **`SystemConfig`**: Admin-editable pricing tiers and platform processing limits.

---

## Google Drive Import Collections

| Collection | Purpose | Key fields & indexes |
| --- | --- | --- |
| `usergoogledriveconnections` | One row per ClipForge user with a linked Google account. | `userId` (unique, indexed), `googleAccountId`, `email`, `encryptedRefreshToken` (AES-256-GCM `v1:` payload — **no access token is ever stored**), `scopes`, `status` (`active` \| `revoked`), `connectedAt`, `lastRefreshedAt`. |
| `googledriveoauthstates` | Short-lived, single-use CSRF/replay records for in-flight consent attempts. | `userId` (indexed), `nonceHash` (unique, indexed — SHA-256 of the state nonce), `redirectPath`, `expiresAt` (indexed). Consumed atomically via `findOneAndDelete`. |
| `googledrivefileselections` | Server-verified, user-bound handles for a Picker selection. Jobs reference only `_id`. | `userId` (indexed), `connectionGoogleAccountId`, `fileId`, `name`, `mimeType`, `sizeBytes`, `durationSec`, `width`, `height`, `thumbnailLink`, `md5Checksum` / `sha256Checksum`, `driveModifiedTime`, `expiresAt` (indexed), `lastVerifiedAt`; compound index `{ userId, createdAt }`. |

`projects` gained `sourcePlatform: 'google_drive'` plus a `googleDriveMetadata` sub-document
(`selectionId`, `fileId`, `fileName`, `mimeType`, `sizeBytes`, `durationSec`, `thumbnailUrl`).
`processingjobs` gained `driveImport` (`selectionId`, `fileId`, `fileName`, `mimeType`,
`sizeBytes`, `durationSec`, `estimatedDurationSec`) so imports are replayable after restarts.
