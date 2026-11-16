# System Architecture

## 1. High-Level Overview

ClipForge AI is structured as a modular monorepo with four cleanly separated layers:

1. **`client/` (React + Vite + TypeScript SPA)**:
   - Public marketing website, authentication flows, Creator Studio dashboard, and Admin Console.
   - Communicates exclusively over relative `/api/v1/*` endpoints (proxied in development by Vite to the Express API server) with `credentials: 'include'` for HTTP-only cookie authentication.
2. **`server/` (Node.js + Express + TypeScript API & Queue Worker)**:
   - Stateless REST controllers, Zod request validation, JWT cookie/Bearer authentication, RBAC guards, rate limiters, SSRF-safe URL inspection, FFprobe preflight checks, atomic Credit Wallet ledger, Razorpay checkout/webhook verification, and AI metadata orchestration.
   - Dispatches heavy video jobs to **BullMQ** (when Redis is configured) or a persistent MongoDB-backed **Local Queue Worker** with crash recovery.
3. **`processor/` (Python 3.11 Media Engine)**:
   - Invoked by the Node worker via `child_process.spawn` (strictly argument-array invocation, never shell interpolation).
   - Executes all 12 media pipeline stages using **FFprobe**, **FFmpeg** (`libx264`, `aac`, `libass`, `afftdn`, `loudnorm`), **OpenCV** (`cv2`), **Faster-Whisper** / **PocketSphinx**, and **NumPy**.
   - Streams structured JSON lines (`CF_EVENT:{...}` and `CF_ERROR:{...}`) over `stdout` so the Node worker persists real-time stage and percentage updates to `ProcessingJob`.
4. **`shared/` (`@clipforge/shared`)**:
   - Single source of truth for `PIPELINE_STAGES`, `DURATION_PRESETS`, `ASPECT_RATIOS`, `CaptionStyleConfig`, and `ProjectProcessingSettings`.

---

## 2. Data & Job Lifecycle Flow

```text
[Creator Browser]
   │  POST /api/v1/videos/upload (Multipart MP4/MOV/WebM/MKV + Settings JSON)
   ▼
[Express API Server]
   ├─► Multer stores upload in temp/uploads/
   ├─► FFprobe validates real video stream, resolution, codec & duration
   ├─► StorageAdapter persists source video (local or S3/R2)
   ├─► WalletService atomically reserves credits (CreditTransaction: reserve)
   ├─► Creates Project, Video, and ProcessingJob (status: queued)
   └─► Enqueues jobId into BullMQ (Redis) or persistent Local Worker
          │
          ▼
[Background Video Worker]
   ├─► Atomically claims ProcessingJob (queued -> processing)
   ├─► Spawns Python processor/main.py with JSON config file
   ├─► Parses CF_EVENT lines -> updates ProcessingJob.stage & progressPercent
   ├─► Uploads rendered MP4 clips & JPEG thumbnails via StorageAdapter
   ├─► Generates platform copy via AIProvider (Gemini / OpenAI / NLP fallback)
   ├─► Settles credit reservation (settleReservedCredits) -> creates Notification
   └─► Cleans temporary job working folder in finally {}
          │  (On error / timeout / user cancel)
          └─► failAndReleaseJob() idempotently returns 100% of reserved credits
```

---

## 3. Pluggable Adapters

### Storage Adapter (`server/src/services/storageService.ts`)
- **`LocalStorageAdapter`**: Stores files inside `LOCAL_STORAGE_DIR` with path-traversal canonicalization (`path.resolve` prefix check) and serves clips via HTTP `206 Partial Content` Range streaming protected by HMAC-SHA256 short-lived media tokens.
- **`S3CompatibleStorageAdapter`**: Stores and retrieves objects from AWS S3, Cloudflare R2, or MinIO via `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.

### AI Metadata Provider (`server/src/services/aiService.ts`)
- **`GeminiAIProvider`**: Calls Google Gemini (`gemini-2.0-flash` by default) with structured JSON schema output to produce grounded titles, platform-tailored captions, hashtags, hooks, and CTA recommendations.
- **`OpenAICompatibleProvider`**: Connects to OpenAI-compatible `/chat/completions` endpoints.
- **`DeterministicTranscriptProvider`**: Extractive NLP fallback used automatically when external LLM keys are `NOT CONFIGURED` or transiently unreachable.

### Queue & Crash Recovery (`server/src/queues/videoQueue.ts`)
- On server boot, `recoverOrphanedJobsOnStartup()` scans `ProcessingJob` records:
  - Interrupted `processing` jobs from an unclean process termination are marked `failed` (`WORKER_RESTART_INTERRUPTED`) and their reserved credits are automatically released back to the user's wallet.
  - Waiting `queued` jobs are re-enqueued in FIFO order.
