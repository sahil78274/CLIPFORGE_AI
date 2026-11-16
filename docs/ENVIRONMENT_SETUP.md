# Environment Setup Guide

This guide covers full local workstation setup on **Windows PowerShell**, **macOS**, and **Ubuntu/Debian Linux**, along with every `.env` configuration variable.

---

## 1. Windows 10 / 11 (PowerShell)

```powershell
# 1. Install runtimes with winget (if not already installed)
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.11
winget install Gyan.FFmpeg

# 2. Restart PowerShell so PATH updates take effect, then navigate to repo
Set-Location C:\path\to\clipFORGE_AI
Copy-Item .\.env.example .\.env

# 3. Install npm workspaces & compile shared package
npm install
npm --workspace=shared run build

# 4. Create Python virtualenv & install processor dependencies
py -3.11 -m venv .venv
# If script execution is restricted, allow current process:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r .\processor\requirements.txt

# 5. Verify Python media processor CLI
.\.venv\Scripts\python.exe .\processor\main.py --help

# 6. Run automated verification suite
npm test
```

---

## 2. Ubuntu / Debian Linux & macOS

```bash
# Ubuntu system packages (optional if using bundled npm @ffmpeg-installer binaries):
# sudo apt-get update && sudo apt-get install -y python3-venv ffmpeg fonts-dejavu-core

# macOS Homebrew:
# brew install node python@3.11 ffmpeg

cp .env.example .env
npm install
npm --workspace=shared run build

python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r processor/requirements.txt

./.venv/bin/python processor/main.py --help
npm test
```

---

## 3. Environment Variable Reference (`.env`)

| Variable | Required | Default (Dev) | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes | `development` | `development`, `test`, or `production`. |
| `PORT` | Yes | `4000` | Express API port (`0.0.0.0`). |
| `CLIENT_URL` | Yes | `http://localhost:5173` | Frontend origin for links and CORS. |
| `CORS_ORIGINS` | Yes | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed browser origins. |
| `MONGODB_URI` | Yes | `mongodb://127.0.0.1:27017/clipforge_ai` | MongoDB connection string (MongoDB Community or Atlas). |
| `ENABLE_EMBEDDED_MONGO_FALLBACK` | No | `true` (dev only) | Starts local persistent wire-protocol MongoDB fallback if `mongod` is offline in dev. Ignored in `production`. |
| `JWT_ACCESS_SECRET` | Yes | *(dev default)* | Secret key (min 16 chars) for HTTP-only session JWTs. |
| `JWT_ACCESS_EXPIRES_IN` | No | `7d` | Session JWT lifetime. |
| `DOWNLOAD_SIGNING_SECRET` | Yes | *(dev default)* | HMAC secret for signed clip stream/download/ZIP tokens. |
| `ADMIN_BOOTSTRAP_EMAIL` | No | `admin@clipforge.local` | Initial seeded admin email. |
| `ADMIN_BOOTSTRAP_PASSWORD` | No | `Admin@ClipForge2026!` | Initial seeded admin password. |
| `REDIS_URL` | No | *(empty)* | Redis URI (`redis://127.0.0.1:6379`) for BullMQ; uses persistent `local_worker` if empty. |
| `STORAGE_PROVIDER` | No | `local` | `local` or `s3` (AWS S3 / Cloudflare R2 / MinIO). |
| `LOCAL_STORAGE_DIR` | No | `./server/storage` | Directory for local source videos, rendered clips, and thumbnails. |
| `TEMP_WORKING_DIR` | No | `./server/temp` | Scratch directory for Multer uploads and per-job FFmpeg rendering. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | If `s3` | *(empty)* | S3-compatible object storage credentials. |
| `PYTHON_BIN` | No | *(auto-detected `.venv`)* | Path to Python interpreter with `processor/requirements.txt` installed. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | No | *(auto-detected)* | Explicit binary paths; auto-resolves bundled `@ffmpeg-installer` / `@ffprobe-installer` if omitted. |
| `WHISPER_MODEL_SIZE` | No | `tiny.en` | Faster-Whisper model size (`tiny.en`, `base`, `small`, `medium`, `large-v3`). |
| `WHISPER_MODEL_PATH` | No | *(empty)* | Optional path to pre-downloaded CTranslate2 Faster-Whisper model folder for air-gapped hosts. |
| `AI_PROVIDER` | No | `gemini` | `gemini`, `openai_compatible`, or `none`. |
| `GEMINI_API_KEY` | Optional | *(empty)* | Google AI Studio API key. Marked `NOT CONFIGURED` if omitted. |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Gemini model ID for social copy generation. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Optional | *(empty)* | Razorpay INR API keys. Marked `NOT CONFIGURED` if omitted. |
| `RAZORPAY_WEBHOOK_SECRET` | Optional | *(empty)* | Razorpay webhook signing secret for `/api/v1/payments/webhook`. |
| `PAYMENT_SANDBOX_SIMULATOR` | No | `true` (dev only) | Enables labelled dev sandbox payment simulator in non-production when live Razorpay keys are absent. |
