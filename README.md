# ClipForge AI

**ClipForge AI** is a full-stack AI video repurposing SaaS platform that converts YouTube links and long-form videos up to **10 hours (`36,000` seconds)** (podcasts, webinars, interviews, tutorials, talks, and keynotes) into platform-ready short-form clips (`9:16`, `1:1`, `16:9`) with automated Faster-Whisper transcription, AI moment detection, speaker-aware reframing, animated word-synced burned-in captions, broadcast loudness normalization, and platform-specific social copy.

---

## Core Capabilities

- **YouTube URL-to-AI-Clips System (Up to 10 Hours)**:
  - Accepts standard YouTube watch URLs (`youtube.com/watch?v=...`), short links (`youtu.be/...`), Shorts (`youtube.com/shorts/...`), live VODs (`youtube.com/live/...`), and embeds (`youtube.com/embed/...`), validating URLs and extracting the canonical 11-character Video ID.
  - **Strict Separation of Metadata & Media Acquisition**: Dedicated YouTube metadata extraction (`YouTube Data API v3` + `YouTube oEmbed` + sidecar manifests) is kept completely separate from actual video stream acquisition — oEmbed JSON/thumbnails are never treated as downloadable video media.
  - **Configurable Authorized Media-Source Adapter**: Pluggable `YouTubeMediaSourceAdapter` (`composite`, `owner_export_dir`, `authorized_http_provider`, `custom_command`, plus owner-authorized signed media URLs) streams real video containers directly to disk, validates codecs/streams with `FFprobe`, and surfaces clear, actionable errors when actual media cannot be accessed.
- **10-Hour Chunk-Based Streaming Media Engine (Constant Bounded RAM)**:
  - Processes videos up to **10 hours (`36,000`s)** without loading the complete video or uncompressed audio into RAM.
  - Divides long videos into configurable chunks (default `600`s = 10-minute windows with `5`s overlap), extracts 16 kHz PCM audio per chunk via `O(1)` container timestamp seeking (`-ss` before `-i`), immediately deletes temporary chunk WAVs after analysis, maintains exact global video timestamps across chunks, and deduplicates cross-seam speech and clip candidates.
  - **Atomic Checkpoint Persistence & Crash Recovery**: Writes atomic per-chunk JSON checkpoints (`checkpoints/job_<id>.json`) so transient worker interruptions and server restarts (`recoverOrphanedJobsOnStartup`) automatically resume from the last completed chunk without repeating completed work or double-charging credits.
- **Creator Studio Dashboard**:
  - Dedicated **YouTube Link** tab in **Create Short Clips** (plus quick-launch bar on Dashboard Overview) with Paste URL input, **Fetch Video** preview card (thumbnail, title, channel, duration, media-access status, chunk plan), clip & chunk size controls, **Generate Clips** trigger, live inline 12-stage + chunk progress tracker, and inline **MP4 preview & Bulk ZIP download**.
  - Project Detail studio, Processing Queue with live `Chunk X/Y` badges, cancellation & retry, and Clip Library with Range-enabled video streaming, metadata editor, and clip re-rendering.
- **12-Stage Python + FFmpeg + OpenCV Media Pipeline**:
  `Importing` → `Validating` → `Extracting audio` → `Transcribing` → `Detecting scenes` → `Analyzing content` → `Detecting interesting moments` → `Selecting clips` → `Editing` → `Rendering` → `Validating output` → `Completed`.
- **Immutable Credit Wallet & Accounting**: Welcome credits on signup, atomic credit reservation before processing, settlement **only after all rendered clips pass FFprobe output validation**, automatic 100% credit refund on job failure or cancellation, and append-only `CreditTransaction` ledger.
- **Razorpay INR Payments + Dev Sandbox Simulator**: Server-side order creation, HMAC-SHA256 checkout & raw-body webhook signature verification, duplicate webhook replay protection, refund credit reversal, and an explicitly labelled development sandbox mode when live Razorpay credentials are `NOT CONFIGURED`.
- **Configurable AI Provider Architecture**: Pluggable `AIProvider` supporting **Google Gemini** (`GEMINI_API_KEY`), OpenAI-compatible endpoints (`OPENAI_API_KEY`), and deterministic transcript-grounded NLP scoring/metadata fallback when external LLM keys are `NOT CONFIGURED`.
- **Admin Console & Audit Trail**: Protected admin routes for system health, user search/suspend/restore, manual credit adjustments, job & payment monitoring, configurable credit packages & system limits, and `AdminAuditLog` records.

---

## Monorepo Structure

