# Release Strategy & Criteria — Madam Afaf (مدام عفاف)

This document defines the release lifecycle and progression criteria from Alpha to Beta and from Beta to v1.0.

## 1. Current Stage: Alpha (v0.1.0-alpha.1)
- **Status:** Closed technical preview.
- **Audience:** Core developers and invited technical reviewers.
- **Storage Mode:** FileStore (non-durable fallback with clear notice) until durable Firebase credentials are authenticated.
- **Features Active:** Core scanning engine (static HTML, HTTP headers, PSI calibrated, AI builder registry, re-scan comparison loop, rating card, read-only admin).

---

## 2. Alpha → Beta Transition Criteria
To transition from Alpha to Beta, all of the following requirements must be verified:

1. **Durable Persistence in Production:**
   - Durable store (Firestore authenticated probe) verified in production with zero transaction deadlocks.
2. **Security & Protocol Hardening:**
   - Security headers, SSRF protections, and `X-Visitor-Id` CSRF mitigation verified in staging/production environment.
3. **Accuracy & Real-Site Audits:**
   - At least 20 sites scanned with their owners' explicit consent and evaluated side-by-side with an independent human review.
   - Gold set evaluation demonstrating ≥90% measured precision.
   - Per-rule precision displays gated by minimum sample size (n ≥ 10 votes).
4. **Fix Prompt Effectiveness:**
   - At least 10 consenting sites where the generated AI prompt was applied, the site re-scanned, and results recorded as resolved, regressed, or not applicable.
5. **Beta Cohort:**
   - 20–50 invited beta users actively using the application and submitting feedback.

---

## 3. Beta → 1.0 Production Criteria
1. **Reliability & Availability:**
   - 99.5% service uptime over 30 consecutive days.
   - Graceful quota exhaustion and concurrency queue management under peak loads.
2. **Security & Zero Regressions:**
   - Independent security audit with zero critical/high vulnerabilities.
   - Automated CI testing covering all core invariants and regression suites.
3. **Legal Compliance:**
   - Final review and sign-off on Terms of Service and Privacy Policy by certified legal counsel.
