import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSiteStatus } from './site-status';
import { parseRobotsTxt, isDisallowedByRobots } from './page-discovery';
import { buildSiteProfile } from './site-profiler';
import { runHonestChecks, computeVerdict, evaluateAiClaims } from './honest-checks';
import { getRegistrableDomain } from './domain-parser';

test('detectSiteStatus: identifies maintenance page on HTTP 503', () => {
  const status = detectSiteStatus({
    requestedUrl: 'https://example.com',
    finalUrl: 'https://example.com/',
    status: 503,
    headers: { 'content-type': 'text/html', 'retry-after': '3600' },
    html: '<html><body><h1>الموقع تحت الصيانة حالياً</h1></body></html>'
  });
  assert.equal(status.state, 'maintenance_or_coming_soon');
});

test('detectSiteStatus: identifies Cloudflare protection challenge', () => {
  const status = detectSiteStatus({
    requestedUrl: 'https://example.com',
    finalUrl: 'https://example.com/',
    status: 403,
    headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'
  });
  assert.equal(status.state, 'blocked_by_protection');
});

test('detectSiteStatus: identifies cross-domain redirect outside domain lock', () => {
  const status = detectSiteStatus({
    requestedUrl: 'https://oldbrand.com',
    finalUrl: 'https://newbrand.org/home',
    status: 200,
    headers: { 'content-type': 'text/html' },
    html: '<html><body><nav><a href="/about">About</a></nav><h1>Welcome</h1><p>' + 'A'.repeat(250) + '</p></body></html>'
  });
  assert.equal(status.state, 'redirected_elsewhere');
});

test('parseRobotsTxt: respects Disallow and Allow longest match', () => {
  const txt = `
User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Disallow: /private/
  `;
  const rules = parseRobotsTxt(txt);
  assert.equal(isDisallowedByRobots('/wp-admin/index.php', rules), true);
  assert.equal(isDisallowedByRobots('/wp-admin/admin-ajax.php', rules), false);
  assert.equal(isDisallowedByRobots('/private/page', rules), true);
  assert.equal(isDisallowedByRobots('/about-us', rules), false);
});

test('buildSiteProfile: prioritizes b2b_manufacturer over passive WooCommerce classes and ignores self hreflang', () => {
  const html = `
    <html lang="ar" dir="rtl">
      <head>
        <title>مصنع الأبيض لتصنيع وتوريد الكابلات</title>
        <link rel="alternate" hreflang="ar" href="https://elabyad-eg.com/" />
      </head>
      <body class="woocommerce-no-js">
        <h1>مصنع الأبيض لتصنيع وتصدير خطوط الإنتاج</h1>
        <a href="https://wa.me/201000000000">تواصل واتساب</a>
      </body>
    </html>
  `;
  const profile = buildSiteProfile({
    url: 'https://elabyad-eg.com/',
    html,
    headers: {}
  });
  assert.equal(profile.siteType, 'b2b_manufacturer');
  assert.equal(profile.markets?.hasAlternateLanguage, false);
  assert.equal(profile.markets?.hasExportClaims, true);
});

