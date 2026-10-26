import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parsePageHtml,
  decodeUrlForDisplay
} from './html-dom';
import {
  runHonestChecks,
  computeVerdict,
  formatArabicNoteCount
} from './honest-checks';
import {
  fetchPsiMetricsIfAvailable,
  LiveProvider,
  mergeMultiPageFindings
} from './providers/index';
import { detectCapabilities } from './capabilities';
import { askMadamAfaf } from './ai-consultant';
import { validateVisitorIdSalt, ensureRuntimeVisitorIdSalt } from './storage';
import { buildConfigCheckReport } from './config-check';

const RECORDED_PSI_ELABYAD_FIXTURE = {
  id: 'https://elabyad-eg.com/',
  lighthouseResult: {
    requestedUrl: 'https://elabyad-eg.com/',
    finalUrl: 'https://elabyad-eg.com/',
    audits: {
      'largest-contentful-paint': { numericValue: 8551 },
      'first-contentful-paint': { numericValue: 2650 },
      'cumulative-layout-shift': { numericValue: 0.047 },
      'total-blocking-time': { numericValue: 327 },
      'speed-index': { numericValue: 4120 },
      'lcp-breakdown-insight': {
        id: 'lcp-breakdown-insight',
        title: 'LCP breakdown',
        score: 0,
        details: {
          type: 'list',
          items: [
            {
              type: 'table',
              items: [
                { subpart: 'timeToFirstByte', label: 'Time to first byte', duration: 183 },
                { subpart: 'resourceLoadDelay', label: 'Resource load delay', duration: 2153 }
              ]
            },
            {
              type: 'node',
              selector: 'div.elementor > div.elementor-element > div.elementor-element > section.abyad-pattern-hero',
              snippet: '<section class="abyad-pattern-hero">',
              nodeLabel: 'مصنع الأبيض للملابس التصدير'
            }
          ]
        }
      },
      'image-delivery-insight': {
        id: 'image-delivery-insight',
        title: 'Improve image delivery',
        score: 0,
        displayValue: 'Est savings of 1,848 KiB',
        metricSavings: { LCP: 3700, FCP: 0 }
      },
      'render-blocking-insight': {
        id: 'render-blocking-insight',
        title: 'Render-blocking requests',
        score: 0,
        displayValue: 'Est savings of 1,910 ms',
        metricSavings: { LCP: 0, FCP: 1900 }
      },
      'cache-insight': {
        id: 'cache-insight',
        title: 'Use efficient cache lifetimes',
        score: 0,
        displayValue: 'Est savings of 752 KiB',
        metricSavings: { LCP: 1100, FCP: 0 }
      },
      'unused-javascript': {
        id: 'unused-javascript',
        title: 'Reduce unused JavaScript',
        score: 0.5,
        displayValue: 'Est savings of 187 KiB',
        details: { overallSavingsMs: 0, overallSavingsBytes: 191343 },
        metricSavings: { LCP: 0, FCP: 0 }
      }
    },
    categories: {
      performance: { score: 0.58 },
      seo: { score: 1.0 }
    }
  }
};

