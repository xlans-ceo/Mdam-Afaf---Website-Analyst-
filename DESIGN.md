# DESIGN.md — Madam Afaf (مدام عفاف)

## Concept: "دفتر المراجعة" (The Review Ledger)
Warm paper (`#FAF5EC`), dark ink (`#231C16`), a red pen for corrections (`#8E1B12`), and deep teal for trust (`#0B5D5E`). Calm, organized, human, light theme only in v1.

## Locked CSS Variables (Single Source of Truth in `src/index.css`)
- `--bg`: `#FAF5EC`
- `--surface`: `#FFFFFF`
- `--surface-alt`: `#F1E9DB`
- `--ink`: `#231C16` (WCAG contrast vs `--bg`: **15.5:1**)
- `--ink-muted`: `#5E5348` (WCAG contrast vs `--bg`: **6.9:1**)
- `--border`: `#DDD2C0`
- `--border-strong`: `#8C7F6F` (WCAG contrast vs `--bg`: **3.6:1**)
- `--primary`: `#0B5D5E` (WCAG contrast vs `--bg`: **7.1:1**; `--on-primary` `#FFFFFF` vs `--primary`: **7.7:1**)
- `--primary-hover`: `#084647`
- `--on-primary`: `#FFFFFF`
- `--pen`: `#8E1B12`
- Severity tokens (always paired with icon + Arabic label, never color alone):
  - Critical: `--sev-critical-bg: #FDE8E6`, `--sev-critical-fg: #8E1B12` (contrast **7.2:1**)
  - High: `--sev-high-bg: #FDEDE6`, `--sev-high-fg: #A8321A` (contrast **5.8:1**)
  - Medium: `--sev-medium-bg: #FFF1D0`, `--sev-medium-fg: #7A4F00` (contrast **6.4:1**)
  - Low: `--sev-low-bg: #E6EEF8`, `--sev-low-fg: #1D4E89` (contrast **6.8:1**)
  - Pass: `--pass-bg: #E4F3E8`, `--pass-fg: #1F6B3A` (contrast **5.7:1**)
- `--sticky-offset`: `3rem` — Sticky top offset for primary section/category accordion headers below the sticky app header and report mini-bar (J2.1).
- `--sticky-offset-2`: `6rem` — Sticky top offset for nested finding headers inside open category accordions (J2.1).


## Typography & RTL Rules
- Primary Font: `IBM Plex Sans Arabic` (400 / 500 / 700, `font-display: swap`).
- Monospace Font: `ui-monospace, 'SF Mono', Consolas, monospace` for `EvidenceBlock` and URLs.
- Scale: `14px / 16px / 18px / 20px / 24px / 30px / 36px` (`12px` only for chips & meta). Body text never below `16px` on mobile.
- Line-height: `1.7` body, `1.35` headings. Zero `letter-spacing` and zero italics on Arabic text to prevent broken Arabic glyph ligatures.
- Isolation: All URLs, numbers, rule IDs, and Latin terms inside Arabic sentences use `<bdi dir="ltr">`.
