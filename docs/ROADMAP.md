# Product Roadmap — Madam Afaf (مدام عفاف)

This roadmap records planned future initiatives. **Items in this document are strictly for future iterations and must NOT be built during current alpha phases.**

## Future Milestones (Post-Alpha / Post-Beta)

### 1. Notifications & Recurring Health Tracking
- Optional email notification when periodic health monitoring detects a critical regression.
- Monthly or bi-weekly automated sample audit for registered domain owners.

### 2. User Accounts & Identity Claims
- Anonymous-to-authenticated conversion: Seamlessly migrate anonymous `visitorIdHash` records to a verified user profile upon sign-in.
- Firebase Auth ID-token verification on the server without full Admin SDK footprint.
- Server-to-server API endpoints for agency dashboards and external integrations.

### 3. Requirements-vs-Delivery Review
- Structured specification input allowing site owners to paste their freelancer/agency scope contract and verify whether requested pages and features were delivered.

### 4. Knowledge Hub & AI Builder Expansion
- Expansion of builder-specific verified publish and configuration guidance for candidate platforms (Replit, Base44, Bolt, v0, Emergent, AI Studio).
- Dedicated per-tool optimization recommendations based on empirical testing.

### 5. Real-Browser Interactive Scans
- Headless browser rendering tier (Playwright/Puppeteer cluster) to enable full layout shift, dynamic JavaScript rendering, and visual regression testing for SPAs.

### 6. Deep Security Audit for Verified Domains
- DNS-TXT or meta-tag verification allowing domain owners to unlock deeper security testing (passive TLS cipher suite verification, comprehensive sub-resource integrity checks).
