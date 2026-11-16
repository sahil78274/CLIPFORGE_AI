# Razorpay INR Payments, Webhooks & Credit Settlement

## 1. Pricing & Credit Model

- Credit packages (`CreditPackage`) and per-minute credit consumption rates (`SystemConfig`) are **stored in MongoDB and configurable from the Admin Console** (`/admin/packages` and `/admin/config`).
- Amounts are stored as integer **INR paise** (`₹499.00` = `49900` paise) to eliminate floating-point rounding bugs.

---

## 2. Live / Test Razorpay Checkout Flow

When `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are configured in `.env`:

1. **Order Creation (`POST /api/v1/payments/create-order`)**:
   - The backend looks up the authoritative `CreditPackage` in MongoDB (never trusting client-submitted prices or credit counts).
   - Calls `https://api.razorpay.com/v1/orders` with Basic Auth and persists a `Payment` record (`status: 'created'`, `isDevelopmentMode: false`).
2. **Checkout Modal**:
   - Frontend loads `https://checkout.razorpay.com/v1/checkout.js` and opens Razorpay Checkout for the server-created `orderId`.
3. **Server-Side Signature Verification (`POST /api/v1/payments/verify`)**:
   - Computes `HMAC_SHA256(razorpayOrderId + "|" + razorpayPaymentId, RAZORPAY_KEY_SECRET)` and compares in constant time (`crypto.timingSafeEqual` after strict hex validation).
   - Marks `Payment` `verified` and calls `grantPurchasedCredits` with deterministic `idempotencyKey = payment:grant:<paymentId>`.

---

## 3. Idempotent Webhook Processing (`POST /api/v1/payments/webhook`)

1. `server/src/app.ts` captures exact unparsed request bytes into `req.rawBody`.
2. `processRazorpayWebhook` verifies `X-Razorpay-Signature` over `req.rawBody` using `RAZORPAY_WEBHOOK_SECRET`.
3. Deduplicates replays by atomically pushing `X-Razorpay-Event-Id` (or SHA-256 payload digest) via `Payment.findOneAndUpdate({ _id, webhookEventIds: { $ne: eventId } }, { $push: { webhookEventIds: eventId } })`.
4. Even if both client `/verify` and asynchronous `payment.captured` webhook arrive concurrently, `CreditTransaction` enforces unique `idempotencyKey = payment:grant:<paymentId>`, guaranteeing **at-most-once credit minting**.
5. On `refund.processed` (or Admin Console refund), `reverseRefundedCredits` records an immutable `refund` ledger entry and deducts refundable credits.

---

## 4. Development Sandbox Simulator (`NOT CONFIGURED` Fallback)

- When `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are omitted in local development (`NODE_ENV !== 'production'` and `PAYMENT_SANDBOX_SIMULATOR=true`), the Credit Wallet page clearly displays a **`RAZORPAY LIVE KEYS NOT CONFIGURED — DEV SANDBOX`** badge.
- Sandbox orders use `provider: 'razorpay_sandbox_dev'`, `isDevelopmentMode: true`, and still pass through full HMAC-SHA256 signature verification using `PAYMENT_SANDBOX_SECRET`.
- **Strict Accounting Separation**: Admin analytics (`GET /api/v1/admin/overview`) explicitly separate `liveRevenuePaise` (`isDevelopmentMode: false`) from `sandboxVolumePaise` (`isDevelopmentMode: true`) so simulated test transactions are never treated as real live revenue.