```text
clipFORGE_AI/
├── client/          # React 18 + Vite 6 + TypeScript + Tailwind CSS + Framer Motion + TanStack Query + Zustand
├── server/          # Node.js + Express + TypeScript + Mongoose + BullMQ/Local Worker + YouTube Import & Adapters
├── processor/       # Python 3.11 + FFmpeg + FFprobe + OpenCV + Faster-Whisper 12-stage chunked streaming engine
├── shared/          # Shared TypeScript domain constants, 10h chunk presets, credit estimator, and interfaces
├── scripts/         # Utility & fixture scripts (generate-sample-video.py, generate-long-video-fixture.py)
├── docs/            # Complete architecture, API, database, pipeline, payments, security, and deployment docs
└── docker-compose.yml
```

---

## Quick Start — Windows (PowerShell)

### 1. Prerequisites
Install the following on Windows 10/11:
- **Node.js 20+ LTS**: `winget install OpenJS.NodeJS.LTS`
- **Python 3.11+**: `winget install Python.Python.3.11`
- **FFmpeg & FFprobe** *(optional — ClipForge automatically falls back to bundled `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe` npm binaries if `ffmpeg` is not on `PATH`)*: `winget install Gyan.FFmpeg`
- **MongoDB Community Server** *(or MongoDB Atlas URI; local offline dev also includes an automatic embedded MongoDB wire-protocol fallback)*
- **Redis** *(optional — uses BullMQ when Redis is running, or falls back automatically to the persistent MongoDB-backed local worker)*

### 2. Clone & Install Dependencies (PowerShell)
```powershell
git clone https://github.com/sahil78274/clipFORGE_AI.git
Set-Location .\clipFORGE_AI

# Copy environment template
Copy-Item .\.env.example .\.env

# Install Node workspace dependencies and build shared types
npm install
npm --workspace=shared run build

# Create Python virtual environment and install media processor packages
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r .\processor\requirements.txt
```

> **Windows PowerShell Note**: Set `PYTHON_BIN=.venv\Scripts\python.exe` in `.env` if your system default `python` points to a global installation rather than `.venv`. ClipForge automatically detects `.venv\Scripts\python.exe` on Windows when present.

### 3. Run Development Servers (PowerShell)
Open two PowerShell terminals at the repository root:

**Terminal 1 — Backend API + Background Media Worker (`http://localhost:4000`):**
```powershell
npm run dev:server
```

**Terminal 2 — Frontend Vite Studio (`http://localhost:5173`):**
```powershell
npm run dev:client
```

Open **`http://localhost:5173`** in your browser.

---

## Quick Start — Linux / macOS (Bash / Zsh)

```bash
cp .env.example .env
npm install
npm --workspace=shared run build

python3 -m venv .venv
./.venv/bin/pip install -r processor/requirements.txt

# Start both API server (:4000) and Vite frontend (:5173) concurrently
npm run dev
```

---

## Configuring YouTube URL-to-Clips & Long-Video Processing

ClipForge AI strictly separates **YouTube metadata discovery** from **authorized video media acquisition** in `.env`:

```dotenv
# Maximum video duration (36000s = 10 hours) and chunked processing defaults
MAX_VIDEO_DURATION_SEC=36000
VIDEO_CHUNK_DURATION_SEC=600
VIDEO_CHUNK_OVERLAP_SEC=5
JOB_TIMEOUT_MS=7200000

# 1. YouTube Metadata Discovery (Separated from video download)
YOUTUBE_DATA_API_KEY=
YOUTUBE_OEMBED_ENDPOINT=https://www.youtube.com/oembed

# 2. Configurable Authorized YouTube Media-Source Adapter
# Modes: composite | owner_export_dir | authorized_http_provider | custom_command
YOUTUBE_MEDIA_ADAPTER=composite

# Option A — Owner-Authorized Exports Directory:
# Place <videoId>.mp4 (and optional <videoId>.meta.json) in this folder, or pass an
# owner-authorized signed HTTPS media URL in the dashboard / API request.
YOUTUBE_AUTHORIZED_EXPORTS_DIR=./server/storage/authorized-youtube-exports

# Option B — Authorized HTTP Media Bridge Service:
# Receives ?videoId={videoId}&url={url} and returns either a streamed video/* container
# or JSON {"downloadUrl": "https://..."}.
YOUTUBE_MEDIA_PROVIDER_URL=
YOUTUBE_MEDIA_PROVIDER_TOKEN=
YOUTUBE_MEDIA_PROVIDER_TIMEOUT_MS=1800000

# Option C — Authorized Custom Media Acquisition Command:
# Placeholders {videoId}, {url}, and {outputTemplate} are substituted safely without shell interpolation.
YOUTUBE_MEDIA_DOWNLOAD_CMD=
```

