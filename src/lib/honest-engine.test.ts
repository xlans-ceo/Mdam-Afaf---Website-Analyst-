import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinding, normalizeAndCapFindings } from './normalize-finding';
import { runHonestChecks } from './honest-checks';
import { buildRepairPrompts } from './repair-prompt-builder';
import { isRestrictedIp, validateSsrfUrl } from './ssrf-validator';
import { detectCapabilities } from './capabilities';
import { Finding } from '../types/contract';

/**
 * Step 9 Regression Fixture:
 * - WordPress + Elementor generator meta
 * - EN language switcher with href="#" + Instagram social icon with href="#"
 * - 29 images sharing identical alt="مصنع الأبيض للمنظفات"
 * - Both "الأبيض" (with hamza) and "الابيض" (without hamza) in copy
 * - Contact email on a different domain (sales@legacy-agency-mail.org vs alabyad-factory.com)
 * - Leaked author "admin" in twitter:data1 meta
 * - <video autoplay muted loop> hero without poster
 * - Export claim without working English version
 */
function buildRegressionFixtureHtml(): string {
  const repeatedImgs = Array.from({ length: 29 }, (_, idx) => {
    return `<img src="https://alabyad-factory.com/wp-content/uploads/prod-${idx + 1}.jpg" alt="مصنع الأبيض للمنظفات">`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>شركة الأبيض للصناعات الكيماوية والمنظفات</title>
  <meta name="description" content="شركة الأبيض لتصنيع وتصدير المنظفات الصناعية والمنزلية بأعلى جودة قياسية إلى الأسواق العربية والعالمية.">
  <meta name="generator" content="WordPress 6.8.5">
  <meta name="generator" content="Elementor 3.31.3; features: e_font_icon_svg">
  <meta name="twitter:label1" content="كتب بواسطة">
  <meta name="twitter:data1" content="admin">
</head>
<body class="rtl home page-template elementor-default elementor-kit-7 elementor-page">
  <header class="elementor-section">
    <nav>
      <a href="https://alabyad-factory.com/">الرئيسية</a>
      <a href="https://alabyad-factory.com/products">المنتجات</a>
      <a href="#" class="lang-item">EN</a>
      <a href="#" class="elementor-social-icon elementor-social-icon-instagram" aria-label="Instagram">
        <i class="fab fa-instagram"></i>
      </a>
    </nav>
  </header>
  <main>
    <section class="hero elementor-section">
      <video autoplay muted loop src="https://alabyad-factory.com/wp-content/uploads/hero-factory.mp4"></video>
      <h1>مصنع الأبيض للمنظفات الصناعية</h1>
      <p>نرحب بكم في مصنع الابيض الرائد في تصنيع الخامات والمنظفات، حيث نصدر منتجاتنا إلى السعودية والإمارات وجميع أنحاء العالم.</p>
      <a href="https://wa.me/201099998888">تواصل واتساب لطلب عرض سعر</a>
    </section>
    <section class="gallery">
      ${repeatedImgs}
    </section>
  </main>
  <footer>
    <p>للتواصل التجاري: <a href="mailto:sales@legacy-agency-mail.org">sales@legacy-agency-mail.org</a></p>
  </footer>
</body>
</html>`;
}

describe('Honest Engine v1.1 — Step 2: normalizeFinding Invariants', () => {
  it('drops any finding that has no evidence', () => {
    const f: Finding = {
      id: 'f1',
      ruleId: 'R001',
      category: 'links',
      title: 'No evidence finding',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Something broken',
      steps: [],
      evidence: [],
      recommendedFix: 'Fix it'
    };
    assert.equal(normalizeFinding(f), null);
  });

  it('downgrades high/critical severity to medium when confidence is not confirmed', () => {
    const f: Finding = {
      id: 'f2',
      ruleId: 'R005',
      category: 'responsive',
      title: 'Suspected overflow',
      kind: 'confirmed_defect',
      severity: 'critical',
      confidence: 'likely',
      method: 'static_html',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Inline width',
      steps: [],
      evidence: [{ type: 'snippet', value: '<div style="width:500px">', ref: '<div style="width:500px">' }],
      recommendedFix: 'Use max-width: 100%'
    };
    const norm = normalizeFinding(f);
    assert.ok(norm);
    assert.equal(norm.severity, 'medium');
    assert.equal(norm.kind, 'suspected_issue');
  });

  it('enforces llm_judgment caps: max confidence likely, max severity low, needsHumanDecision true, requires quote', () => {
    const f: Finding = {
      id: 'f3',
      ruleId: 'RC006',
      category: 'content',
      title: 'Tone mismatch',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'llm_judgment',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Mixed tone',
      steps: [],
      evidence: [{ type: 'quote', value: 'Verbatim quote from page', ref: 'Verbatim quote from page' }],
      recommendedFix: 'Unify tone'
    };
    const norm = normalizeFinding(f);
    assert.ok(norm);
    assert.equal(norm.confidence, 'likely');
    assert.equal(norm.severity, 'low');
    assert.equal(norm.needsHumanDecision, true);
    assert.equal(norm.kind, 'suspected_issue');
  });

  it('caps static_html rendered-layout claims (R005) at likely and medium even if passed as confirmed/critical', () => {
    const f: Finding = {
      id: 'f4',
      ruleId: 'R005',
      category: 'responsive',
      title: 'Mobile overflow',
      kind: 'confirmed_defect',
      severity: 'critical',
      confidence: 'confirmed',
      method: 'static_html',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Fixed width in HTML',
      steps: [],
      evidence: [{ type: 'snippet', value: 'style="width: 600px"', ref: 'style="width: 600px"' }],
      recommendedFix: 'Fix width'
    };
    const norm = normalizeFinding(f);
    assert.ok(norm);
    assert.equal(norm.confidence, 'likely');
    assert.equal(norm.severity, 'medium');
  });

  it('caps displayed findings at 5 per category and records overflow count', () => {
    const items: Finding[] = Array.from({ length: 7 }, (_, i) => ({
      id: `seo_${i}`,
      ruleId: 'RC010',
      category: 'seo',
      title: `SEO Issue ${i}`,
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      method: 'static_html',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Observed',
      steps: [],
      evidence: [{ type: 'snippet', value: `<meta_${i}>`, ref: `<meta_${i}>` }],
      recommendedFix: 'Fix'
    }));

    const res = normalizeAndCapFindings(items, 5);
    assert.equal(res.findings.length, 5);
    assert.equal(res.overflowCountsByCategory.seo, 2);
  });
});

describe('Honest Engine v1.1 — Step 9 Regression Fixture Verification', () => {
  const html = buildRegressionFixtureHtml();
  const url = 'https://alabyad-factory.com/';
  const output = runHonestChecks({
    url,
    html,
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
    ttfbMs: 310
  });

  it('detects WordPress + Elementor platform and B2B manufacturer siteType', () => {
    assert.equal(output.profile.platform, 'wordpress');
    assert.equal(output.profile.builder, 'elementor');
    assert.equal(output.profile.siteType, 'b2b_manufacturer');
    assert.equal(output.profile.direction, 'rtl');
    assert.equal(output.profile.language, 'ar');
    assert.equal(output.profile.primaryConversion?.type, 'whatsapp');
    assert.equal(output.profile.primaryConversion?.inTopOfPage, true);
    assert.equal(output.profile.markets?.hasExportClaims, true);
    assert.equal(output.profile.markets?.hasAlternateLanguage, false);
  });

  it('splits href="#" into R003_LANG (EN switcher) and R003_SOCIAL (Instagram icon)', () => {
    const langFinding = output.allNormalizedFindings.find(f => f.ruleId === 'R003_LANG');
    const socialFinding = output.allNormalizedFindings.find(f => f.ruleId === 'R003_SOCIAL');
    assert.ok(langFinding, 'Expected R003_LANG for EN href="#" switcher');
    assert.ok(socialFinding, 'Expected R003_SOCIAL for Instagram href="#" icon');
    assert.equal(langFinding.category, 'content');
    assert.equal(socialFinding.category, 'links');
  });

  it('reports RC005 for 29 images sharing identical alt text and does NOT falsely report R012 missing alt', () => {
    const r012 = output.allNormalizedFindings.find(f => f.ruleId === 'R012');
    const rc005 = output.allNormalizedFindings.find(f => f.ruleId === 'RC005');
    assert.equal(r012, undefined, 'Should not report R012 when all 29 images have non-empty alt');
    assert.ok(rc005, 'Expected RC005 for 29 repeated alt attributes');
    assert.equal(rc005.occurrences, 29);
  });

  it('detects RC001 brand spelling inconsistency ("الأبيض" vs "الابيض")', () => {
    const rc001 = output.allNormalizedFindings.find(f => f.ruleId === 'RC001');
    assert.ok(rc001, 'Expected RC001 for الأبيض vs الابيض');
    assert.equal(rc001.needsHumanDecision, true);
  });

  it('detects RC002 email domain mismatch phrased as a question with needsHumanDecision', () => {
    const rc002 = output.allNormalizedFindings.find(f => f.ruleId === 'RC002');
    assert.ok(rc002, 'Expected RC002 for sales@legacy-agency-mail.org on alabyad-factory.com');
    assert.equal(rc002.needsHumanDecision, true);
    assert.ok(rc002.titleAr?.includes('؟'), 'RC002 titleAr must be phrased as a question');
  });

  it('detects RC004 leaked "admin" author in twitter:data1 meta tag', () => {
    const rc004 = output.allNormalizedFindings.find(f => f.ruleId === 'RC004');
    assert.ok(rc004, 'Expected RC004 for twitter:data1="admin"');
    assert.equal(rc004.confidence, 'confirmed');
  });

  it('detects R013 <video> hero without poster AND marks LCP/CLS as NOT_MEASURED (never guesses LCP)', () => {
    const r013Video = output.allNormalizedFindings.find(f => f.id === 'f_r013_video_hero');
    assert.ok(r013Video, 'Expected R013 finding for <video> hero without poster');
    const lcpNotMeasured = output.notMeasured.find(nm => nm.checkId === 'R013');
    assert.ok(lcpNotMeasured, 'Expected LCP/CLS to be listed in notMeasured when PSI is absent');
  });

  it('places R010 in security category and never says "enable SSL" on an https:// site', () => {
    const r010 = output.allNormalizedFindings.find(f => f.ruleId === 'R010');
    assert.ok(r010, 'Expected R010 for missing security headers');
    assert.equal(r010.category, 'security');
    assert.ok(!/شهادة SSL|enable SSL/i.test(r010.recommendedFix), 'Must not tell https site to enable SSL');
  });

  it('detects RC009 market-language gap when export is claimed without alternate language', () => {
    const rc009 = output.allNormalizedFindings.find(f => f.ruleId === 'RC009');
    assert.ok(rc009, 'Expected RC009 for export claims without alternate language');
  });

  it('builds a CMS checklist repair pack for WordPress+Elementor without Tailwind or overflow-x:hidden', () => {
    const pack = buildRepairPrompts({
      requestedUrl: url,
      siteProfile: output.profile,
      findings: output.findings
    });
    assert.equal(pack.repairMode, 'cms_checklist');
    assert.ok(!/overflow-x-hidden|overflow-x:\s*hidden/i.test(pack.masterPrompt));
    assert.ok(!/w-full|max-w-full/i.test(pack.masterPrompt));
  });
});

describe('Honest Engine v1.1 — Step 1 & Step 8: Capabilities & SSRF Blocklist', () => {
  it('returns typed capabilities with browserRendering=false', async () => {
    const caps = await detectCapabilities({ skipNetworkProbe: true, forceRefresh: true });
    assert.equal(typeof caps.serverFetch, 'boolean');
    assert.equal(caps.htmlParser, true);
    assert.equal(caps.browserRendering, false);
  });

  it('blocks loopback, private networks, link-local metadata 169.254.169.254, and non-http schemes', async () => {
    assert.equal(isRestrictedIp('127.0.0.1'), true);
    assert.equal(isRestrictedIp('10.0.0.1'), true);
    assert.equal(isRestrictedIp('172.16.5.4'), true);
    assert.equal(isRestrictedIp('192.168.1.1'), true);
    assert.equal(isRestrictedIp('169.254.169.254'), true);
    assert.equal(isRestrictedIp('::1'), true);
    assert.equal(isRestrictedIp('93.184.216.34'), false);

    const fileCheck = await validateSsrfUrl('file:///etc/passwd');
    assert.equal(fileCheck.valid, false);

    const metaCheck = await validateSsrfUrl('http://169.254.169.254/latest/meta-data/');
    assert.equal(metaCheck.valid, false);
  });
});
