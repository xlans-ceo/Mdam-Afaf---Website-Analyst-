# Changelog — Madam Afaf (مدام عفاف)

All notable changes to this project are documented in this file.

## [0.1.0-alpha.1] - 2026-10-26 (Alpha Rebase)

### Added
- **BATCH B1: Stabilize, Calibrate, Declutter**
  - Calibrated PageSpeed Insights cache key: `url + strategy + deploymentFingerprint`, with re-scan bypass and human labels ("قياس جديد" vs "من الكاش").
  - Calibrated lab-only performance bands (LCP, CLS, TBT) where recommendations do not degrade overall site verdict.
  - Contextual market claim checking (RC009) excluding portfolio, blog, and case study paths.
  - AI builder registry (`src/knowledge/ai-builders.ts`) with verified Lovable integration, builder staging domain detection, and tailored fix instructions.
  - Non-distracting landing screen decluttering with clean single-column presentation.
- **BATCH B2: Calm UI & Apple-inspired Navigation**
  - Re-designed centered landing layout with clean 4-step workflow indicator and optional scope toggles.
  - Floating and responsive navigation dock (`MadamAfafDock.tsx`) with smooth magnification, spring bounce, scroll snap, and full keyboard roving tabindex.
  - Status dots ("شغّال", "خلص", "فشل") with text and icon indicators.
  - Streamlined single-column report screen with tabs for confirmed, verification-needed, passed, and not-measured items.
- **BATCH B3: The Re-Scan Loop**
  - Progressive review numbers (`مراجعة رقم N`) per (visitor, domain) with up to 3 reviews per 10-hour lock window.
  - Re-scan modes: "نفس الصفحات تاني" (zero additional page cost) and "باقي الصفحات" (discovers next unscanned pages).
  - Deterministic deployment fingerprinting based on normalized root HTML and asset hashes.
  - Pre-flight publish check preventing duplicate scans when no changes were deployed.
  - Side-by-side comparison block ("اتحل ✔ N / لسه N / جديد N") and before-and-after performance metrics delta.
  - AI-builder fix prompt generator customized by detected platform.
- **BATCH B4: Legal, Feedback, Release & Smoke**
  - Dedicated `/privacy` and `/terms` pages with Egyptian Arabic text, legal draft disclaimers, 30-day retention policies, and sample audit scope limitations.
  - In-report rating card (1–5 stars, low/high reason chips, feedback text redaction, and finding 👎 reason chips).
  - Persistent feedback storage with rate limiting, distinct-visitor negative vote flagging, and privacy-preserving storage.
  - Read-only admin interface (`/admin` and `GET /api/admin/feedback`) protected by Bearer `ADMIN_TOKEN` with constant-time equality check (`crypto.timingSafeEqual`) and `noindex` header.
  - Operational scripts: `npm run feedback:report`, `npm run preflight`, and `npm run smoke`.
  - Comprehensive operational documentation: `docs/RELEASES.md`, `docs/OPERATIONS.md`, `docs/ROADMAP.md`.
