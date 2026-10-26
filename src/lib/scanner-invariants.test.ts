import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  LiveProvider,
  MockProvider,
  classifySubpageHttpStatus,
  mergeMultiPageFindings,
  scanPublicSpaJsForSecrets
} from './providers/index';
import { detectSiteStatus } from './site-status';
import {
  discoverSitePages,
  isDisallowedByRobots,
  isEligibleInternalUrl,
  parseRobotsTxt
} from './page-discovery';
import { buildSiteProfile } from './site-profiler';
import {
  computeVerdict,
  evaluateAiClaims,
  runHonestChecks
} from './honest-checks';
import { normalizeAndCapFindings, normalizeFinding } from './normalize-finding';
import { isRestrictedIp, safeFetchHtmlWithSsrf } from './ssrf-validator';
import { Finding } from '../types/contract';

test('PHASE H3: Scanner Invariants & Deep Reliability Suite', async (t) => {
  // =========================================================================
  // 1. SSRF & Network Invariants
  // =========================================================================
  await t.test('H3.1: SSRF blocklist strictly rejects private, loopback, link-local, and cloud metadata', () => {
    // IPv4 private/reserved
    assert.strictEqual(isRestrictedIp('127.0.0.1'), true);
    assert.strictEqual(isRestrictedIp('127.0.0.2'), true);
    assert.strictEqual(isRestrictedIp('10.0.0.1'), true);
    assert.strictEqual(isRestrictedIp('172.16.0.1'), true);
    assert.strictEqual(isRestrictedIp('172.31.255.255'), true);
    assert.strictEqual(isRestrictedIp('192.168.1.1'), true);
    assert.strictEqual(isRestrictedIp('169.254.169.254'), true); // AWS/GCP metadata
    assert.strictEqual(isRestrictedIp('0.0.0.0'), true);
    assert.strictEqual(isRestrictedIp('203.0.113.1'), true); // RFC 5737 doc range

    // IPv6 private/reserved
    assert.strictEqual(isRestrictedIp('::1'), true);
    assert.strictEqual(isRestrictedIp('::'), true);
    assert.strictEqual(isRestrictedIp('fc00::1'), true);
    assert.strictEqual(isRestrictedIp('fe80::1'), true);
    assert.strictEqual(isRestrictedIp('::ffff:127.0.0.1'), true); // IPv4-mapped IPv6
    assert.strictEqual(isRestrictedIp('::ffff:7f00:0001'), true); // Hex IPv4-mapped loopback
    assert.strictEqual(isRestrictedIp('2001:db8::1'), true); // Documentation IPv6

    // Public IPs must be permitted
    assert.strictEqual(isRestrictedIp('8.8.8.8'), false);
    assert.strictEqual(isRestrictedIp('1.1.1.1'), false);
    assert.strictEqual(isRestrictedIp('93.184.216.34'), false);
  });

  // =========================================================================
  // 2. Site Status Invariants (Section 6.1)
  // =========================================================================
  await t.test('H3.2: Site status detection stops normal checks and returns Status Report when state is not ok', () => {
    // A. Cross-domain redirect outside lock
    const redirectStatus = detectSiteStatus({
      requestedUrl: 'https://site-a.com',
      finalUrl: 'https://site-b.com/welcome',
      status: 200,
      headers: { 'content-type': 'text/html' },
      html: '<html><body>Hello from B</body></html>'
    });
    assert.strictEqual(redirectStatus.state, 'redirected_elsewhere');
    assert.strictEqual(redirectStatus.redirectedToDomain, 'site-b.com');
    assert.ok(redirectStatus.evidence.length > 0, 'Must include evidence');

    // B. Protection / WAF challenge (must never say "site is down")
    const wafStatus = detectSiteStatus({
      requestedUrl: 'https://protected.com',
      finalUrl: 'https://protected.com/',
      status: 403,
      headers: { 'content-type': 'text/html', 'server': 'cloudflare' },
      html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'
    });
    assert.strictEqual(wafStatus.state, 'blocked_by_protection');
    assert.ok(wafStatus.whatISawAr.includes('مش معناها إن الموقع واقع'), 'Must clarify that site is not necessarily down');

    // C. Maintenance mode
    const maintStatus = detectSiteStatus({
      requestedUrl: 'https://maint.com',
      finalUrl: 'https://maint.com/',
      status: 503,
      headers: { 'content-type': 'text/html', 'retry-after': '3600' },
      html: '<html><body><h1>الموقع تحت الصيانة</h1></body></html>'
    });
    assert.strictEqual(maintStatus.state, 'maintenance_or_coming_soon');

    // D. Parked / Default server page
    const parkedStatus = detectSiteStatus({
      requestedUrl: 'https://parked.com',
      finalUrl: 'https://parked.com/',
      status: 200,
      headers: { 'content-type': 'text/html' },
      html: '<html><head><title>Welcome to nginx!</title></head><body>Welcome to nginx</body></html>'
    });
    assert.strictEqual(parkedStatus.state, 'parked_or_default_page');

    // E. Auth wall
    const authStatus = detectSiteStatus({
      requestedUrl: 'https://portal.com',
      finalUrl: 'https://portal.com/wp-login.php',
      status: 200,
      headers: { 'content-type': 'text/html' },
      html: '<html><body>Login to continue</body></html>'
    });
    assert.strictEqual(authStatus.state, 'auth_wall');

    // F. Non-HTML
    const nonHtmlStatus = detectSiteStatus({
      requestedUrl: 'https://api.com/document.pdf',
      finalUrl: 'https://api.com/document.pdf',
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      html: '%PDF-1.4 ...'
    });
    assert.strictEqual(nonHtmlStatus.state, 'non_html');
  });

  // =========================================================================
  // 3. Page Discovery & Interaction States Invariants (Section 6.4)
  // =========================================================================
  await t.test('H3.3: Page discovery respects exclusions, priority order, and separates interaction states', async () => {
    // 1. Excluded paths (cart, checkout, admin, login) return null
    assert.strictEqual(
      isEligibleInternalUrl('/cart', 'https://example.com/', 'example.com'),
      null
    );
    assert.strictEqual(
      isEligibleInternalUrl('/checkout', 'https://example.com/', 'example.com'),
      null
    );
    assert.strictEqual(
      isEligibleInternalUrl('/wp-admin/index.php', 'https://example.com/', 'example.com'),
      null
    );
    assert.strictEqual(
      isEligibleInternalUrl('/wp-login.php', 'https://example.com/', 'example.com'),
      null
    );
    assert.strictEqual(
      isEligibleInternalUrl('/login', 'https://example.com/', 'example.com'),
      null
    );
    assert.strictEqual(
      isEligibleInternalUrl('https://otherdomain.com/page', 'https://example.com/', 'example.com'),
      null
    );

    // 2. Interaction state filter/sort URLs do not consume page slots
    let interactionCount = 0;
    const resFilter = isEligibleInternalUrl(
      '/products?sort=price_asc&filter=red',
      'https://example.com/',
      'example.com',
      () => interactionCount++
    );
    assert.strictEqual(resFilter, null, 'Filter URLs must not be returned as distinct meaningful pages');
    assert.strictEqual(interactionCount, 1, 'Interaction state callback must be triggered');

    // 3. Discovery priorities in discoverSitePages
    const mockHtml = `
      <html>
        <body>
          <nav>
            <a href="/about">من نحن</a>
            <a href="/contact">اتصل بنا</a>
            <a href="/products">المنتجات</a>
            <a href="/privacy">سياسة الخصوصية</a>
            <a href="/products?sort=new">ترتيب المنتجات</a>
            <a href="/products/item-1">منتج 1</a>
            <a href="/products/item-2">منتج 2</a>
            <a href="/products/item-3">منتج 3</a>
          </nav>
        </body>
      </html>
    `;

    const disc = await discoverSitePages({
      rootUrl: 'https://example.com/',
      rootHtml: mockHtml,
      maxPages: 10,
      onRequestMade: () => false
    });

    const urls = disc.selectedUrls.map(c => c.url);
    // Homepage always first
    assert.strictEqual(urls[0], 'https://example.com/');
    // Contact has highest subpage priority
    assert.strictEqual(disc.selectedUrls[1].pageType, 'contact');
    // Product detail pages capped at max 2
    const productDetailCount = disc.selectedUrls.filter(c => c.pageType === 'product').length;
    assert.ok(productDetailCount <= 2, `Product detail pages must be capped at 2, got ${productDetailCount}`);
    // Interaction state detected
    assert.ok(disc.interactionStatesCount >= 1, 'Interaction states must be tracked');
  });

  // =========================================================================
  // 4. Finding Invariants (Section 7)
  // =========================================================================
  await t.test('H3.4: normalizeFinding strictly enforces invariants without prompt', () => {
    // A. Dropped when no evidence
    const noEvidence = normalizeFinding({
      id: 'f_test_1',
      ruleId: 'R001',
      category: 'links',
      title: 'Missing Evidence Finding',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Saw a defect',
      steps: [],
      evidence: [],
      recommendedFix: 'Fix it'
    });
    assert.strictEqual(noEvidence, null, 'Finding with empty evidence must be dropped');

    // B. High/critical downgraded to medium if confidence !== confirmed
    const unconfirmedHigh = normalizeFinding({
      id: 'f_test_2',
      ruleId: 'R001',
      category: 'links',
      title: 'Unconfirmed High Severity',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'likely',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Possible broken link',
      steps: [],
      evidence: [{ type: 'snippet', value: '404', ref: '404' }],
      recommendedFix: 'Check it'
    });
    assert.ok(unconfirmedHigh);
    assert.strictEqual(unconfirmedHigh.severity, 'medium', 'High severity without confirmed confidence must downgrade to medium');
    assert.strictEqual(unconfirmedHigh.kind, 'suspected_issue', 'kind confirmed_defect without confirmed confidence must become suspected_issue');

    // C. llm_judgment caps: max confidence likely, max severity low, needs verbatim quote
    const llmFindingNoQuote = normalizeFinding({
      id: 'f_test_3',
      ruleId: 'LLM01',
      category: 'content',
      title: 'LLM Judgment Finding',
      kind: 'recommendation',
      severity: 'high',
      confidence: 'confirmed',
      method: 'llm_judgment',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'LLM thinks wording is awkward',
      steps: [],
      evidence: [{ type: 'header', value: 'Server: nginx', ref: 'Server: nginx' }], // not a quote/snippet
      recommendedFix: 'Rephrase'
    });
    assert.strictEqual(llmFindingNoQuote, null, 'llm_judgment without quote/snippet in evidence must be dropped');

    const llmFindingWithQuote = normalizeFinding({
      id: 'f_test_4',
      ruleId: 'LLM01',
      category: 'content',
      title: 'LLM Judgment Finding',
      kind: 'recommendation',
      severity: 'high',
      confidence: 'confirmed',
      method: 'llm_judgment',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'LLM thinks wording is awkward',
      steps: [],
      evidence: [{ type: 'quote', value: '"نص تجريبي هنا"', ref: '"نص تجريبي هنا"' }],
      recommendedFix: 'Rephrase'
    });
    assert.ok(llmFindingWithQuote);
    assert.strictEqual(llmFindingWithQuote.severity, 'low', 'llm_judgment severity must be capped at low');
    assert.strictEqual(llmFindingWithQuote.confidence, 'likely', 'llm_judgment confidence must be capped at likely');
    assert.strictEqual(llmFindingWithQuote.needsHumanDecision, true, 'llm_judgment needsHumanDecision must be true');

    // D. static_html rendered-layout claims (R005) capped at likely and medium
    const staticOverflow = normalizeFinding({
      id: 'f_test_5',
      ruleId: 'R005',
      category: 'responsive',
      title: 'Mobile horizontal overflow',
      kind: 'confirmed_defect',
      severity: 'critical',
      confidence: 'confirmed',
      method: 'static_html',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Found element with fixed width 600px',
      steps: [],
      evidence: [{ type: 'snippet', value: '<div style="width:600px">', ref: '<div style="width:600px">' }],
      recommendedFix: 'Use max-width'
    });
    assert.ok(staticOverflow);
    assert.strictEqual(staticOverflow.severity, 'medium', 'static_html rendered layout claim cannot exceed medium severity');
    assert.strictEqual(staticOverflow.confidence, 'likely', 'static_html rendered layout claim cannot exceed likely confidence');

    // E. Category capping at 5 per category
    const manyFindings: Finding[] = Array.from({ length: 8 }, (_, i) => ({
      id: `f_cap_${i}`,
      ruleId: 'R001',
      category: 'links',
      title: `Broken Link ${i}`,
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'http',
      source: 'rule',
      url: `https://example.com/p${i}`,
      occurrences: 1,
      observed: '404 Not Found',
      steps: [],
      evidence: [{ type: 'header', value: `GET /p${i} -> 404`, ref: '404' }],
      recommendedFix: 'Fix link'
    }));

    const cappedRes = normalizeAndCapFindings(manyFindings, 5);
    assert.strictEqual(cappedRes.findings.length, 5, 'Displayed findings must be capped at 5');
    assert.strictEqual(cappedRes.overflowCountsByCategory['links'], 3, 'Overflow count must record remaining 3 findings');
  });

  // =========================================================================
  // 5. Honest Checks, SPA & Platform Fix Invariants (Section 6.2 & 6.3)
  // =========================================================================
  await t.test('H3.5: Honest checks enforces platform-aware fixes, suppresses false SPA alarms, and avoids fake claims', () => {
    // A. Never says "enable SSL" on an HTTPS site
    const httpsHtml = `
      <html lang="ar" dir="rtl">
        <head><title>موقع آمن</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body><h1>مرحباً</h1></body>
      </html>
    `;
    const httpsRes = runHonestChecks({
      url: 'https://secure-site.com',
      html: httpsHtml,
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
    const sslFindings = httpsRes.findings.filter(f => /enable ssl|تفعيل ssl/i.test(`${f.title} ${f.recommendedFix}`));
    assert.strictEqual(sslFindings.length, 0, 'Must NEVER suggest "enable SSL" on an https:// site');

    // B. Never suggests Tailwind unless Tailwind is detected
    const noTailwindHtml = `
      <html lang="ar" dir="rtl">
        <head><title>موقع بدون تايلويند</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body><div style="width: 500px">عنصر ثابت</div></body>
      </html>
    `;
    const noTailwindRes = runHonestChecks({
      url: 'https://no-tailwind.com',
      html: noTailwindHtml,
      status: 200
    });
    for (const f of noTailwindRes.findings) {
      assert.ok(
        !f.recommendedFix.toLowerCase().includes('tailwind'),
        `Recommendation must not mention Tailwind when not present: "${f.recommendedFix}"`
      );
    }

    // C. Never suggests overflow-x:hidden as a fix for responsive issues
    for (const f of noTailwindRes.findings) {
      assert.ok(
        !f.recommendedFix.includes('overflow-x: hidden') && !f.recommendedFix.includes('overflow-x:hidden'),
        'Must NEVER recommend overflow-x:hidden to hide mobile overflow'
      );
    }

    // D. Unrendered SPA shell suppresses false H1 alarm and records SPA_RENDER in NOT_MEASURED
    const spaShellHtml = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>React SPA App</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/src/main.tsx"></script>
        </body>
      </html>
    `;
    const spaProfile = buildSiteProfile({
      url: 'https://react-spa.example.com',
      html: spaShellHtml
    });
    assert.strictEqual(spaProfile.platform, 'spa');

    const spaRes = runHonestChecks({
      url: 'https://react-spa.example.com',
      html: spaShellHtml,
      status: 200,
      capabilities: {
        serverFetch: true,
        responseHeaders: true,
        timing: true,
        htmlParser: true,
        headRequests: true,
        psi: false,
        geminiStructuredOutput: false,
        browserRendering: false
      },
      profile: spaProfile
    });

    const hasH1Error = spaRes.findings.some(f => f.ruleId === 'RC010' && f.title.includes('<h1>'));
    assert.strictEqual(hasH1Error, false, 'Unrendered SPA must NOT falsely flag missing <h1>');
    const hasSpaNotMeasured = spaRes.notMeasured.some(nm => nm.checkId === 'SPA_RENDER');
    assert.strictEqual(hasSpaNotMeasured, true, 'Unrendered SPA must record SPA_RENDER in NOT_MEASURED');

    // Verdict for unrendered SPA must be marked isPartial = true
    const spaVerdict = computeVerdict({
      findings: spaRes.findings,
      passes: spaRes.passes,
      notMeasured: spaRes.notMeasured,
      profile: spaProfile
    });
    assert.strictEqual(spaVerdict.isPartial, true, 'Verdict for unrendered SPA must have isPartial: true');
  });

  // =========================================================================
  // 6. Subpage Status Classification & Multi-Page Deduplication (Section 6.4)
  // =========================================================================
  await t.test('H3.6: Subpage HTTP status classification and multi-page finding deduplication', () => {
    // 1. 401 / 403 / 429 on subpage is classified as NOT_MEASURED (protected), NEVER a broken link
    const protectedSub = classifySubpageHttpStatus({
      candidate: { url: 'https://example.com/members', source: 'nav', priority: 1, pageType: 'content' },
      status: 403,
      rootUrl: 'https://example.com',
      index: 1
    });
    assert.ok(protectedSub.notMeasured, 'Protected subpage must return notMeasured');
    assert.strictEqual(protectedSub.finding, undefined, 'Protected subpage must not return a broken link finding');

    // 2. 5xx on subpage is classified as suspected_issue with medium severity
    const error500Sub = classifySubpageHttpStatus({
      candidate: { url: 'https://example.com/api-error', source: 'nav', priority: 1, pageType: 'content' },
      status: 500,
      rootUrl: 'https://example.com',
      index: 2
    });
    assert.ok(error500Sub.finding);
    assert.strictEqual(error500Sub.finding.severity, 'medium');
    assert.strictEqual(error500Sub.finding.kind, 'suspected_issue');

    // 3. Multi-page finding deduplication merges affectedUrls and sums occurrences
    const page1Finding: Finding = {
      id: 'f1',
      ruleId: 'R012',
      category: 'content',
      title: 'Missing Image Alt Attribute',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      source: 'rule',
      url: 'https://example.com/',
      location: 'img.logo',
      affectedUrls: ['https://example.com/'],
      occurrences: 1,
      observed: 'Logo missing alt',
      steps: [],
      evidence: [{ type: 'snippet', value: '<img class="logo">', ref: '<img class="logo">' }],
      recommendedFix: 'Add alt'
    };

    const page2Finding: Finding = {
      ...page1Finding,
      id: 'f2',
      url: 'https://example.com/about',
      affectedUrls: ['https://example.com/about'],
      occurrences: 1
    };

    const merged = mergeMultiPageFindings([page1Finding, page2Finding]);
    assert.strictEqual(merged.length, 1, 'Identical findings across pages must be merged by fingerprint');
    assert.strictEqual(merged[0].occurrences, 2, 'Occurrences must be summed');
    assert.strictEqual(merged[0].affectedUrls?.length, 2, 'affectedUrls must include both pages');
  });

  // =========================================================================
  // 7. Full Provider End-to-End Invariants (Live vs Mock)
  // =========================================================================
  await t.test('H3.7: LiveProvider and MockProvider adhere to truthfulness and labeling', async () => {
    // A. MockProvider must always return isMockFallback: true and label all mock items
    const mockP = new MockProvider();
    const mockRes = await mockP.runScan(
      'mock_test_1',
      { url: 'https://unreachable-mock-target-domain.test', locale: 'ar-EG' },
      () => {}
    );
    assert.strictEqual(mockRes.isMockFallback, true);
    assert.ok(mockRes.limitations.some(l => l.includes('MOCK')), 'Must include MOCK disclaimer in limitations');
    for (const f of mockRes.findings) {
      assert.ok(f.title.includes('[MOCK]'), `Mock finding title must be labeled [MOCK]: ${f.title}`);
    }

    // B. LiveProvider on local fixture server completes truthfully
    const fixtureServer = http.createServer((req, res) => {
      const p = req.url || '/';
      if (p === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
          <head>
            <title>موقع اختبار موثوق</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="description" content="وصف موقع الاختبار الموثوق لمدام عفاف" />
          </head>
          <body>
            <h1>أهلاً بكم في موقع الاختبار</h1>
            <p>محتوى تعريفي للموقع لاختبار المحرك الحقيقي.</p>
            <a href="/fixtures/about">من نحن</a>
          </body>
        </html>
      `);
    });

    await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
    const port = (fixtureServer.address() as { port: number }).port;
    const fixtureUrl = `http://127.0.0.1:${port}/fixtures/home`;

    try {
      const liveP = new LiveProvider();
      const liveRes = await liveP.runScan(
        'live_test_1',
        { url: fixtureUrl, locale: 'ar-EG' },
        () => {}
      );
      assert.strictEqual(liveRes.isMockFallback, false);
      assert.strictEqual(liveRes.siteStatus?.state, 'ok');
      assert.ok(liveRes.uniquePagesInspected >= 1);
      assert.ok(liveRes.verdict);
      assert.ok((liveRes.passes || []).length > 0);
    } finally {
      fixtureServer.close();
    }
  });
});
