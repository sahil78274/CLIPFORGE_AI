# Production Deployment Guide

## 1. Topology Overview

In production, run four isolated services (via Docker Compose, Kubernetes, or managed cloud services):

1. **Reverse Proxy / CDN (`Nginx` / `Cloudflare`)**: Terminates TLS (`HTTPS`), enforces `client_max_body_size 550M` for video uploads, serves compiled `client/dist` static assets, and proxies `/api/v1/*` to the API container.
2. **ClipForge API (`server/dist/index.js`)**: Stateless Express API instances connected to MongoDB Atlas and Redis.
3. **Dedicated Media Worker (`node server/dist/workers/runWorker.js`)**: Horizontally scalable worker containers equipped with Python 3.11, Faster-Whisper model cache, OpenCV, and FFmpeg.
4. **Managed State & Object Storage**:
   - **MongoDB Atlas** (`MONGODB_URI`, replica set enabled).
   - **Managed Redis** (`REDIS_URL` for BullMQ job distribution).
   - **AWS S3 or Cloudflare R2** (`STORAGE_PROVIDER=s3` so API and Worker nodes share media without shared local disks).

---

## 2. Docker Compose Deployment

1. Prepare production `.env`:
   ```bash
   cp .env.example .env
   ```
   Populate strong secrets (`openssl rand -hex 32`) for:
   - `JWT_ACCESS_SECRET`
   - `DOWNLOAD_SIGNING_SECRET`
   - `ADMIN_BOOTSTRAP_PASSWORD`
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - `GEMINI_API_KEY`
   - `STORAGE_PROVIDER=s3` + `S3_*` credentials
   - Set `NODE_ENV=production`, `ENABLE_EMBEDDED_MONGO_FALLBACK=false`, and `PAYMENT_SANDBOX_SIMULATOR=false`.

2. Build and launch all containers:
   ```bash
   docker compose up -d --build
   ```

3. Verify health and capabilities:
   ```bash
   curl -fsS http://localhost:4000/api/v1/health
   curl -fsS http://localhost:4000/api/v1/jobs/capabilities
   ```

---

## 3. Pre-Launch Production Checklist

- [ ] `NODE_ENV=production`
- [ ] `PAYMENT_SANDBOX_SIMULATOR=false`
- [ ] `ENABLE_EMBEDDED_MONGO_FALLBACK=false`
- [ ] `JWT_ACCESS_SECRET` and `DOWNLOAD_SIGNING_SECRET` rotated to unique 64-hex-char secrets
- [ ] Bootstrap admin password changed immediately after initial deployment
- [ ] Razorpay live webhook URL (`https://<your-domain>/api/v1/payments/webhook`) registered with events `payment.captured`, `order.paid`, `payment.failed`, and `refund.processed`
- [ ] `CORS_ORIGINS` restricted exclusively to your production HTTPS frontend domain
- [ ] Google Drive import configured: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (`https://<your-api-domain>/api/v1/google-drive/oauth/callback`, registered byte-for-byte in Google Cloud Console), `GOOGLE_API_KEY` (HTTP-referrer restricted to your frontend origin, Picker API only), `GOOGLE_PROJECT_NUMBER`, and a unique `GOOGLE_TOKEN_ENCRYPTION_KEY` (>= 32 random chars — the server refuses to boot in production without it when Google OAuth is configured)
- [ ] Google Drive API + Google Picker API enabled in the project; OAuth consent screen scopes limited to `drive.file` (+ OIDC identity)
- [ ]Faster-Whisper CTranslate2 model pre-warmed on a persistent volume (`WHISPER_MODEL_PATH`) so workers never download weights at runtime
