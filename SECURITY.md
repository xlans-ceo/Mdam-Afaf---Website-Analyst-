# Security Policy — Madam Afaf (مدام عفاف)

## 1. Reporting Security Vulnerabilities
If you discover a security vulnerability in Madam Afaf, please report it directly and confidentially to the maintainer via LinkedIn:

- **LinkedIn Contact:** [Mohamad Sultan (mo7amadsultan)](https://www.linkedin.com/in/mo7amadsultan/)

Please do **not** open public issues or PRs for security vulnerabilities until they have been reviewed and addressed.

## 2. Security Guardrails & Invariants
- **SSRF Prevention:** Server-side fetch blocks private, loopback, link-local, and cloud metadata IP ranges (re-validated after DNS resolution and on every redirect).
- **Safe-Fetch Only:** The server does not execute untrusted JavaScript. All fetched markup and user inputs are strictly treated as untrusted data.
- **CSRF & Header Protection:** Safe methods (GET, HEAD) are read-only. Unsafe methods require the `X-Visitor-Id` header; cross-origin requests cannot forge this header without explicit preflight permissions.
- **Secrets Management:** Secrets are strictly server-side environment variables. No secrets are ever sent to client bundles, logged in traces, or saved in public reports.
- **Report & Data Privacy:** Scan reports are accessible only via unguessable 128-bit identifiers and visitor ownership checks, with user deletion controls.
- **Data Retention:** Raw reports and user feedback text are retained for 30 days maximum. Anonymized performance and feedback aggregates are retained for up to 12 months.
