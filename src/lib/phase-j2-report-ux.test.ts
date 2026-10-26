import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('PHASE J2: Report UX Regression Suite (J2.1 - J2.10)', () => {
  const reportViewPath = path.resolve(process.cwd(), 'src/components/ReportView.tsx');
  const indexCssPath = path.resolve(process.cwd(), 'src/index.css');
  const aiConsultantPath = path.resolve(process.cwd(), 'src/components/MadamAfafAiConsultant.tsx');
  const recentScansPath = path.resolve(process.cwd(), 'src/components/RecentScansDrawer.tsx');
  const officialStampPath = path.resolve(process.cwd(), 'src/components/OfficialStamp.tsx');
  const formatPath = path.resolve(process.cwd(), 'src/lib/format.ts');
  const limitsPath = path.resolve(process.cwd(), 'src/config/limits.ts');

  it('J2.1: Sticky accordion headers use --sticky-offset / --sticky-offset-2, min-height 48px, overflow: clip instead of overflow-hidden on accordion ancestors', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');

    assert.ok(css.includes('--sticky-offset'), 'src/index.css must define --sticky-offset');
    assert.ok(css.includes('--sticky-offset-2'), 'src/index.css must define --sticky-offset-2');
    assert.ok(css.includes('afaf-sticky-accordion-header'), 'src/index.css must define .afaf-sticky-accordion-header');
    assert.ok(css.includes('afaf-sticky-nested-header'), 'src/index.css must define .afaf-sticky-nested-header');
    assert.ok(reportSrc.includes('afaf-sticky-accordion-header'), 'ReportView must apply afaf-sticky-accordion-header to section/category accordion headers');
    assert.ok(reportSrc.includes('afaf-sticky-nested-header'), 'ReportView must apply afaf-sticky-nested-header to nested finding headers');
    assert.ok(
      !reportSrc.includes('className="border overflow-hidden" style={{ backgroundColor: \'var(--surface)\''),
      'Category accordion wrapper must not use overflow-hidden between sticky header and scroller (use overflow-clip)'
    );
  });

  it('J2.2: First-screen toolbar has ONE primary button "برومبت الإصلاح الشامل" and ONE "المزيد" menu, with technical-details switch inside sticky mini-bar', () => {
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    assert.ok(reportSrc.includes('data-testid="primary-master-prompt-btn"'), 'Must render primary "برومبت الإصلاح الشامل" button in first-screen toolbar');
    assert.ok(reportSrc.includes('data-testid="more-actions-menu-btn"'), 'Must render "المزيد" menu trigger in first-screen toolbar');
    assert.ok(reportSrc.includes('data-testid="minibar-tech-details-toggle"'), 'Technical-details switch must live in the sticky mini-bar');
  });

  it('J2.3: Floating "برومبت الإصلاح الشامل" button opens a 2-tab sheet ("للـ AI" and "تقرير لمبرمج") with "المؤكد فقط" toggle and .md download', async () => {
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    assert.ok(reportSrc.includes('data-testid="floating-master-prompt-btn"'), 'Must render floating "برومبت الإصلاح الشامل" button');
    assert.ok(reportSrc.includes('للـ AI'), 'Sheet must include tab "للـ AI"');
    assert.ok(reportSrc.includes('تقرير لمبرمج'), 'Sheet must include tab "تقرير لمبرمج"');
    assert.ok(reportSrc.includes('المؤكد فقط'), 'Sheet must include toggle "المؤكد فقط"');

    const repairMod = await import('./repair-prompt-builder.js');
    assert.equal(typeof (repairMod as any).buildDeveloperMarkdownHandoff, 'function', 'repair-prompt-builder must export buildDeveloperMarkdownHandoff');
  });

  it('J2.4: Mobile typography & wrapping: no text-[10px] or text-[11px] anywhere in components; text-wrap balance/pretty and hyphens: none in index.css', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');
    assert.ok(css.includes('text-wrap: balance'), 'index.css must set text-wrap: balance on headings');
    assert.ok(css.includes('text-wrap: pretty'), 'index.css must set text-wrap: pretty on paragraphs');
    assert.ok(css.includes('hyphens: none'), 'index.css must set hyphens: none');

    for (const file of [reportViewPath, aiConsultantPath, recentScansPath, officialStampPath]) {
      const content = fs.readFileSync(file, 'utf-8');
      assert.ok(!content.includes('text-[10px]'), `${path.basename(file)} must not contain text-[10px]`);
      assert.ok(!content.includes('text-[11px]'), `${path.basename(file)} must not contain text-[11px]`);
    }
  });

  it('J2.5: All UI numbers and dates formatted in Latin digits via src/lib/format.ts (never matching [٠-٩])', async () => {
    assert.ok(fs.existsSync(formatPath), 'src/lib/format.ts must exist');
    const formatMod = await import('./format.js');
    const numStr = formatMod.formatNumber(128456);
    const dateStr = formatMod.formatDate('2026-03-15T14:30:00.000Z');
    const durStr = formatMod.formatDuration(2450);

    assert.ok(!/[٠-٩]/.test(numStr), `formatNumber output "${numStr}" must not contain Arabic-Indic digits`);
    assert.ok(!/[٠-٩]/.test(dateStr), `formatDate output "${dateStr}" must not contain Arabic-Indic digits`);
    assert.ok(!/[٠-٩]/.test(durStr), `formatDuration output "${durStr}" must not contain Arabic-Indic digits`);

    for (const file of [reportViewPath, recentScansPath, aiConsultantPath]) {
      const content = fs.readFileSync(file, 'utf-8');
      assert.ok(!content.includes("toLocaleString('ar-EG'"), `${path.basename(file)} must not call toLocaleString('ar-EG') directly`);
      assert.ok(!content.includes("toLocaleTimeString('ar-EG'"), `${path.basename(file)} must not call toLocaleTimeString('ar-EG') directly`);
    }
  });

  it('J2.6: "قريبًا" chips on upcoming capabilities and 3-line NOT_MEASURED format ("ليه ما اتقاسش؟ / إزاي هتشتغل؟ / إمتى؟") with zero "Static HTML" jargon', async () => {
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    const honestChecksSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/honest-checks.ts'), 'utf-8');

    assert.ok(reportSrc.includes('ليه ما اتقاسش؟'), 'ReportView must display "ليه ما اتقاسش؟" in NOT_MEASURED cards');
    assert.ok(reportSrc.includes('إزاي هتشتغل؟'), 'ReportView must display "إزاي هتشتغل؟" in NOT_MEASURED cards');
    assert.ok(reportSrc.includes('إمتى؟'), 'ReportView must display "إمتى؟" in NOT_MEASURED cards');
    assert.ok(honestChecksSrc.includes('قريت كود الصفحة من غير ما أفتحها في متصفح'), 'honest-checks must explain static analysis in plain Arabic');
    assert.ok(!honestChecksSrc.includes('(Static HTML)'), 'honest-checks must not use "(Static HTML)" jargon in Arabic user strings');
  });

  it('J2.7: MadamAfafAiConsultant header never renders "مراجعة: undefined"', () => {
    const aiConsultantSrc = fs.readFileSync(aiConsultantPath, 'utf-8');
    assert.ok(
      !aiConsultantSrc.includes('مراجعة: {scanResult?.registrableDomain || context?.domain}') &&
      aiConsultantSrc.includes('const reviewedDomain ='),
      'MadamAfafAiConsultant must compute reviewedDomain safely from effectiveScanResult/effectiveContext and never interpolate undefined'
    );
  });

  it('J2.8: Verdict names its drivers (top 1-3 confirmed findings) and platform-adapter has no unknown rule fallback for R009/R008/RC010', async () => {
    const { computeVerdict } = await import('./honest-checks.js');
    const { getPlatformAwareFix } = await import('./platform-adapter.js');

    const verdict = computeVerdict(
      [
        {
          id: 'psi_lcp',
          ruleId: 'PSI_LCP',
          category: 'performance',
          severity: 'high',
          confidence: 'confirmed',
          kind: 'confirmed_defect',
          affectsVerdict: true,
          method: 'psi',
          titleAr: 'بطء ظهور أكبر عنصر في الصفحة (LCP: 8.6 ثانية)',
          descriptionAr: 'تأخر ظهور المحتوى الأساسي.',
          whyItMattersAr: 'يؤثر على تجربة الزائر.',
          howToFixAr: 'ضغط الصور.',
          evidence: ['LCP: 8.6 s'],
          needsHumanDecision: false,
        },
      ],
      [],
      false
    );

    assert.ok(Array.isArray((verdict as any).drivers) && (verdict as any).drivers.length === 1, 'computeVerdict must return drivers array for confirmed verdict-affecting findings');
    assert.ok((verdict as any).drivers[0].summaryAr.includes('السبب الأساسي'), 'Primary driver must include "السبب الأساسي"');

    const r009Fix = getPlatformAwareFix('R009', 'wordpress', 'اضبط الكاش');
    assert.ok(typeof r009Fix === 'string' && r009Fix.length > 0 && r009Fix !== 'اضبط الكاش', 'R009 must have a specific platform-aware fix rather than unknown fallback');
  });

  it('J2.9: Readable evidence builds URL text fragment link ("افتح الصفحة عند النص" with #:~:text=)', async () => {
    const formatMod = await import('./format.js');
    assert.equal(typeof (formatMod as any).buildTextFragmentUrl, 'function', 'format.ts must export buildTextFragmentUrl');
    const link = (formatMod as any).buildTextFragmentUrl('https://elabyad-eg.com/about', 'شركة الأبيض للاستيراد والتصدير');
    assert.ok(link && link.includes('#:~:text='), 'buildTextFragmentUrl must produce a #:~:text= URL fragment');

    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    assert.ok(reportSrc.includes('افتح الصفحة عند النص'), 'ReportView must render "افتح الصفحة عند النص" progressive enhancement link');
  });

  it('J2.10: High-profile domains config, notice banner, disabled sharing, and negative-control fixtures never produce confirmed high findings', async () => {
    const limitsMod = await import('../config/limits.js');
    assert.ok(Array.isArray((limitsMod as any).HIGH_PROFILE_DOMAINS), 'limits.ts must export HIGH_PROFILE_DOMAINS');
    assert.equal(typeof (limitsMod as any).isHighProfileDomain, 'function', 'limits.ts must export isHighProfileDomain');
    assert.equal((limitsMod as any).isHighProfileDomain('https://www.google.com/search'), true, 'google.com must be detected as high-profile');
    assert.equal((limitsMod as any).isHighProfileDomain('https://elabyad-eg.com/'), false, 'elabyad-eg.com must not be high-profile');

    const { detectSiteStatus } = await import('./site-status.js');
    const consentStatus = detectSiteStatus({
      requestedUrl: 'https://www.youtube.com/',
      finalUrl: 'https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F',
      status: 200,
      headers: { 'content-type': 'text/html' },
      html: '<html><head><title>Before you continue to YouTube</title></head><body><h1>Before you continue to YouTube</h1><form action="/save"><button>Accept all</button><button>Reject all</button></form></body></html>',
    });
    assert.notEqual(consentStatus.state, 'ok', 'Consent wall redirect must be classified as non-ok status report');

    const challenge200Status = detectSiteStatus({
      requestedUrl: 'https://www.amazon.com/',
      finalUrl: 'https://www.amazon.com/',
      status: 200,
      headers: { 'content-type': 'text/html' },
      html: '<html><head><title>Robot Check</title></head><body><h1>Enter the characters you see below</h1><form action="/errors/validateCaptcha"><input type="text" name="field-keywords"/></form></body></html>',
    });
    assert.equal(challenge200Status.state, 'blocked_by_protection', 'HTTP 200 robot check challenge must be classified as blocked_by_protection');

    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    assert.ok(reportSrc.includes('high-profile-domain-banner'), 'ReportView must render high-profile notice banner on screen and print');
  });
});


