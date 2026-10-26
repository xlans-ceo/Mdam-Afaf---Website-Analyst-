# Security Program & Architecture (`docs/SECURITY.md`)

Target Standards:
- **OWASP Top 10:2025** (A01 Broken Access Control, A02 Security Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06 Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security Logging and Alerting Failures, A10 Mishandling of Exceptional Conditions)
- **OWASP ASVS 5.0 Level 1** (Beta target; see [`docs/ASVS_L1.md`](./ASVS_L1.md))

Related Security Documents:
- [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) — Assets, actors, and the 5 primary abuse cases
- [`docs/PERMISSIONS.md`](./PERMISSIONS.md) — Role definitions and endpoint access-control matrix
- [`docs/ASVS_L1.md`](./ASVS_L1.md) — OWASP ASVS 5.0 Level 1 compliance matrix with file and test evidence

---

## 1. Defense-in-Depth Controls

### 1.1 Cross-Site Request Forgery (CSRF — K2.2)
- Every state-changing API route (`POST`, `DELETE`, `PUT`, `PATCH` under `/api/*`) enforces the presence of a valid custom header `X-Visitor-Id` (`server.ts` CSRF middleware).
- Browser cross-site `<form>` submissions and simple requests cannot attach custom headers cross-origin without a CORS preflight, and CORS is not enabled for external origins.
- Requests that supply only `Cookie: madam_visitor=...` without `X-Visitor-Id` on state-changing routes are rejected with `HTTP 403` (`code: "csrf_missing_header"`).
- All first-party client requests route through `apiFetch()` (`src/lib/api-client.ts`), which attaches `X-Visitor-Id` automatically.

### 1.2 Access Control & Private Ownership (OWASP A01 — K2.3)
- Scan jobs and reports are bound to `ownerVisitorHash = HMAC-SHA256(VISITOR_ID_SALT, visitorId)` (`src/lib/storage.ts`).
- Raw `visitorId` values are never persisted to disk.
- Foreign visitors requesting, cancelling, deleting, sharing, revoking, or submitting feedback on another visitor's scan receive `HTTP 404` (`غير موجود`) with an identical response body to non-existent IDs, preventing existence enumeration.
- Deleted or expired reports record a tombstone (`reason: "deleted" | "expired"`, `ownerVisitorHash`) and return `HTTP 410 Gone` to the owner while still returning `HTTP 404` to foreign visitors.
- Shared links (`/api/shared/:token`) use a 192-bit random capability token stored only as a SHA-256 hash (`tokenHash`) and return a strict allowlist DTO (`SharedReportDTO`) that omits `ownerVisitorHash` and internal job metadata.

