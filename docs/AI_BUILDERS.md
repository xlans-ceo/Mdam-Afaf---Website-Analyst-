# AI Builders Knowledge Registry (`src/knowledge/ai-builders.ts`)

This document describes the structure, verification rules, and candidate entries of the AI Builder Knowledge Registry used by Madam Afaf to detect builder-hosted websites, tailor fix prompts, and provide accurate publish instructions.

## 1. Registry Fields (`AiBuilderEntry`)

Each entry in `AI_BUILDERS` (`src/knowledge/ai-builders.ts`) has the following fields:

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `AiBuilderId` | Yes | Stable identifier (`'lovable' \| 'replit' \| 'base44' \| 'bolt' \| 'v0' \| 'emergent' \| 'ai-studio'`). |
| `nameEn` | `string` | Yes | Display name in English (used in `Tool: <nameEn>` prompt headers). |
| `nameAr` | `string` | Yes | Display label in Egyptian Arabic UI (`انسخ البرومبت للـ <nameAr>`). |
| `hostSuffixes` | `string[]` | Yes | Verified staging/production host suffixes (for example `['lovable.app']`). Empty (`[]`) when `verified: false`. |
| `signals` | `string[]` | Yes | Secondary HTML/script markers inspected when host suffix does not match. Empty (`[]`) when `verified: false`. |
| `publishHintAr` | `string` | Optional | Verified Egyptian-Arabic instruction explaining how to publish/deploy changes in this tool so a re-scan sees the new version. |
| `headersNoteAr` | `string` | Optional | Tool-aware advice for HTTP security headers (avoids cPanel/Cloudflare/Vercel panel instructions on builder-hosted sites). |
| `source` | `string` | Required if `verified: true` | Official documentation URL confirming the host suffix and publish flow. |
| `verifiedAt` | `string` | Required if `verified: true` | ISO date (`YYYY-MM-DD`) when the official documentation and a real deployed site were verified. |
| `verified` | `boolean` | Yes | Only entries with `verified: true` may drive automatic detection claims, staging-domain notes, or tool-specific publish hints. |
| `needsReview` | `boolean` | Optional | Marks candidate tools awaiting official documentation and live-site verification. |

## 2. Verification Rule (Truthfulness Protocol)

1. **No Unverified Claims**: A `hostSuffixes` pattern, `signals` marker, or `publishHintAr` step is stated as fact **only** when backed by:
   - An official documentation URL in `source`, AND
   - A `verifiedAt` date (`YYYY-MM-DD`), AND
   - `verified: true`.
2. **Runtime Enforcement**: `detectAiBuilder()`, `isVerifiedBuilderHostedUrl()`, and `getVerifiedAiBuilderById()` filter strictly by `entry.verified === true`. Unverified entries (`verified: false`) never drive automatic platform claims or publish hints.
3. **User Override When Host Is Unknown**: When a scanned site is on a custom or unknown host (`!verifiedBuilder`), the report screen shows an optional one-line chip selector (`"اتبنى بإيه؟"`) next to the prompt button so the user can explicitly choose their tool without Madam Afaf guessing.

## 3. Verified & Candidate Tools

| Tool (`nameEn`) | `id` | Status | `hostSuffixes` | `verifiedAt` | Official `source` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Lovable** | `lovable` | `verified: true` | `lovable.app` | `2026-10-25` | `https://docs.lovable.dev/features/deploy` |
| **Replit** | `replit` | `verified: false` (`needsReview: true`) | `[]` (to verify) | — | Pending official docs & live fixture verification |
| **Base44** | `base44` | `verified: false` (`needsReview: true`) | `[]` (to verify) | — | Pending official docs & live fixture verification |
| **Bolt** | `bolt` | `verified: false` (`needsReview: true`) | `[]` (to verify) | — | Pending official docs & live fixture verification |
| **v0** | `v0` | `verified: false` (`needsReview: true`) | `[]` (to verify) | — | Pending official docs & live fixture verification |
| **Emergent** | `emergent` | `verified: false` (`needsReview: true`) | `[]` (to verify) | — | Pending official docs & live fixture verification |
| **AI Studio** | `ai-studio` | `verified: false` (`needsReview: true`) | `[]` (to verify) | — | Pending official docs & live fixture verification |
