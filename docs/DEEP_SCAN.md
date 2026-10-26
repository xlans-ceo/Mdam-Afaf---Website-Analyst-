# Madam Afaf — Deep Scan (فحص عميق) Architecture & Design

> **Status:** Scaffolding and Architecture Specification ONLY (No live calls). Feature is disabled by default behind feature flags.

---

## 1. Overview & Motivation

Madam Afaf's primary tier uses fast static HTML analysis, HTTP header audits, PageSpeed Insights (PSI), and lightweight pattern matching. However, modern single-page applications (SPAs) and complex web apps have aspects that static HTML cannot evaluate:
1. Real browser rendering (DOM after JS execution, layout shifts, mobile viewport overflows).
2. Deeper security scans on verified-ownership domains (CORS misconfiguration, passive secret scanning in loaded scripts, active token checks).

**Deep Scan** is the advanced pipeline designed to evaluate these areas *without* making false promises or guessing.

---

## 2. Core Modules

### 2.1 `BrowserChecksProvider` (Provider-Agnostic Interface)
Evaluates client-rendered DOM, computed styles, visual overlaps, and layout:
- Measures real rendered LCP element and mobile viewport overflow horizontally down to 320px.
- Passive console error detection (`window.onerror`, unhandled promise rejections).
- Provider-agnostic: can interface with Playwright / Puppeteer / Cloud browser container.

### 2.2 `SecurityDeepProvider` (Ownership-Verified Only)
Deploys extended checks ONLY when domain ownership has been proven (via DNS TXT record or `.well-known/madam-afaf.txt`):
- Cross-Origin Resource Sharing (CORS) wildcard reflection with credentials.
- Passive JS secret pattern auditor over client bundles with automatic token masking (`sk-****12`).
- Strict scope: NO intrusive attacks, SQL injections, or denial-of-service tests.

---

## 3. Verdict Model: Three-Tier Confirmation

Every finding in Deep Scan follows a strict 3-state verdict model:
1. **`confirmed`**: Direct physical evidence observed and verified in rendered DOM or HTTP stream.
2. **`needs_validation`**: Heuristic anomaly detected that requires human confirmation or ownership verification.
3. **`rejected`**: False positive filtered out during the verification pass.

---

## 4. LLM Role & Provider Separation: GLM vs Gemini

- **Gemini**: Primary provider for Egyptian-Arabic explanations, consultant chat, and report rewording.
- **GLM (Z.ai / Zhipu AI)**: Used *strictly* as a secondary independent verifier pass over redacted evidence snippets and deep technical summaries:
  - Environment variables:
    - `GLM_API_KEY`: API secret for Z.ai endpoints (empty by default).
    - `GLM_BASE_URL`: Endpoint URL (e.g. `https://open.bigmodel.cn/api/paas/v4` or regional proxy).
    - `GLM_MODEL`: Default `glm-5.3`.
  - **Rules**:
    - **OFF by default** (`GLM_ENABLED=false`).
    - Separate provider module (`src/lib/providers/glm-verifier.ts`), NEVER imported into client bundles.
    - **NEVER a fallback for Gemini**: Gemini and GLM have independent responsibilities. If Gemini is down or exhausted, fall back to deterministic template replies, NEVER to GLM.

---

## 5. Quota & Rate Limiting

- Deep Scan shares the per-(visitor, domain) quota ledger: at most 1 deep scan per visitor+domain per 10-hour lock window.
- Requires user confirmation of authorization: "أقر بأني صاحب الموقع أو معي إذن موثق بطلب الفحص العميق".

---

## 6. Verification Status (Z.ai Documentation)

- **[VERIFIED]**: GLM-4 / GLM-5 OpenAI-compatible API schemas support `chat/completions` with bearer authentication.
- **[NOT VERIFIED in this environment]**: Current live latency and regional endpoint availability for `glm-5.3` from this Cloud Run region without an active paid Z.ai key.
