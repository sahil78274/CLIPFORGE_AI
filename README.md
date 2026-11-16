# ClipForge AI

**ClipForge AI** is a full-stack AI video repurposing SaaS platform that converts long-form videos (podcasts, webinars, interviews, tutorials, talks, and commentaries) into platform-ready short-form clips (`9:16`, `1:1`, `16:9`) with automated transcription, scene & moment analysis, speaker-aware reframing, animated word-synced burned-in captions, broadcast loudness normalization, and platform-specific social copy.

---

## Core Capabilities

- **Public Marketing & Auth Experience**: 11 responsive dark-first public pages (`Home`, `Features`, `How It Works`, `Pricing`, `About`, `Contact`, `Login`, `Register`, `Forgot/Reset Password`, `Privacy Policy`, `Terms & Conditions`).
- **Creator Studio Dashboard**: Real-time overview metrics, multi-step Create Clips wizard (drag-and-drop video upload + SSRF-safe public media URL import), Project Detail studio, live 12-stage Processing Queue with cancellation & retry, Clip Library with Range-enabled video preview, metadata editor, clip re-rendering, and Bulk ZIP export.
- **12-Stage Python + FFmpeg + OpenCV Media Pipeline**:
  `Importing` → `Validating` → `Extracting audio` → `Transcribing` → `Detecting scenes` → `Analyzing content` → `Detecting interesting moments` → `Selecting clips` → `Editing` → `Rendering` → `Validating output` → `Completed`.
- **Immutable Credit Wallet & Accounting**: Welcome credits on signup, atomic credit reservation before processing, settlement on completion, automatic idempotent credit release on job failure or cancellation, and append-only `CreditTransaction` ledger.
- **Razorpay INR Payments + Dev Sandbox Simulator**: Server-side order creation, HMAC-SHA256 checkout & raw-body webhook signature verification, duplicate webhook replay protection, refund credit reversal, and an explicitly labelled development sandbox mode when live Razorpay credentials are `NOT CONFIGURED`.
- **Configurable AI Provider Architecture**: Pluggable `AIProvider` supporting **Google Gemini** (`GEMINI_API_KEY`), OpenAI-compatible endpoints, and deterministic transcript-grounded NLP metadata fallback when external LLM keys are `NOT CONFIGURED`.
- **Admin Console & Audit Trail**: Protected admin routes for system health, user search/suspend/restore, manual credit adjustments, job & payment monitoring, configurable credit packages & system limits, and `AdminAuditLog` records.

---

## Monorepo Structure

```text
clipFORGE_AI/
├── client/          # React 18 + Vite 6 + TypeScript + Tailwind CSS + Framer Motion + TanStack Query + Zustand
├── server/          # Node.js + Express + TypeScript + Mongoose + BullMQ/Local Worker + Zod + Vitest
├── processor/       # Python 3.11 + FFmpeg + FFprobe + OpenCV + Faster-Whisper / PocketSphinx 12-stage engine
├── shared/          # Shared TypeScript domain constants, pipeline stages, presets, and interfaces
├── scripts/         # Utility scripts (e.g. generate-sample-video.py for local E2E testing)
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

## Default Development Bootstrap Account

On startup, `ensureSystemBootstrap()` seeds default configurable credit packages, system limits, and a bootstrap administrator account (configurable via `.env`):

| Role | Email | Password |
| :--- | :--- | :--- |
| **Admin** | `admin@clipforge.local` | `Admin@ClipForge2026!` |

> Change `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` immediately before any public or production deployment.

---

## Generating a Sample Test Video & Running Automated E2E Tests

Generate a real multi-scene 1280x720 H.264 + AAC MP4 video for local testing:
```bash
./.venv/bin/python scripts/generate-sample-video.py --output ./sample_input.mp4
```

Run full monorepo TypeScript validation, production builds, and the automated integration test suite (covering auth, SSRF protection, real 12-stage video rendering, FFprobe verification, signed downloads, Bulk ZIP export, credit reserve/deduct/failure-release, payment HMAC + webhook replay protection, and RBAC):
```bash
npm run typecheck
npm run build
npm test
```

---

## External Service Configuration Status

ClipForge AI never hardcodes secrets or fakes external integrations. Any unconfigured external credential surfaces transparently as `NOT CONFIGURED` in `/api/v1/jobs/capabilities` and in the UI:

| Integration | `.env` Keys | Behavior When Unconfigured |
| :--- | :--- | :--- |
| **Google Gemini AI** | `GEMINI_API_KEY`, `GEMINI_MODEL` | Marked `NOT CONFIGURED`; uses deterministic transcript-grounded NLP metadata generator. |
| **Faster-Whisper Weights** | `WHISPER_MODEL_SIZE`, `WHISPER_MODEL_PATH` | Downloads CTranslate2 weights when HuggingFace is reachable, or uses local `WHISPER_MODEL_PATH`; falls back offline to embedded subtitles + PocketSphinx ASR. |
| **Razorpay Live/Test INR** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Marked `NOT CONFIGURED`; non-production dev environments expose a clearly labelled **Sandbox Simulator** whose volume is never counted as live revenue. |
| **Redis / BullMQ** | `REDIS_URL` | Automatically runs persistent MongoDB-backed `local_worker` queue with crash recovery. |
| **S3 / Cloudflare R2** | `STORAGE_PROVIDER=s3`, `S3_*` | Uses local storage adapter (`server/storage`) with HMAC-signed short-lived stream/download tokens. |

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