### Key YouTube REST Endpoints (`/api/v1/youtube`)
- `GET /api/v1/youtube/adapter-status` — Reports active media-source adapter, configuration status, max duration (`36,000`s), and setup guidance.
- `POST /api/v1/youtube/fetch` — Validates YouTube URL, extracts 11-char `videoId`, fetches separated metadata (`title`, `channelName`, `thumbnailUrl`, `durationSec`), checks authorized media availability, and returns the chunk plan & credit estimate.
- `POST /api/v1/youtube/generate` — Verifies authorized media availability (never fakes imports from oEmbed metadata), reserves credits atomically, creates the project & recoverable background job, and dispatches the 12-stage chunked pipeline.

---

## Default Development Bootstrap Account

On startup, `ensureSystemBootstrap()` seeds default configurable credit packages, system limits, and a bootstrap administrator account (configurable via `.env`):

| Role | Email | Password |
| :--- | :--- | :--- |
| **Admin** | `admin@clipforge.local` | `Admin@ClipForge2026!` |

> Change `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` immediately before any public or production deployment.

---

## Generating Sample / Multi-Hour Test Videos & Running Automated E2E Tests

Generate a short multi-scene 1280x720 H.264 + AAC MP4 video:
```bash
./.venv/bin/python scripts/generate-sample-video.py --output ./sample_input.mp4
```

Generate a multi-hour (e.g. 1-hour = `3600`s, 5-hour = `18000`s, or 10-hour = `36000`s) H.264 + AAC + subtitle MP4 fixture in `YOUTUBE_AUTHORIZED_EXPORTS_DIR` for local YouTube testing:
```bash
./.venv/bin/python scripts/generate-long-video-fixture.py \
  --output ./server/storage/authorized-youtube-exports/dQw4w9WgXcQ.mp4 \
  --duration 3600
```

Run full monorepo TypeScript validation, production builds, and all 14 automated end-to-end integration tests (covering short YouTube videos, 1h / 5h / 10h chunked videos, invalid URLs, private/unavailable videos, failed media access credit refunds, interrupted processing & server-restart checkpoint recovery, direct uploads, Razorpay HMAC verification, and RBAC):
```bash
npm run typecheck
npm run build
npm --workspace=server run test -- --fileParallelism=false
```

---

## External Service Configuration Status

ClipForge AI never hardcodes secrets or fakes external integrations. Any unconfigured external credential surfaces transparently as `NOT CONFIGURED` in `/api/v1/jobs/capabilities` and in the UI:

| Integration | `.env` Keys | Behavior When Unconfigured |
| :--- | :--- | :--- |
| **YouTube Data API v3** | `YOUTUBE_DATA_API_KEY` | Falls back to YouTube oEmbed + authorized export container `FFprobe` inspection for metadata & duration. |
| **YouTube Media Source** | `YOUTUBE_MEDIA_ADAPTER`, `YOUTUBE_AUTHORIZED_EXPORTS_DIR`, `YOUTUBE_MEDIA_PROVIDER_URL`, `YOUTUBE_MEDIA_DOWNLOAD_CMD` | Uses `owner_export_dir` / signed export URLs when provided; blocks clip generation with clear setup instructions when no authorized media stream is accessible. |
| **Google Gemini / OpenAI** | `AI_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | Marked `NOT CONFIGURED`; uses deterministic transcript-grounded NLP moment scoring & metadata generator. |
| **Faster-Whisper Weights** | `WHISPER_MODEL_SIZE`, `WHISPER_MODEL_PATH` | Downloads CTranslate2 weights when HuggingFace is reachable, or uses local `WHISPER_MODEL_PATH`; falls back offline to embedded subtitles + PocketSphinx ASR. |
| **Razorpay Live/Test INR** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Marked `NOT CONFIGURED`; non-production dev environments expose a clearly labelled **Sandbox Simulator** whose volume is never counted as live revenue. |
| **Redis / BullMQ** | `REDIS_URL` | Automatically runs persistent MongoDB-backed `local_worker` queue with startup checkpoint crash recovery. |
| **S3 / Cloudflare R2** | `STORAGE_PROVIDER=s3`, `S3_*` | Uses streaming local storage adapter (`server/storage`) with HMAC-signed short-lived stream/download tokens. |

---

## Documentation Index

- [System Architecture](docs/ARCHITECTURE.md)
- [REST API Reference (`/api/v1`)](docs/API.md)
- [Database Schema & Indexes](docs/DATABASE.md)
- [12-Stage Video Processing Pipeline](docs/VIDEO_PROCESSING.md)
- [Razorpay INR Payments & Webhooks](docs/PAYMENTS.md)
- [Security & Platform Compliance](docs/SECURITY.md)
- [Production Deployment Guide](docs/DEPLOYMENT.md)
- [Environment Setup Guide (Windows, macOS, Linux)](docs/ENVIRONMENT_SETUP.md)
