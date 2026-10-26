# Roles & Endpoint Permissions (`docs/PERMISSIONS.md`)

This document defines the actors/roles in **Madam Afaf** and the exact authorization rules enforced per HTTP endpoint in `server.ts` and `src/lib/storage.ts`.

---

## 1. Roles

| Role | Identity Mechanism | Scope |
| :--- | :--- | :--- |
| **Anonymous Visitor (Owner)** | `X-Visitor-Id` header (required on all `POST`/`DELETE`/`PUT`/`PATCH` requests for CSRF defense) + `madam_visitor` `HttpOnly; SameSite=Lax` cookie, hashed server-side via `HMAC-SHA256(VISITOR_ID_SALT, visitorId)` | Can create scans within their 10-hour domain lock, view/cancel/delete their own scans, create/revoke share links for their own completed reports, submit feedback on their own scans, and use chat/voice within rate limits. |
| **Anonymous Visitor (Other / Foreign)** | Valid `X-Visitor-Id` belonging to a different visitor (`ownerVisitorHash !== callerVisitorHash`) | Cannot read, cancel, delete, share, revoke, or submit scan-bound feedback on another visitor's scan. Receives `HTTP 404` identical to an unknown ID. |
| **No Identity / Cookie-Only Mutating Request** | Missing `X-Visitor-Id` on state-changing routes, or missing both header and cookie on `GET` routes | State-changing routes (`POST`/`DELETE`/`PUT`) return `HTTP 403` (`csrf_missing_header`). `GET` routes on private resources return `HTTP 404`. |
| **Share Viewer** | Possesses capability token in `GET /api/shared/:token` (`>= 16` base64url chars, matched via `SHA-256(token)`) | Read-only access to the sanitized `SharedReportDTO` until the link expires or is revoked by the owner. Cannot mutate, delete, or re-share the report, and cannot submit scan-bound feedback using the owner's `scanId`. |
| **Maintainer (CLI Only)** | Local shell / server environment access (no web admin endpoints exist) | Runs `npm run config:check`, `npm run gold:export`, `npm test`, and configures environment variables (`FREE_SCANS_HARD_DISABLED`, API keys). |
| **Future Registered User** | Reserved in `VisitorIdentity { visitorId: string; email?: string }` (`src/lib/storage.ts`) | Deferred past v1 Alpha; will bind `email` to `VisitorIdentity` on the server without changing endpoint ownership invariants. |

---

## 2. Endpoint Access-Control Matrix

Legend:
- **Allow (`200`)**: Authorized and processed.
- **Deny (`403`)**: Rejected by CSRF middleware when `X-Visitor-Id` header is missing on a state-changing request.
- **Hide (`404`)**: Rejected without revealing whether the resource ID exists.
- **Gone (`410`)**: Resource existed and belonged to the caller (or valid share token), but was deleted, expired, or revoked.

| Endpoint | Method | Owner (`X-Visitor-Id`) | Other Visitor (`X-Visitor-Id`) | Cookie-Only (No `X-Visitor-Id`) | No Identity | Expired / Deleted / Revoked | Share Viewer |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/health` | `GET` | Allow (`200`) | Allow (`200`) | Allow (`200`) | Allow (`200`) | N/A | Allow (`200`) |
| `/api/capabilities` | `GET` | Allow (`200`) | Allow (`200`) | Allow (`200`) | Allow (`200`) | N/A | Allow (`200`) |
| `/api/quota` | `GET` | Allow (`200`, own quota) | Allow (`200`, own quota) | Allow (`200`, cookie quota) | Allow (`200`, fresh visitor) | N/A | Allow (`200`, own quota) |
| `/api/scans` | `POST` | Allow (`200`, creates scan) | Allow (`200`, creates own scan) | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | N/A | **Deny (`403` without header)** |
| `/api/scans/:id` | `GET` | Allow (`200`) | **Hide (`404`)** | Allow (`200` if owner cookie) | **Hide (`404`)** | **Gone (`410`)** for Owner; **Hide (`404`)** for Other | **Hide (`404`)** |
| `/api/scans/:id/cancel` | `POST` | Allow (`200`) | **Hide (`404`)** | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | **Gone (`410`)** for Owner; **Hide (`404`)** for Other | **Hide (`404`)** |
| `/api/scans/:id` | `DELETE` | Allow (`200`, creates tombstone) | **Hide (`404`)** | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | **Gone (`410`)** for Owner; **Hide (`404`)** for Other | **Hide (`404`)** |
| `/api/scans/:id/share` | `POST` | Allow (`200`, returns token) | **Hide (`404`)** | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | **Gone (`410`)** for Owner; **Hide (`404`)** for Other | **Hide (`404`)** |
| `/api/scans/:id/share` | `DELETE` | Allow (`200`, revokes token) | **Hide (`404`)** | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | **Gone (`410`)** for Owner; **Hide (`404`)** for Other | **Hide (`404`)** |
| `/api/shared/:token` | `GET` | Allow (`200` DTO) | Allow (`200` DTO) | Allow (`200` DTO) | Allow (`200` DTO) | **Gone (`410`)** if revoked/expired; **Hide (`404`)** if unknown | Allow (`200` DTO) |
| `/api/feedback` | `POST` | Allow (`200` for own `scanId`) | **Hide (`404`)** for foreign `scanId` | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | **Gone (`410`)** for Owner; **Hide (`404`)** for Other | **Hide (`404`)** if passing owner `scanId` |
| `/api/chat`, `/api/chat-afaf` | `POST` | Allow (`200`, rate-limited) | Allow (`200`, own chat) | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | N/A | Allow (`200` with `X-Visitor-Id`) |
| `/api/tts` | `POST` | Allow (`200`/`503`) | Allow (`200`/`503`) | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | N/A | Allow (`200`/`503` with `X-Visitor-Id`) |
| `/api/transcribe` | `POST` | Allow (`200`/`503`) | Allow (`200`/`503`) | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | N/A | Allow (`200`/`503` with `X-Visitor-Id`) |
| `/api/voice/token` | `POST` | Allow (`200`, flag status) | Allow (`200`, flag status) | **Deny (`403` CSRF)** | **Deny (`403` CSRF)** | N/A | Allow (`200` with `X-Visitor-Id`) |