### 1.3 Server-Side Request Forgery Prevention (SSRF — Section 10)
- All outbound HTTP fetches use `safeFetchHtmlWithSsrf` (`src/lib/ssrf-validator.ts`).
- Only `http:` and `https:` schemes are permitted.
- Before every request and after every redirect hop (up to `MAX_REDIRECTS = 5`), the target hostname is resolved via DNS and every returned IPv4/IPv6 address is validated against `isPrivateOrReservedIp()` to block:
  - Loopback (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.1`)
  - Private RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
  - Link-local & cloud metadata (`169.254.0.0/16`, `fe80::/10`, `100.64.0.0/10`)
  - Unique local IPv6 (`fc00::/7`) and unspecified (`0.0.0.0`, `::`)
- TLS verification is strictly enforced (`rejectUnauthorized: true`); certificate errors are recorded as user-visible findings and never bypassed.

### 1.4 Structured Logging & Redaction (OWASP A09 — K2.5)
- Every `/api/*` request emits a structured JSON log line via `src/lib/logger.ts` containing:
  - `timestamp`, `level`, `event`, `requestId`, `method`, `route`, `status`, `durationMs`, `visitorHashPrefix` (first 12 hex chars of HMAC hash, never the raw visitor ID).
- Rate-limit rejections (`HTTP 429`) and server failures (`HTTP 5xx`) are explicitly tagged (`rate_limit_rejected`, `http_5xx`).
- All log strings and metadata objects pass through `redactLogData()` / `redactLogString()`, which strips:
  - Configured environment secrets (`GEMINI_API_KEY`, `PSI_API_KEY`, `VISITOR_ID_SALT`)
  - API key patterns (`AIza...`, `sk-...`, `AKIA...`, `ghp_...`)
  - `Cookie`, `Set-Cookie`, `Authorization: Bearer ...`, and `madam_visitor` values
  - Capability share tokens in `/api/shared/<token>` paths
  - Raw URL query strings (`?[REDACTED_QUERY]`)

### 1.5 Fail-Safe Exceptional Condition Handling (OWASP A10 — K2.6)
- External calls (`safeFetchHtmlWithSsrf`, PageSpeed Insights API, Gemini API, and storage operations) enforce explicit timeouts (`withServiceTimeout` / `AbortSignal.timeout`) and typed errors (`ExternalServiceError`).
- Route handlers are wrapped in `safeRoute()` and a global Express error handler (`server.ts`) that catches synchronous and asynchronous failures, logs a redacted `5xx` entry, and returns a clean Arabic JSON error (`HTTP 503` or `HTTP 500`) without ever exposing stack traces, file paths, or raw exception messages.

### 1.6 LLM Safety & Untrusted Input Isolation (K2.7)
- Everything fetched from scanned websites and everything typed by users is treated as **untrusted data**.
- `buildConsultantPromptPayload()` (`src/lib/ai-consultant.ts`) wraps report context in `<website_context>` and user input in `<untrusted_user_input>`, strips closing delimiter tags from untrusted input to prevent tag-escape injection, caps input lengths, redacts secret patterns before prompt construction, and sets `tools: undefined` so the model has zero agency or tool-execution capability.
- `validateChatReplyAgainstReport()` (`src/lib/madam-persona.ts`) validates every model response against the stored report and blocks fabricated scores, banned hype phrases, leaked key patterns, or prompt-injection compliance tokens.

---

## 2. Software Supply Chain Security (OWASP A03 — K2.4)

1. **Committed Lockfile**: `package-lock.json` is committed and authoritative for reproducible installs.
2. **Automated Vulnerability Auditing**: `npm audit --omit=dev` runs in CI to catch known vulnerabilities in production dependencies.
3. **Automated Dependency Updates**: Configured in [`.github/dependabot.yml`](../.github/dependabot.yml) on a weekly schedule.
4. **No Runtime `npx`**: All scripts in `package.json` invoke local binaries via `./node_modules/.bin/tsx`, `vite`, or `tsc` directly. `npx` is never used at runtime or in scripts.
5. **Untrusted Install Scripts**: Production dependencies are restricted to audited packages; untrusted postinstall scripts are prohibited.

### Direct Dependencies Inventory (`package.json`)

| Package | Category | Version Range | Purpose |
| :--- | :--- | :--- | :--- |
| `@google/genai` | Runtime | `^2.4.0` | Official Google Gen AI SDK for server-side Gemini explanations, chat, TTS, and transcription |
| `dotenv` | Runtime | `^17.2.3` | Loads server-side environment variables from `.env` in local development |
| `express` | Runtime | `^4.21.2` | HTTP API server, routing, middleware, and static bundle serving |
| `firebase` | Runtime (Server-only) | `^13.1.0` | Server-only Firebase Auth (in-memory Email/Password) & Firestore client for dedicated server user |
| `lucide-react` | Runtime (UI) | `^0.546.0` | Accessible SVG iconography for the React frontend |
| `motion` | Runtime (UI) | `^12.23.24` | UI transition helpers respecting `prefers-reduced-motion` |
| `node-html-parser` | Runtime | `^9.0.5` | Fast, non-executing static HTML DOM parser for server-side page inspection |
| `react` | Runtime (UI) | `^19.0.1` | Core UI component library |
| `react-dom` | Runtime (UI) | `^19.0.1` | DOM renderer for React |
| `tldts` | Runtime | `^7.4.19` | Public Suffix List (eTLD+1) registrable domain extraction for domain-lock enforcement |
| `zod` | Runtime | `^4.6.7` | Strict runtime schema validation for API request payloads and LLM JSON outputs |
| `@tailwindcss/vite` | Build / Dev | `^4.3.3` | Tailwind CSS v4 Vite integration |
| `@vitejs/plugin-react` | Build / Dev | `^6.1.1` | React JSX/TSX compiler plugin for Vite |
| `vite` | Build / Dev | `^8.3.0` | Frontend bundler and development middleware |
| `autoprefixer` | Dev | `^10.4.21` | CSS vendor prefixing during build |
| `esbuild` | Dev | `^0.25.0` | Fast TypeScript/JavaScript bundler used by Vite/tsx |
| `tailwindcss` | Dev | `^4.3.3` | Utility CSS framework bound to `DESIGN.md` CSS variables |
| `tsx` | Dev / Runtime Runner | `^4.21.0` | TypeScript execution engine for `server.ts` and `node:test` suites |
| `typescript` | Dev | `^7.0.2` | Static type checker (`npm run lint`) |
| `@types/express` | Dev | `^4.17.21` | TypeScript definitions for Express |
| `@types/node` | Dev | `^22.14.0` | TypeScript definitions for Node.js |
| `@types/react` | Dev | `^19.3.0` | TypeScript definitions for React |
| `@types/react-dom` | Dev | `^19.3.0` | TypeScript definitions for React DOM |

---

## 3. Secrets & Key Rotation Runbook (K2.8)

### 3.1 Configuration Verification
Run the configuration check CLI at any time to verify which environment variables are `set` or `unset` without printing secret values:
```bash
npm run config:check
```
- `check:bundle` (`npm run check:bundle`) verifies that server-only modules and secrets never appear in `dist/assets/*.js`.
- `validateVisitorIdSalt()` (`src/lib/storage.ts`) enforces that `VISITOR_ID_SALT` is at least 32 characters in `NODE_ENV=production` and refuses startup if missing or set to a placeholder.

### 3.2 Rotating `GEMINI_API_KEY`
1. Open Google AI Studio / Google Cloud Console (`APIs & Services → Credentials`).
2. Create a new API key restricted to the Generative Language API.
3. Update `GEMINI_API_KEY` in the production environment / Secret Manager.
4. Restart the application instance and verify `npm run config:check` reports `GEMINI_API_KEY | set` and `GET /api/capabilities` reports `"aiExplain": true`.
5. Delete or revoke the old API key in Google Cloud Console.

### 3.3 Rotating `PSI_API_KEY`
1. Open Google Cloud Console (`APIs & Services → Credentials`).
2. Create a new API key restricted to the **PageSpeed Insights API** (`pagespeedonline.googleapis.com`).
3. Update `PSI_API_KEY` in the production environment / Secret Manager.
4. Restart the application instance and verify `npm run config:check` reports `PSI_API_KEY | set` and `GET /api/capabilities` reports `"psi": true`.
5. Revoke the previous PageSpeed Insights API key in Google Cloud Console.

### 3.4 Rotating `VISITOR_ID_SALT`
- **Impact**: `VISITOR_ID_SALT` keys the HMAC-SHA256 hash (`ownerVisitorHash`) used for anonymous visitor ownership and active 10-hour domain locks. Rotating it invalidates ownership associations for existing anonymous sessions.
- **Steps**:
  1. Generate a new 256-bit random hex string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  2. Set `VISITOR_ID_SALT` in the server environment.
  3. Restart the server during a low-traffic window.