describe('PHASE J1 (FINAL): Finding Accuracy, Readable Evidence, PSI Refinements & Config Audit', () => {
  test('A1: html-dom parses once per page, locates nearest landmark + heading in Arabic, collapses snippet <=200 chars, and decodes URLs for display', () => {
    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <title>مصنع الأبيض</title>
  <meta name="twitter:data1" content="admin">
</head>
<body>
  <header>
    <nav>
      <a href="#" id="abyadLanguageButton" class="lang-switch">
        <span>   EN   </span>
      </a>
    </nav>
  </header>
  <main>
    <section class="about-sec">
      <h2>من نحن</h2>
      <p>نحن شركة رائدة في التصدير.</p>
    </section>
  </main>
  <footer>
    <div class="footer-col">
      <h3>من نحن</h3>
      <a href="#" class="footer-en">EN</a>
    </div>
  </footer>
</body>
</html>`;

    const dom = parsePageHtml(html, 'https://elabyad-eg.com/%d9%85%d9%86-%d9%86%d8%ad%d9%86/');
    const footerLink = dom.root.querySelector('a.footer-en');
    assert.ok(footerLink);
    const whereFooter = dom.locate(footerLink);
    assert.equal(whereFooter.sectionAr, 'الفوتر، قسم «من نحن»');
    assert.equal(whereFooter.visibleText, 'EN');
    assert.ok(whereFooter.snippet.length <= 200);
    assert.ok(!whereFooter.snippet.includes('\n'));

    const navLink = dom.root.querySelector('#abyadLanguageButton');
    assert.ok(navLink);
    const whereNav = dom.locate(navLink);
    assert.ok(whereNav.sectionAr.startsWith('القايمة') || whereNav.sectionAr.startsWith('الهيدر'));
    assert.equal(whereNav.visibleText, 'EN');

    const decoded = decodeUrlForDisplay('https://elabyad-eg.com/%d9%85%d9%86-%d9%86%d8%ad%d9%86/');
    assert.equal(decoded, 'https://elabyad-eg.com/من-نحن/');
  });

  test('A2: Template dedupe counts shared header/footer/nav elements across 8 pages ONCE with scope "site-wide" and occurrences = template count', () => {
    const buildPageWithSharedFooter = (pagePath: string) => `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <title>صفحة ${pagePath} - مصنع الأبيض</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="وصف تفصيلي لصفحة ${pagePath} في مصنع الأبيض للمنسوجات والتصدير بأعلى جودة قياسية.">
</head>
<body>
  <header>
    <nav>
      <a href="#" id="abyadLanguageButton" class="lang-btn">EN</a>
    </nav>
  </header>
  <main>
    <h1>عنوان صفحة ${pagePath}</h1>
    <p>محتوى الصفحة رقم ${pagePath} في الموقع.</p>
  </main>
  <footer>
    <h3>تواصل معنا</h3>
    <a href="#" class="social-ig" aria-label="Instagram"><i class="fab fa-instagram"></i></a>
  </footer>
</body>
</html>`;

    const allPageFindings = [];
    for (let i = 1; i <= 8; i++) {
      const pageUrl = i === 1 ? 'https://elabyad-eg.com/' : `https://elabyad-eg.com/page-${i}`;
      const res = runHonestChecks({
        url: pageUrl,
        html: buildPageWithSharedFooter(String(i)),
        status: 200
      });
      allPageFindings.push(...res.allNormalizedFindings);
    }

    const merged = mergeMultiPageFindings(allPageFindings);
    const langFinding = merged.find(f => f.ruleId === 'R003_LANG');
    const socialFinding = merged.find(f => f.ruleId === 'R003_SOCIAL');

    assert.ok(langFinding, 'Expected R003_LANG');
    assert.equal(langFinding.scope, 'site-wide');
    assert.equal(langFinding.occurrences, 1, 'Shared header/nav element must count ONCE (template occurrences), never sum across 8 pages');
    assert.equal(langFinding.pages?.length, 8);
    assert.equal(langFinding.affectedUrls?.length, 8);

    assert.ok(socialFinding, 'Expected R003_SOCIAL');
    assert.equal(socialFinding.scope, 'site-wide');
    assert.equal(socialFinding.occurrences, 1, 'Shared footer social icon must count ONCE, never 8');
    assert.equal(socialFinding.pages?.length, 8);
  });

  test('A3 & D1: Real elabyad-eg.com false positives fixed (R012 pixel/noscript, R013 video poster, RC005 gallery vs brand, R011 WooCommerce sr-only, R003_LANG tiers, RC002 typo vs question, RC004, RC009) and every finding has where.sectionAr', () => {
    const galleryImages = Array.from({ length: 6 }, (_, i) =>
      `<img src="https://elabyad-eg.com/uploads/shirt-angle-${i + 1}.jpg" alt="قميص بولو قطن مصري">`
    ).join('\n');

    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>مصنع الأبيض للملابس الجاهزة والتصدير</title>
  <meta name="description" content="مصنع الأبيض لتصنيع وتصدير الملابس الجاهزة واليونيفورم إلى جميع دول الخليج وأوروبا بأعلى معايير الجودة.">
  <meta name="twitter:data1" content="admin">
  <noscript>
    <img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=123456&ev=PageView&noscript=1" />
  </noscript>
</head>
<body>
  <a class="skip-link screen-reader-text" href="#content">Skip to content</a>
  <header>
    <nav aria-label="القائمة الرئيسية">
      <a href="https://elabyad-eg.com/">الرئيسية</a>
      <a href="#" id="abyadLanguageButton" class="abyad-lang-toggle">EN</a>
      <a href="#" class="social-icon" aria-label="Facebook">FB</a>
    </nav>
  </header>
  <main id="content">
    <section class="hero">
      <h1>مصنع الأبيض للملابس الجاهزة والتصدير</h1>
      <p>نحن في مصنع الأبيض نقوم بتصدير الملابس الجاهزة واليونيفورم إلى المملكة العربية السعودية والإمارات وأوروبا بأعلى جودة.</p>
      <video autoplay muted loop poster="https://elabyad-eg.com/uploads/poster.jpg" src="https://elabyad-eg.com/uploads/hero-with-poster.mp4"></video>
      <video autoplay muted loop src="https://elabyad-eg.com/uploads/process-no-poster.mp4"></video>
      <img src="https://elabyad-eg.com/uploads/pixel.gif" width="1" height="1">
      <img src="https://elabyad-eg.com/uploads/decor.svg" alt="">
      <img src="https://elabyad-eg.com/uploads/icon.svg" role="presentation">
      <img src="https://elabyad-eg.com/uploads/unquoted.jpg" alt=شعار_المصنع>
    </section>
    <section class="woocommerce-product-gallery product-gallery">
      <h2>معرض صور المنتج</h2>
      ${galleryImages}
    </section>
    <section class="order-form">
      <h2>اطلب عينة</h2>
      <form>
        <div class="quantity">
          <label class="screen-reader-text" for="quantity_6789">كمية المنتج</label>
          <input type="number" id="quantity_6789" class="input-text qty text" name="quantity" value="1">
        </div>
        <input type="text" name="company_phone" placeholder="رقم الموبايل للتواصل">
        <input type="submit" value="إرسال">
      </form>
    </section>
  </main>
  <footer>
    <h3>تواصل معنا</h3>
    <p>البريد: <a href="mailto:export@other-company-domain.com">export@other-company-domain.com</a></p>
  </footer>
</body>
</html>`;

    const res = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html,
      status: 200,
      headers: {
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self'"
      },
      ttfbMs: 500
    });

    // D1: Every finding has a non-empty where.sectionAr
    for (const f of res.allNormalizedFindings) {
      assert.ok(f.where, `Finding ${f.ruleId} (${f.id}) is missing 'where'`);
      assert.ok(
        f.where.sectionAr && f.where.sectionAr.trim().length > 0,
        `Finding ${f.ruleId} (${f.id}) has empty where.sectionAr`
      );
    }

    // 1. R012: No false positive on Facebook pixel in <noscript>, 1x1 pixel, alt="", role="presentation", or unquoted alt
    const r012 = res.allNormalizedFindings.find(f => f.ruleId === 'R012');
    assert.equal(r012, undefined, 'R012 must ignore <noscript> pixels, 1x1 pixels, alt="", role=presentation, and unquoted alt');

    // 2. R013 video: ONLY poster-less video in evidence, no "slows mobile loading", recommendation, low
    const r013Video = res.allNormalizedFindings.find(f => f.id === 'f_r013_video_hero');
    assert.ok(r013Video, 'Expected R013 video finding for process-no-poster.mp4');
    assert.equal(r013Video.kind, 'recommendation');
    assert.equal(r013Video.severity, 'low');
    assert.equal(r013Video.affectsVerdict, false);
    assert.ok(
      r013Video.observed.includes('ما قدرتش أقيس تأثيره؛ الأحسن تحط poster وpreload=metadata') ||
        r013Video.recommendedFix.includes('ما قدرتش أقيس تأثيره؛ الأحسن تحط poster وpreload=metadata')
    );
    const videoEvidenceStr = JSON.stringify(r013Video.evidence);
    assert.ok(videoEvidenceStr.includes('process-no-poster.mp4'), 'Must include poster-less video');
    assert.equal(videoEvidenceStr.includes('hero-with-poster.mp4'), false, 'Must NEVER list video that already has poster');
    assert.equal(/بيبطأ تحميل الموبايل|slows mobile loading/i.test(`${r013Video.title} ${r013Video.titleAr} ${r013Video.observed}`), false);

    // 3. RC005: Product title repeated in its own gallery is NOT flagged
    const rc005 = res.allNormalizedFindings.find(f => f.ruleId === 'RC005');
    assert.equal(rc005, undefined, 'Product gallery images sharing product title alt must not trigger RC005');

    // 4. R011: WooCommerce screen-reader-text label is recognized; placeholder-only input is likely/low
    const r011 = res.allNormalizedFindings.find(f => f.ruleId === 'R011');
    assert.ok(r011, 'Expected R011 for placeholder-only input company_phone');
    assert.equal(r011.occurrences, 1, 'WooCommerce quantity input with screen-reader-text label must not be counted as unlabeled');
    assert.equal(r011.confidence, 'likely');
    assert.equal(r011.severity, 'low');

    // 5. R003_LANG Tier (b): #abyadLanguageButton -> suspected_issue, likely, low, needsHumanDecision, + NOT_MEASURED with chipAr='قريبًا'
    const r003Lang = res.allNormalizedFindings.find(f => f.ruleId === 'R003_LANG');
    assert.ok(r003Lang, 'Expected R003_LANG for #abyadLanguageButton');
    assert.equal(r003Lang.kind, 'suspected_issue');
    assert.equal(r003Lang.confidence, 'likely');
    assert.equal(r003Lang.severity, 'low');
    assert.equal(r003Lang.needsHumanDecision, true);
    assert.equal(r003Lang.affectsVerdict, false);
    assert.ok(
      r003Lang.observed.includes('ما قدرتش أتأكد من غير ما أضغط عليه في متصفح حقيقي. جرّب بنفسك: اضغط EN، لو الصفحة ما اتغيرتش يبقى مش شغال.')
    );
    const nmLang = res.notMeasured.find(nm => nm.checkId === 'R003_LANG');
    assert.ok(nmLang, 'Expected NOT_MEASURED entry for R003_LANG click verification');
    assert.equal(nmLang.chipAr, 'قريبًا');

    // 6. R003_SOCIAL: low, likely
    const r003Social = res.allNormalizedFindings.find(f => f.ruleId === 'R003_SOCIAL');
    assert.ok(r003Social);
    assert.equal(r003Social.severity, 'low');
    assert.equal(r003Social.confidence, 'likely');

    // 7. RC004: low, recommendation, where on <meta> in <head>
    const rc004 = res.allNormalizedFindings.find(f => f.ruleId === 'RC004');
    assert.ok(rc004);
    assert.equal(rc004.severity, 'low');
    assert.equal(rc004.kind, 'recommendation');
    assert.equal(rc004.affectsVerdict, false);
    assert.ok(rc004.where?.selector.includes('meta'));

    // 8. RC009: recommendation, affectsVerdict=false, clean full sentence quote without "Skip to content"
    const rc009 = res.allNormalizedFindings.find(f => f.ruleId === 'RC009');
    assert.ok(rc009);
    assert.equal(rc009.kind, 'recommendation');
    assert.equal(rc009.affectsVerdict, false);
    const quoteVal = rc009.evidence[0]?.value || '';
    assert.equal(quoteVal.includes('Skip to content'), false, 'RC009 quote must never concatenate Skip to content');
    assert.ok(quoteVal.includes('بتصدير الملابس الجاهزة'));

    // 9. RC002: question only (recommendation, low, likely, affectsVerdict=false, needsHumanDecision=true)
    const rc002 = res.allNormalizedFindings.find(f => f.ruleId === 'RC002');
    assert.ok(rc002);
    assert.equal(rc002.kind, 'recommendation');
    assert.equal(rc002.severity, 'low');
    assert.equal(rc002.confidence, 'likely');
    assert.equal(rc002.needsHumanDecision, true);
    assert.equal(rc002.affectsVerdict, false);
    assert.equal(rc002.observed.includes('احتمال غلطة كتابة'), false, 'Distant domain should not escalate to typo');

    // 10. Verdict is ready_with_notes (NOT driven by RC009, RC004, R003_LANG, RC005, RC002)
    const verdict = computeVerdict({
      findings: res.findings,
      passes: res.passes,
      notMeasured: res.notMeasured,
      profile: res.profile
    });
    assert.equal(verdict.level, 'ready_with_notes');
  });

  test('A3 (R003_LANG Tier a & RC002 Levenshtein typo): GTranslate/WPML produces PASS and no finding; Levenshtein <=2 escalates RC002 to typo', () => {
    const htmlWithGTranslateAndTypoEmail = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <title>مصنع الأبيض</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="مصنع الأبيض للملابس الجاهزة والتصدير لجميع الأسواق العالمية والعربية بأعلى جودة.">
  <script src="https://cdn.gtranslate.net/widgets/latest/float.js" defer></script>
</head>
<body>
  <header>
    <nav>
      <a href="#" class="glink nturl notranslate" onclick="doGTranslate('ar|en');return false;">EN</a>
    </nav>
  </header>
  <main>
    <h1>مصنع الأبيض</h1>
    <p>تواصل معنا عبر الإيميل: <a href="mailto:info@elabyad-egg.com">info@elabyad-egg.com</a></p>
  </main>
</body>
</html>`;

    const res = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: htmlWithGTranslateAndTypoEmail,
      status: 200
    });

    assert.equal(
      res.allNormalizedFindings.some(f => f.ruleId === 'R003_LANG'),
      false,
      'Tier (a): Known translation widget (GTranslate) must not produce R003_LANG finding'
    );
    assert.equal(
      res.passes.some(p => p.ruleId === 'R003_LANG'),
      true,
      'Tier (a): Known translation widget must add a PASS item'
    );

    const rc002 = res.allNormalizedFindings.find(f => f.ruleId === 'RC002');
    assert.ok(rc002);
    assert.ok(
      rc002.observed.includes('احتمال غلطة كتابة') || (rc002.titleAr || '').includes('احتمال غلطة كتابة'),
      'Levenshtein distance 1 (elabyad-egg.com vs elabyad-eg.com) must escalate to احتمال غلطة كتابة'
    );
  });

  test('A4 & K1.5: Arabic plural grammar helper formats ملاحظة واحدة, ملاحظتين (without digit 2), 3-10 ملاحظات, 11+ ملاحظة', () => {
    assert.equal(formatArabicNoteCount(1), 'ملاحظة واحدة');
    assert.equal(formatArabicNoteCount(2), 'ملاحظتين');
    assert.equal(formatArabicNoteCount(3), '3 ملاحظات');
    assert.equal(formatArabicNoteCount(10), '10 ملاحظات');
    assert.equal(formatArabicNoteCount(11), '11 ملاحظة');
    assert.equal(formatArabicNoteCount(25), '25 ملاحظة');
  });

  test('A5: ScanResult omits fake fields (limits.maxLighthousePages, interactionStatesTested) and sets status="completed" when all planned pages finish', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="ar"><head><title>اختبار A5</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>مرحبا بكم في موقع الاختبار</h1><p>' + 'نص تجريبي كافي للفحص المباشر. '.repeat(15) + '</p></body></html>');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const provider = new LiveProvider();
      const result = await provider.runScan(
        'scan_a5_test',
        { url: `http://127.0.0.1:${port}/fixtures/home`, locale: 'ar-EG' },
        () => {}
      );
      assert.equal(result.status, 'completed', 'Status must be completed when all planned work finished even without PSI');
      assert.equal('maxLighthousePages' in result.limits, false, 'limits.maxLighthousePages must be removed');
      assert.equal('interactionStatesTested' in result, false, 'interactionStatesTested must be removed');
    } finally {
      server.close();
    }
  });

  test('A6: RC006 detects hype/emoji tone on B2B site (llm_judgment, low, verbatim quote, needsHumanDecision) and RC007 detects missing trust signals', () => {
    const b2bHypeHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <title>مصنع النور للتوريدات الصناعية وخطوط الإنتاج</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="مصنع النور لتصنيع وتوريد خطوط الإنتاج والمعدات الصناعية للمصانع والشركات.">
</head>
<body>
  <main>
    <h1>مصنع النور لتصنيع خطوط الإنتاج الصناعية</h1>
    <p>🔥🔥 أقوى عرض في التاريخ وأحسن مصنع رقم 1 في العالم بضمان 100% خصم خيالي 🚀💥</p>
  </main>
  <footer>
    <p>جميع الحقوق محفوظة</p>
  </footer>
</body>
</html>`;

    const res = runHonestChecks({
      url: 'https://alnoor-factory.eg/',
      html: b2bHypeHtml,
      status: 200
    });

    const rc006Tone = res.allNormalizedFindings.find(f => f.id === 'f_rc006_b2b_tone');
    assert.ok(rc006Tone, 'Expected RC006 B2B hype/emoji tone finding');
    assert.equal(rc006Tone.ruleId, 'RC006');
    assert.equal(rc006Tone.method, 'llm_judgment');
    assert.equal(rc006Tone.severity, 'low');
    assert.equal(rc006Tone.needsHumanDecision, true);
    assert.equal(rc006Tone.affectsVerdict, false);
    assert.ok(rc006Tone.evidence[0]?.value?.includes('أقوى عرض في التاريخ'));

    const rc007Trust = res.allNormalizedFindings.find(f => f.id === 'f_rc007_trust_signals');
    assert.ok(rc007Trust, 'Expected RC007 missing trust signals finding');
    assert.equal(rc007Trust.ruleId, 'RC007');
    assert.equal(rc007Trust.kind, 'recommendation');
    assert.equal(rc007Trust.severity, 'low');
    assert.equal(rc007Trust.affectsVerdict, false);
  });

  test('B1, B2, B3, B4: Recorded PSI fixture extracts LCP element + top 3 opportunities, caps lab-only severity at medium, and shows seoScore >= 90 as lab pass', async () => {
    const psiOutcome = await fetchPsiMetricsIfAvailable(
      'https://elabyad-eg.com/',
      5000,
      undefined,
      {
        apiKey: 'TEST_ONLY_STUB_KEY',
        fetchImpl: async () =>
          new Response(JSON.stringify(RECORDED_PSI_ELABYAD_FIXTURE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      }
    );

    assert.ok(psiOutcome.data);
    assert.ok(psiOutcome.data.lcpElement, 'Must extract lcpElement from lcp-breakdown-insight');
    assert.equal(
      psiOutcome.data.lcpElement?.selector,
      'div.elementor > div.elementor-element > div.elementor-element > section.abyad-pattern-hero'
    );
    assert.equal(psiOutcome.data.lcpElement?.snippet, '<section class="abyad-pattern-hero">');
    assert.equal(psiOutcome.data.topOpportunities?.length, 3, 'Must extract top 3 opportunities ranked by savings');
    assert.equal(psiOutcome.data.topOpportunities?.[0]?.id, 'image-delivery-insight');
    assert.equal(psiOutcome.data.topOpportunities?.[1]?.id, 'render-blocking-insight');
    assert.equal(psiOutcome.data.topOpportunities?.[2]?.id, 'cache-insight');

    const sampleHtml = `<!DOCTYPE html><html lang="ar"><head><title>مصنع الأبيض</title><meta name="description" content="مصنع الأبيض للملابس الجاهزة والتصدير لجميع الأسواق بأعلى جودة."></head><body><main><section class="abyad-pattern-hero"><h1>مصنع الأبيض للملابس التصدير</h1></section></main></body></html>`;
    const checkRes = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: sampleHtml,
      psiData: psiOutcome.data
    });

    const lcpFinding = checkRes.allNormalizedFindings.find(f => f.id === 'f_perf_mobile_grouped');
    assert.ok(lcpFinding);
    // B1 & P2b.3: Lab-only metrics (no CrUX field data) are grouped in "الأداء على الموبايل", include lab notice, and capped at severity medium
    assert.equal(lcpFinding.severity, 'medium', 'Lab-only LCP without field data must be capped at medium severity');
    assert.equal(lcpFinding.titleAr, 'الأداء على الموبايل');
    assert.ok(lcpFinding.observed.includes('ده قياس معملي، مش بالضرورة اللي زوارك الحقيقيين بيشوفوه'));
    // B2: Mention LCP element ("العنصر اللي بيعطّل: ...") and include top opportunities in evidence
    assert.ok(lcpFinding.observed.includes('العنصر اللي بيعطّل:'), 'Finding text must mention العنصر اللي بيعطّل');
    assert.ok(lcpFinding.observed.includes('abyad-pattern-hero'));
    assert.ok(lcpFinding.where?.selector.includes('abyad-pattern-hero'));
    const evJson = JSON.stringify(lcpFinding.evidence);
    assert.ok(evJson.includes('Improve image delivery'));
    assert.ok(evJson.includes('Render-blocking requests'));

    // B3: seoScore >= 90 shown as PASS note labeled as lab data
    const seoPass = checkRes.passes.find(p => p.id === 'pass_psi_seo');
    assert.ok(seoPass, 'Expected pass_psi_seo when seoScore >= 90');
    assert.ok(seoPass.titleAr.includes('100') && seoPass.titleAr.includes('قياس معملي'));
  });

  test('C1: With only GLM_API_KEY set and GEMINI_API_KEY unset, no Gemini call is attempted and AI features report "غير مفعّلة"', async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGlm = process.env.GLM_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      process.env.GLM_API_KEY = 'glm_secret_should_never_be_used_as_gemini_999';

      const caps = await detectCapabilities({ forceRefresh: true, skipNetworkProbe: true });
      assert.equal(caps.geminiStructuredOutput, false, 'GLM_API_KEY must NOT enable geminiStructuredOutput');

      const reply = await askMadamAfaf('اشرحيلي حالة الموقع بالتفصيل', {
        domain: 'elabyad-eg.com',
        verdictLabelAr: 'جاهز بملاحظات'
      });
      assert.ok(reply.includes('غير مفعّلة'), `Expected reply to mention غير مفعّلة when GEMINI_API_KEY is unset, got: ${reply}`);
      assert.equal(reply.includes('glm_secret_should_never_be_used_as_gemini_999'), false);
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevGlm === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = prevGlm;
      await detectCapabilities({ forceRefresh: true, skipNetworkProbe: true });
    }
  });

  test('C3 & C4: VISITOR_ID_SALT enforces >=32 chars in production and config:check prints table without values and warns on unused env vars', () => {
    // C3: empty/whitespace treated as missing; production requires >=32 chars
    assert.throws(
      () => validateVisitorIdSalt({ NODE_ENV: 'production', VISITOR_ID_SALT: '   ' }),
      /VISITOR_ID_SALT/
    );
    assert.throws(
      () => validateVisitorIdSalt({ NODE_ENV: 'production', VISITOR_ID_SALT: 'short_salt_123' }),
      /32/
    );
    const validProd = validateVisitorIdSalt({
      NODE_ENV: 'production',
      VISITOR_ID_SALT: 'a_very_long_production_visitor_salt_with_at_least_32_chars'
    });
    assert.equal(validProd.valid, true);

    const cloudRunEnv: Record<string, string | undefined> = { NODE_ENV: 'production' };
    const ensured = ensureRuntimeVisitorIdSalt(cloudRunEnv);
    assert.equal(ensured.provisionedEphemeral, true);
    assert.equal(validateVisitorIdSalt(cloudRunEnv).valid, true);

    // C4: config:check report prints table without values and warns about unused GLM_*/LIGHTHOUSE_*/MAX_* vars
    const fakeSecretVal = 'SUPER_SECRET_VALUE_DO_NOT_PRINT_777';
    const report = buildConfigCheckReport({
      GEMINI_API_KEY: fakeSecretVal,
      PSI_API_KEY: fakeSecretVal,
      GLM_API_KEY: fakeSecretVal,
      LIGHTHOUSE_MAX_PAGES: '3',
      MAX_PAGES_PER_SCAN: '10'
    });

    assert.equal(report.text.includes(fakeSecretVal), false, 'Config report must NEVER include env values');
    assert.ok(report.text.includes('GEMINI_API_KEY'));
    assert.ok(report.text.includes('PSI_API_KEY'));
    assert.ok(report.warnings.some(w => w.includes('GLM_API_KEY') && w.includes('متغير موجود ومش مستخدم')));
    assert.ok(report.warnings.some(w => w.includes('LIGHTHOUSE_MAX_PAGES') && w.includes('متغير موجود ومش مستخدم')));
    assert.ok(report.warnings.some(w => w.includes('MAX_PAGES_PER_SCAN') && w.includes('متغير موجود ومش مستخدم')));
  });
});
