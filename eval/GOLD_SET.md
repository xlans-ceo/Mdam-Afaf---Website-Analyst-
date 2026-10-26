# Madam Afaf — Gold Set Evaluation Template (`eval/GOLD_SET.md`)

Purpose: Track measured rule precision across a hand-labeled set of real Arabic and English websites (target: ≥ 90% confirmed precision per rule; rules below 90% are downgraded to `suspected` or disabled).

> **Note:** Only record findings that were manually inspected by a human developer on the live URL. Never invent statistics or pre-fill unverified pass/fail counts. The agent never labels gold set entries. Precision figures require `n = (TP + FP) >= 10`.

## 1. Gold Set Sites

| # | URL | Site Type | Platform | Date Inspected | Expected Findings (`ruleId`) | True Positives (TP) | False Positives (FP) | False Negatives (FN) | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `https://elabyad-eg.com/` | `b2b_manufacturer` | `wordpress_elementor` | _Human to fill_ | _Human to fill_ | _Human to fill_ | _Human to fill_ | _Human to fill_ | Fixture target site |
| 2 | _Developer to fill_ | | | | | | | | |
| 3 | _Developer to fill_ | | | | | | | | |
| 4 | _Developer to fill_ | | | | | | | | |
| 5 | _Developer to fill_ | | | | | | | | |

## 2. Per-Rule Precision Ledger

Formula: `Precision = TP / (TP + FP)` (Calculated only when `TP + FP >= 10` across the gold set + 👍/👎 feedback store).
Rules below 90% measured precision are downgraded to `suspected` or disabled.

| Rule ID | Category | Confidence | TP | FP | Precision | Action (`keep` / `downgrade_to_suspected` / `disable`) |
|---|---|---|---|---|---|---|
| `R013` | `performance` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `R011` | `accessibility` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `R010` | `security` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RC005` | `content` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RC001` | `content` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RC004` | `seo` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `R009` | `seo` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `R003_SOCIAL` | `links` | `likely` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RC002` | `content` | `likely` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RC007` | `content` | `likely` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RC008` | `content` | `likely` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RX001` | `links` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `RX002` | `links` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `R013_PERF_GROUPED` | `performance` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
| `SPA_H1_RECONCILED_INFO` | `seo` | `confirmed` | — | — | NOT MEASURED YET (n < 10) | `keep` |
