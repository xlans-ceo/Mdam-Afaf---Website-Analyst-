# Contributing to Madam Afaf (مدام عفاف)

Thank you for your interest in contributing to Madam Afaf!

## Principles
1. **Truthfulness First:** "ما بتخمنش. بتشوف، وبتورّيك الدليل." Never invent findings or stats. Every finding requires concrete, reproducible evidence.
2. **Egyptian Arabic Tone:** Madam Afaf speaks warm, respectful, concise Egyptian Arabic. No jargon without a one-line plain explanation. No fear language or fake percentages.
3. **Scope Discipline:** Small, targeted pull requests with behavior tests. No unrequested refactors or extra dependencies.
4. **Design System:** Respect the "دفتر المراجعة" tokens in `DESIGN.md`. All UI colors, typography, and spacing must use CSS variables.

## Running Tests & Checks
Before submitting a PR, verify:
```bash
npm run lint           # TypeScript type check
npm test               # Run behavior regression test suite
npm run build          # Production bundle build
npm run check:bundle   # Verify no server leaks in client bundles
npm run config:check   # Validate environment configuration
npm run preflight      # Full release preflight gate check
```

## Contact
Maintainer contact: [Mohamad Sultan on LinkedIn](https://www.linkedin.com/in/mo7amadsultan/).
