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
