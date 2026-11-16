# Google Drive Import — Setup, Security, and Local Workflow

ClipForge AI can import a video **directly from the user's own Google Drive**, clip it with
the existing FFmpeg + Faster-Whisper pipeline, and show progress and downloads in the same
UI as direct uploads. Nothing about the existing upload, wallet, auth, dashboard, or admin
paths changes.

---

## 1. What the user sees

`/dashboard/create` → **Video Source** now has four tabs; the required two are:

| Option | Behaviour |
| --- | --- |
| **A. Direct Upload** | Unchanged: pick a local file, upload, generate. |
| **B. Import from Google Drive** | Connect Google Drive → Select Video from Drive (official Picker) → review file info → Generate Clips → live progress → clips + downloads. |

The Drive tab renders inside the same page, so progress, clip previews, and download
buttons (including bulk ZIP) are the existing components.

---

## 2. Google Cloud Console configuration (exact steps)

1. <https://console.cloud.google.com> → create or select a project. Note the **Project number**
   (IAM & Admin → Settings) → this is `GOOGLE_PROJECT_NUMBER`.
2. **APIs & Services → Library** → enable:
   - **Google Drive API**
   - **Google Picker API**
3. **APIs & Services → OAuth consent screen**
   - User type: **External** (or Internal for a Workspace org).
   - Add scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
     **`https://www.googleapis.com/auth/drive.file`**. Do **not** add `drive.readonly` or
     `drive` for this feature.
   - While in *Testing*, add each Gmail account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - **Authorized JavaScript origins:** `http://localhost:5173` (and your production origin).
   - **Authorized redirect URIs:** the exact value of `GOOGLE_REDIRECT_URI`:
     - Local: `http://localhost:4000/api/v1/google-drive/oauth/callback`
     - Production: `https://YOUR_API_HOST/api/v1/google-drive/oauth/callback`
   - Copy the client ID → `GOOGLE_CLIENT_ID`, client secret → `GOOGLE_CLIENT_SECRET`.
5. **APIs & Services → Credentials → Create credentials → API key**
   - Restrict key: **Application restrictions → HTTP referrers** →
     `http://localhost:5173/*`, `http://127.0.0.1:5173/*`, and your production origin.
   - **API restrictions → Restrict key → Google Picker API** (Drive API optional).
   - Copy → `GOOGLE_API_KEY`. This key is browser-visible **by design**; the OAuth client
     secret never is.
6. Generate `GOOGLE_TOKEN_ENCRYPTION_KEY` (>= 32 random chars):
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

### 2.1 Environment variables (exact names)

```dotenv
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:4000/api/v1/google-drive/oauth/callback
GOOGLE_API_KEY=AIza...
GOOGLE_PROJECT_NUMBER=123456789012
GOOGLE_TOKEN_ENCRYPTION_KEY=<32+ random chars>
# optional tuning
GOOGLE_DRIVE_MAX_FILE_BYTES=21474836480
GOOGLE_DRIVE_DOWNLOAD_CHUNK_BYTES=8388608
GOOGLE_DRIVE_SELECTION_TTL_SEC=21600
```

**Callback URL actually mounted by the backend** (verified by the integration suite):

```
GET http://localhost:4000/api/v1/google-drive/oauth/callback
```

`GET http://localhost:4000/api/v1/youtube/oauth/google/callback` remains mounted as a
compatibility alias and now dispatches Drive states to the Drive service and legacy
YouTube states to the existing YouTube controller, so either URI can be registered in
Google Cloud Console without breaking the other flow.

### 2.2 Backend endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/google-drive/config` | public | Picker API key / project number / client ID / scopes / limits |
| POST | `/api/v1/google-drive/oauth/authorize` | JWT | Returns Google consent URL |
| GET | `/api/v1/google-drive/oauth/callback` | public (state) | Code exchange, encrypted refresh token upsert |
| GET | `/api/v1/google-drive/status` | JWT | Connection status (no secrets) |
| POST | `/api/v1/google-drive/oauth/disconnect` | JWT | Revoke at Google + delete credentials/selections |
| GET | `/api/v1/google-drive/picker-token` | JWT | Short-lived access token for the Picker widget only |
| POST | `/api/v1/google-drive/files/select` | JWT | Re-verify a Picker file ID with the user's own token |
| GET | `/api/v1/google-drive/selections/:id` | JWT | Verified selection metadata (user-bound) |
| GET | `/api/v1/google-drive/selections/:id/thumbnail` | JWT | Same-origin thumbnail proxy |
| POST | `/api/v1/google-drive/generate` | JWT | Reserve credits, create project + job, enqueue |

Rate limits: `googleOAuthLimiter` (20 / 15 min / IP) on authorize·callback·disconnect,
`googleDriveApiLimiter` (120 / 15 min / IP) on config·status·picker-token·select·selection·
thumbnail, and the existing `uploadAndJobLimiter` on `/generate`.

---

## 3. Security model

- **Minimum scope.** Only `https://www.googleapis.com/auth/drive.file` (+ `openid email profile`).
  `include_granted_scopes` is deliberately **not** sent, so consent never widens silently.
- **State.** `state` is `base64url(payload).HMAC-SHA256` signed with `JWT_ACCESS_SECRET`
  (domain-separated) and carries a 32-byte nonce whose SHA-256 hash is stored in
  `GoogleDriveOAuthState`. The callback atomically consumes the record
  (`findOneAndDelete`), so replay/CSRF/login-CSRF attempts fail with
  `GOOGLE_DRIVE_INVALID_STATE` / `GOOGLE_DRIVE_STATE_EXPIRED`.
