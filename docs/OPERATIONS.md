# Operations Runbook — Madam Afaf (مدام عفاف)

## 1. Emergency Kill Switch & Outage Management
- **Global Scanner Pause:**
  - Set `DISABLE_SCANS=true` in environment variables to immediately reject new scan starts with a polite Egyptian Arabic notice ("الدفتر تحت صيانة دورية سريعة").
  - Running scans will complete or terminate gracefully within their budget.
- **Rollback:**
  - Re-deploy previous release commit tag or container image.
  - FileStore data in `data/store.json` maintains backwards compatibility; in case of schema drift, the migration loader falls back safely.

## 2. Server Restart & Lifecycle
- `npm run start` launches the Express server in production mode.
- In-flight scans at time of SIGTERM/SIGINT are caught by shutdown handlers and marked `interrupted` or refunded.
- Cache TTLs: In-memory rate limits reset safely; persistent quotas and reports are preserved on disk or Firestore.

## 3. Secret & Key Rotation
- **`VISITOR_ID_SALT` Rotation:**
  - **Consequence:** Rotating this salt invalidates mapping of historical `visitorId` to `visitorIdHash`.
  - Visitors will receive a fresh session and quota counter; previous private reports will no longer be listed in their drawer unless migrated.
  - Rotate salt only during planned maintenance windows or if salt leakage is suspected.
- **`FIREBASE_SERVER_PASSWORD` Rotation:**
  - Update in the secret manager.
  - The Firestore client re-authenticates automatically; if authentication fails, the circuit breaker safely falls back to FileStore without dropping user requests.
- **`ADMIN_TOKEN` Rotation:**
  - Generate a new random token (`openssl rand -hex 32`).
  - Update `ADMIN_TOKEN` env var and restart server. No user data is affected.

## 4. Abuse & SSRF Handling
- **IP Rate Limiting:**
  - IP endpoints are throttled to 20 attempts per hour.
  - Requests targeting loopback, private RFC1918, RFC6598, RFC3927, or cloud metadata (`169.254.169.254`) are blocked at DNS resolution and before every redirect.
- **Domain Lock:**
  - Visitors are locked to one registrable domain for 10 hours with a maximum of 3 reviews and 10 pages per window.

## 5. Deletion & Data Privacy Requests
- Scan reports can be deleted directly by the visitor via the in-app deletion button.
- For manual removal requests sent to LinkedIn, operators locate the `scanId` and invoke `store.deleteReportForVisitor(scanId, visitorId)`.
- Reports older than 30 days are automatically removed by `cleanupExpired()`.

## 6. Monitoring & Budget Alerts
- **Gemini API:** Monitor quota in Google Cloud Console. Enable billing alert thresholds at 50%, 80%, and 100%.
- **Google PageSpeed Insights:** Default is 25,000 queries/day. If depleted, PSI calls fall back to static lab estimation.
- **Server Health:** Monitor `GET /api/health` every 60 seconds (expects 200 OK with `ok: true`).

## 7. Feature Flag Registry
- `DISABLE_SCANS`: Boolean (default `false`). Emergency kill switch.
- `ENABLE_DEMO_REPORTS`: Boolean (default `false` in production, `true` in development). Controls `/report/mock_*` demo endpoints.
- `ENABLE_GEMINI_EXPLAIN`: Boolean (default `true` when `GEMINI_API_KEY` is present).