test('runHonestChecks: detects RC006 empty embed, RC007 mismatched tel href, RC009 export without foreign language, and JSON-LD pass', () => {
  const html = `
    <html lang="ar" dir="rtl">
      <head>
        <title>مصنع التوريدات الهندسية لتصنيع وتصدير المعدات الصناعية</title>
        <meta name="description" content="مصنع التوريدات الهندسية المتكاملة لتصنيع وتصدير المعدات الصناعية وخطوط الإنتاج إلى جميع أنحاء العالم والشرق الأوسط بجودة قياسية." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="canonical" href="https://factory.eg/" />
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Factory"}</script>
      </head>
      <body>
        <h1>مصنع التوريدات الهندسية للتصدير إلى جميع دول العالم</h1>
        <p>نصدر منتجاتنا إلى السعودية والإمارات وأوروبا وجميع الأسواق العالمية.</p>
        <iframe src=""></iframe>
        <a href="tel:01011111111">اتصل بنا: 01299999999</a>
        <a href="https://wa.me/01012345678">واتساب</a>
      </body>
    </html>
  `;
  const profile = buildSiteProfile({
    url: 'https://factory.eg/',
    html,
    headers: {}
  });
  const out = runHonestChecks({
    url: 'https://factory.eg/',
    status: 200,
    headers: {
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'self'"
    },
    ttfbMs: 120,
    html,
    profile
  });

  const ruleIds = out.findings.map(f => f.ruleId);
  assert.ok(ruleIds.includes('RC006'), 'Expected RC006 for empty iframe');
  assert.ok(ruleIds.includes('RC007'), 'Expected RC007 for tel mismatch / local wa.me');
  assert.ok(ruleIds.includes('RC009'), 'Expected RC009 for B2B manufacturer with export claims and no alternate language');
  assert.ok(
    out.passes.some(p => (p.titleAr || '').includes('JSON-LD') || (p.detailAr || '').includes('JSON-LD')),
    'Expected JSON-LD pass'
  );
});

test('computeVerdict & evaluateAiClaims: deterministic verdict and AI claim comparison', () => {
  const verdict = computeVerdict({
    findings: [
      {
        id: '1',
        url: 'https://example.com',
        occurrences: 1,
        ruleId: 'R008',
        category: 'seo',
        severity: 'high',
        confidence: 'confirmed',
        kind: 'confirmed_defect',
        method: 'static_html',
        source: 'rule',
        title: 'Missing Title',
        titleAr: 'عنوان ناقص',
        observed: 'x',
        expected: 'y',
        steps: ['z'],
        recommendedFix: 'w',
        needsHumanDecision: false,
        evidence: [{ type: 'dom_snippet', value: '<title></title>', ref: 'title' }]
      }
    ],
    passes: [],
    notMeasured: [{ id: 'nm_lcp_cls', checkId: 'LCP_CLS', category: 'performance', titleAr: 'LCP', reasonAr: 'No headless browser' }]
  });

  assert.equal(verdict.level, 'fix_before_handover');
  assert.equal(verdict.labelAr, 'فيه مشاكل لازم تتحل قبل الاستلام');
  assert.equal(verdict.isPartial, true);

  const claims = evaluateAiClaims({
    aiClaimsText: 'الموقع متوافق مع محركات البحث SEO ومؤمن بالكامل ومتجاوب للموبايل',
    findings: [
      {
        id: '1',
        url: 'https://example.com',
        occurrences: 1,
        ruleId: 'R008',
        category: 'seo',
        severity: 'high',
        confidence: 'confirmed',
        kind: 'confirmed_defect',
        method: 'static_html',
        source: 'rule',
        title: 'Missing Title',
        titleAr: 'عنوان ناقص',
        observed: 'x',
        expected: 'y',
        steps: ['z'],
        recommendedFix: 'w',
        needsHumanDecision: false,
        evidence: [{ type: 'dom_snippet', value: '<title></title>', ref: 'title' }]
      }
    ],
    passes: [],
    notMeasured: [{ id: 'nm_lcp_cls', checkId: 'LCP_CLS', category: 'performance', titleAr: 'LCP', reasonAr: 'Static HTML only' }]
  });

  assert.ok(claims.length >= 2);
  const seoClaim = claims.find(c => c.claimAr.includes('SEO'));
  assert.equal(seoClaim?.status, 'contradicted');
});

test('getRegistrableDomain: handles multi-part Egyptian TLDs', () => {
  assert.equal(getRegistrableDomain('https://www.shop.company.com.eg/products'), 'company.com.eg');
  assert.equal(getRegistrableDomain('https://sub.elabyad-eg.com/about'), 'elabyad-eg.com');
});