- **Tokens.** The refresh token is AES-256-GCM encrypted (`v1:iv:tag:data`) with
  `GOOGLE_TOKEN_ENCRYPTION_KEY` before being written to `usergoogledriveconnections`.
  **Access tokens are never persisted** — they live only in a bounded in-process cache
  (≤ 5 min) and are refreshed from the encrypted refresh token on demand; a rotated refresh
  token is re-encrypted. No client secret, refresh token, or access token is ever returned
  to the browser (`/picker-token` returns a short token used only by Google's Picker, with
  `Cache-Control: no-store`).
- **Selections.** The client only ever sends the Picker's file ID. The backend independently
  fetches `files.get` with *that user's* bearer token, requires an exact ID match, rejects
  trashed / non-video / non-downloadable / oversized / overlong items, then stores an
  opaque `GoogleDriveFileSelection` bound to the user with a TTL. Jobs reference only that
  `selectionId`. Reads are scoped by `userId`, so another user gets an identical
  404. Expired selections return `GOOGLE_DRIVE_SELECTION_EXPIRED`.
- **Downloads.** `files.get?alt=media` with HTTP `Range` chunks written straight to
  `*.part` on disk (constant RAM), manual redirect following with a strict Google host
  allowlist (no SSRF, bearer token never sent to an unlisted host), resume metadata keyed by
  file id + modified time + etag, exponential backoff for 408/425/429/5xx, byte-count +
  Drive checksum (SHA-256 preferred, else MD5) + FFprobe integrity validation.
- **Revocation.** Google `invalid_grant`/401 marks the connection `revoked` and clears the
  encrypted secret; the UI shows "Reconnect". Disconnect additionally calls Google's revoke
  endpoint and deletes connection, selections, and pending states.
- **Temp cleanup.** The worker deletes the whole per-job temp directory in a `finally`
  block, covering `.part` downloads, `job_input.json`, and rendered outputs.

---

## 4. Long videos (up to 10 hours)

Unchanged, already-existing infrastructure is reused:
`MAX_VIDEO_DURATION_SEC=36000`, `VIDEO_CHUNK_DURATION_SEC=600`, `VIDEO_CHUNK_OVERLAP_SEC=5`.
Chunk plans come from the same builder used by uploads/YouTube, timestamps stay global,
overlap windows are de-duplicated at boundaries, `CF_CHECKPOINT:` lines persist atomic
chunk checkpoints, and interrupted jobs auto-resume (max 3 attempts) without double-charging.
A `>10h` file is rejected *before* download when Drive metadata reports duration, and always
after FFprobe validation (`VIDEO_DURATION_LIMIT_EXCEEDED`).

---

## 5. Local workflow (end to end)

```bash
# 0. prerequisites
cp .env.example .env          # fill the six Google vars from section 2
npm install
python3 -m venv .venv && .venv/bin/pip install -r processor/requirements.txt

# 1. run the stack
npm run dev:server            # http://localhost:4000  (also serves the worker in local mode)
npm run dev:client            # http://localhost:5173

# 2. in the browser
#    sign in → /dashboard/create → "Import from Google Drive"
#    Connect Google Drive  → Google consent (drive.file only) → returns to ?tab=drive
#    Select Video from Drive → official Picker (MP4/MOV/WebM/MKV/M4V only, single selection)
#    review name / MIME / size / duration / thumbnail → Generate Clips
#    watch chunked progress → clips appear with download + bulk ZIP
```

Verify server-side without the UI:

```bash
curl -s localhost:4000/api/v1/google-drive/config | jq
# → pickerConfigured: true, apiKey present, no client secret

# then, with a browser session cookie or Bearer token:
curl -s -X POST localhost:4000/api/v1/google-drive/oauth/authorize \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"redirectPath":"/dashboard/create?tab=drive"}' | jq -r .data.authorizationUrl
```

### 5.1 Tests

```bash
npm run typecheck     # shared + server + client
npm run build
npm run test          # server integration suites (embedded MongoDB, real FFmpeg fixtures)
```

`server/src/__tests__/googleDrive.integration.test.ts` covers: configuration honesty and
secret non-exposure · tampered/invalid/expired/replayed state · OAuth cancellation ·
successful connection with encrypted refresh token and no plaintext access token ·
single-use state replay · Picker selection of MP4 **and** MOV · non-video rejection ·
403 for a file the connected account cannot read · 404 for deleted files · cross-user
selection/generate blocking · selection expiry · transparent access-token refresh from the
encrypted refresh token · full MP4 and MOV imports producing real clips · large file
streamed in multiple Range chunks with Drive checksums and transient-5xx recovery · broken
download → failure + 100 % credit refund + successful job retry · full 10-hour (36,000 s)
chunked processing with bounded RAM, global timestamps and temp cleanup · revoked
permission → `GOOGLE_DRIVE_REAUTH_REQUIRED` → disconnect → reconnect.

No mock Google credentials are used in the application: the suite points the documented
`GOOGLE_OAUTH_*` / `GOOGLE_DRIVE_API_BASE_URL` variables at a local HTTP server that
speaks the real Drive v3 and OAuth 2.0 wire formats and serves real FFmpeg-generated MP4/MOV
bytes over HTTP Range requests.
