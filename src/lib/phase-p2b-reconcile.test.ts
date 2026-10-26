import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  runHonestChecks,
  computeVerdict,
  WHY_IT_MATTERS_TEMPLATES_AR,
  PsiMeasurement
} from './honest-checks';
import { buildSiteProfile } from './site-profiler';
import { getPlatformLabelAr, buildPlatformAwareRepairPack } from './platform-adapter';

test('PHASE P2b: Trust & Accuracy Suite', async (t) => {
  const lovableShellHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lovable React App</title>
  <meta name="description" content="Lovable client-only React application shell" />
  <noscript>You need to enable JavaScript to run this modern interactive React application.</noscript>
  <script type="module" crossorigin src="/assets/index-D123.js"></script>
</head>
<body>
  <div id="root"></div>
  <script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script>
</body>
</html>`;

  await t.test('P2b.1: Bug Reproduction & Fix — React SPA shell with rendered H1 in PSI must NOT emit confirmed defect for missing H1', () => {
    const psiData: PsiMeasurement = {
      lcpMs: 1800,
      cls: 0.02,
      performanceScore: 92,
      lcpElement: {
        type: 'h1',
        nodeLabel: 'h1.hero-title',
        snippet: '<h1>Welcome to Lovable</h1>'
      },
      renderedAudits: {
        hasRenderedH1: true,
        renderedH1Text: 'Welcome to Lovable',
        headingOrder: { id: 'heading-order', passed: true }
      }
    };

    const profile = buildSiteProfile({
      html: lovableShellHtml,
      url: 'https://xlans.lovable.app',
      headers: {}
    });

    // Profile must be identified as ai_builder (or spa), not static_html
    assert.ok(
      profile.platform === 'ai_builder' || profile.platform === 'spa',
      'Lovable shell with <div id="root"></div> and bundle script must be classified as ai_builder or spa'
    );

    const out = runHonestChecks({
      html: lovableShellHtml,
      url: 'https://xlans.lovable.app',
      status: 200,
      headers: {},
      ttfbMs: 120,
      profile,
      psiData
    });

    const confirmedNoH1 = out.findings.find(
      f => f.ruleId === 'RC010' && f.kind === 'confirmed_defect'
    );
    assert.equal(confirmedNoH1, undefined, 'Must NEVER emit confirmed defect for missing H1 when rendered evidence shows H1');

    // If static lacks H1 but rendered has H1, must emit discrepancy finding
    const discrepancy = out.findings.find(
      f => f.titleAr?.includes('اختلاف بين مصدر الصفحة والصفحة المعروضة') || f.title?.includes('Discrepancy')
    );
    assert.ok(discrepancy, 'Must emit discrepancy finding naming both static HTML and rendered observation');
    assert.equal(discrepancy.kind, 'suspected_issue');
    assert.equal(discrepancy.affectsVerdict, false);
    assert.equal(discrepancy.confidence, 'likely');
  });

  await t.test('P2b.2: Cause-to-fix rule — Every fix cites evidence id, LCP element guides specific fix', () => {
    // Case 1: LCP element is a Video
    const videoPsi: PsiMeasurement = {
      lcpMs: 4200,
      cls: 0.05,
      performanceScore: 55,
      lcpElement: {
        type: 'video',
        nodeLabel: 'video#hero-video',
        snippet: '<video src="hero.mp4" autoplay loop></video>'
      }
    };

    const outVideo = runHonestChecks({
      html: `<html><body><video src="hero.mp4"></video></body></html>`,
      url: 'https://video-example.com',
      status: 200,
      headers: {},
      ttfbMs: 100,
      psiData: videoPsi
    });

    const perfFindingVideo = outVideo.findings.find(f => f.category === 'performance');
    assert.ok(perfFindingVideo, 'Must have a grouped performance finding');
    assert.ok(
      perfFindingVideo.recommendedFix.includes('poster') || perfFindingVideo.recommendedFix.includes('فيديو'),
      'Fix for video LCP must guide poster and video optimization'
    );
    assert.ok(perfFindingVideo.evidence.length > 0 && perfFindingVideo.evidence[0].id, 'Evidence items must carry an id');

    // Case 2: LCP element is text (h1/p)
    const textPsi: PsiMeasurement = {
      lcpMs: 3800,
      cls: 0.02,
      performanceScore: 62,
      lcpElement: {
        type: 'h1',
        nodeLabel: 'h1.headline',
        snippet: '<h1>Fast delivery across Egypt</h1>'
      }
    };

    const outText = runHonestChecks({
      html: `<html><body><h1>Fast delivery across Egypt</h1></body></html>`,
      url: 'https://text-example.com',
      status: 200,
      headers: {},
      ttfbMs: 300,
      psiData: textPsi
    });

    const perfFindingText = outText.findings.find(f => f.category === 'performance');
    assert.ok(perfFindingText, 'Must have grouped performance finding for text LCP');
    assert.ok(
      perfFindingText.recommendedFix.includes('font-display') || perfFindingText.recommendedFix.includes('الخط') || perfFindingText.recommendedFix.includes('CSS'),
      'Fix for text LCP must guide font loading, render-blocking CSS/JS, or server response'
    );
  });

  await t.test('P2b.3: Performance is ONE grouped finding "الأداء على الموبايل" with measurements table', () => {
    const psiData: PsiMeasurement = {
      lcpMs: 3200,
      cls: 0.15,
      tbtMs: 350,
      fcpMs: 1500,
      performanceScore: 58,
      lcpElement: {
        type: 'img',
        nodeLabel: 'img.hero',
        snippet: '<img src="hero.jpg">'
      },
      topOpportunities: [
        { id: 'render-blocking-resources', title: 'Eliminate render-blocking resources', savingsMs: 450 }
      ]
    };

    const out = runHonestChecks({
      html: `<html><body><img src="hero.jpg"></body></html>`,
      url: 'https://perf-test.com',
      status: 200,
      headers: {},
      ttfbMs: 400,
      psiData
    });

    const perfFindings = out.findings.filter(f => f.category === 'performance');
    assert.equal(perfFindings.length, 1, 'Performance must be ONE grouped finding instead of multiple scattered findings');
    assert.equal(perfFindings[0].titleAr, 'الأداء على الموبايل');
    assert.ok(perfFindings[0].observed.includes('TTFB'), 'Observed text must include measurements table with TTFB');
    assert.ok(perfFindings[0].observed.includes('LCP'), 'Observed text must include LCP');
    assert.ok(perfFindings[0].observed.includes('CLS'), 'Observed text must include CLS');
    assert.ok(perfFindings[0].observed.includes('TBT'), 'Observed text must include TBT');
    assert.ok(
      perfFindings[0].observed.includes('ده قياس معملي، مش بالضرورة اللي زوارك الحقيقيين بيشوفوه') ||
      perfFindings[0].evidence.some(e => (e.value || '').includes('قياس معملي')),
      'Must state that lab measurement is not necessarily what real visitors experience when no CrUX data'
    );
  });

  await t.test('P2b.4: Technology label requires >= 2 independent signals and confidence >= medium, never Static HTML', () => {
    // Low confidence or single signal: must return "لم نتمكن من تحديد التقنية المستخدمة"
    const uncertainProfile = {
      platform: 'custom',
      confidenceLevel: 'low' as const,
      confidenceScore: 0.3,
      signals: ['Single minor marker']
    };
    assert.equal(
      getPlatformLabelAr(uncertainProfile as any),
      'لم نتمكن من تحديد التقنية المستخدمة'
    );

    // Static HTML platform must NEVER be displayed as a technology name
    const staticProfile = {
      platform: 'static_html',
      confidenceLevel: 'medium' as const,
      confidenceScore: 0.75,
      signals: ['Server-rendered / Static HTML markup']
    };
    assert.equal(
      getPlatformLabelAr(staticProfile as any),
      'لم نتمكن من تحديد التقنية المستخدمة',
      'Never show Static HTML or Server HTML as a technology'
    );

    // WordPress with 2 signals
    const wpProfile = {
      platform: 'wordpress',
      confidenceLevel: 'high' as const,
      confidenceScore: 0.95,
      signals: ['WordPress generator meta', 'wp-content path marker']
    };
    assert.ok(getPlatformLabelAr(wpProfile as any).includes('ووردبريس'));
  });

  await t.test('P2b.5: Severity tuning — H1 rule is low, never medium; performance score alone never creates finding', () => {
    const staticOut = runHonestChecks({
      html: `<html><head><title>No H1 Page</title></head><body><p>Some text</p></body></html>`,
      url: 'https://noh1.com',
      status: 200,
      headers: {},
      ttfbMs: 100
    });

    const h1Finding = staticOut.findings.find(f => f.ruleId === 'RC010');
    if (h1Finding) {
      assert.equal(h1Finding.severity, 'low', 'H1 rule severity must be low, never medium');
      assert.equal(h1Finding.affectsVerdict, false, 'Low H1 rule must not affect verdict');
    }

    // Good metrics but low score: score alone must NEVER create a finding
    const scoreOnlyPsi: PsiMeasurement = {
      lcpMs: 1800, // Good
      cls: 0.02,   // Good
      tbtMs: 80,    // Good
      performanceScore: 68 // Moderate score due to unused CSS, but metrics pass
    };
    const scoreOnlyOut = runHonestChecks({
      html: `<html><body><h1>Good Core Vitals</h1></body></html>`,
      url: 'https://scoreonly.com',
      status: 200,
      headers: {},
      ttfbMs: 150,
      psiData: scoreOnlyPsi
    });
    const perfFindings = scoreOnlyOut.findings.filter(f => f.category === 'performance');
    assert.equal(perfFindings.length, 0, 'Performance score alone must never create a finding when metrics are good');
  });

  await t.test('P2b.6: Rule RX001 — WhatsApp link format validation', () => {
    const htmlWithBadWa = `<!DOCTYPE html>
<html>
<body>
  <a href="https://wa.me/01012345678">واتساب محلي بدون كود الدولة</a>
  <a href="https://wa.me/+201123456789">واتساب مع زائد</a>
  <a href="https://api.whatsapp.com/send?phone=00201234567890">واتساب مع أصفار</a>
</body>
</html>`;

    const out = runHonestChecks({
      html: htmlWithBadWa,
      url: 'https://bad-wa.com',
      status: 200,
      headers: {},
      ttfbMs: 100
    });

    const rx001 = out.findings.find(f => f.ruleId === 'RX001');
    assert.ok(rx001, 'Rule RX001 must be emitted for WhatsApp link format violations');
    assert.equal(rx001.severity, 'medium');
    assert.equal(rx001.kind, 'confirmed_defect');
    assert.ok(rx001.titleAr?.includes('واتساب'));
    assert.ok(rx001.observed.includes('الرقم مش بصيغة واتساب الموثّقة'));
    assert.ok(rx001.recommendedFix.includes('https://wa.me/201012345678'), 'Fix must provide the corrected international link');

    // Must add NOT_MEASURED "مش بنتأكد إن الرقم عليه واتساب فعلًا"
    const nmWa = out.notMeasured.find(nm => nm.checkId === 'RX001_ACTIVE' || nm.id?.includes('rx001'));
    assert.ok(nmWa, 'Must add NOT_MEASURED stating we do not check if number actually has WhatsApp active');
    assert.ok(nmWa.reasonAr.includes('مش بنتأكد إن الرقم عليه واتساب فعلًا'));
  });

  await t.test('P2b.7: Rule RX002 — Broken images detection via HEAD 404', () => {
    const out = runHonestChecks({
      html: `<html><body><img src="https://example.com/broken.jpg" alt="test"><img src="https://example.com/ok.jpg" alt="ok"></body></html>`,
      url: 'https://example.com',
      status: 200,
      headers: {},
      ttfbMs: 100,
      sampledImageSizes: [
        { url: 'https://example.com/ok.jpg', bytes: 45000 },
        { url: 'https://example.com/broken.jpg', bytes: 0, broken: true, status: 404 }
      ]
    });

    const rx002 = out.findings.find(f => f.ruleId === 'RX002');
    assert.ok(rx002, 'Rule RX002 must trigger when sampled image returns 404');
    assert.equal(rx002.severity, 'medium');
    assert.equal(rx002.kind, 'confirmed_defect');
    assert.equal(rx002.confidence, 'confirmed');
    assert.ok(rx002.titleAr?.includes('صور مكسورة') || rx002.titleAr?.includes('404'));
    assert.ok(rx002.evidence.some(e => e.value?.includes('https://example.com/broken.jpg')));
  });

  await t.test('P2b.8 & P2b.9: Honest limits box, security label, summary counters, deterministic whyItMattersAr, and repair prompt structure', () => {
    const verdictReady = computeVerdict({ findings: [], passes: [], notMeasured: [] });
    assert.equal(verdictReady.labelAr, 'مفيش مشاكل مؤكدة كبيرة في العينة');

    // Every template in WHY_IT_MATTERS_TEMPLATES_AR is non-empty Arabic text
    assert.ok(WHY_IT_MATTERS_TEMPLATES_AR.R001.includes('الزائر هيوصل لصفحة مش موجودة'));
    assert.ok(WHY_IT_MATTERS_TEMPLATES_AR.RX001.includes('العميل اللي يضغط ممكن ما يلاقيش محادثة تفتح'));
    assert.ok(WHY_IT_MATTERS_TEMPLATES_AR.R013_PERF.includes('الزائر ممكن يستنى قبل ما يشوف المحتوى الأساسي؛ والقياس معملي'));

    const reportViewSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    assert.ok(reportViewSrc.includes('حدود الفحص'), 'ReportView must include حدود الفحص box');
    assert.ok(reportViewSrc.includes('فحوصات أمان أساسية (من الواجهة العامة)'), 'Security category must be renamed');
    assert.ok(reportViewSrc.includes('مؤكدة ('), 'Summary counter must show مؤكدة');
    assert.ok(reportViewSrc.includes('محتاجة تحقق ('), 'Summary counter must show محتاجة تحقق');
    assert.ok(reportViewSrc.includes('فحوصات عدّت ('), 'Summary counter must show فحوصات عدّت');
    assert.ok(reportViewSrc.includes('ما اتقاستش ('), 'Summary counter must show ما اتقاستش');
    assert.ok(reportViewSrc.includes('من عينة'), 'Summary must include من عينة N صفحات');
    assert.ok(reportViewSrc.includes('ليه ده يهمك؟'), 'Finding card must show ليه ده يهمك؟');

    const pack = buildPlatformAwareRepairPack({
      requestedUrl: 'https://example.com',
      profile: { platform: 'spa', confidenceLevel: 'high', confidenceScore: 0.9, signals: ['React root', 'Vite module'] } as any,
      findings: [
        {
          id: 'f1',
          ruleId: 'R008',
          category: 'seo',
          title: 'Missing title',
          titleAr: 'عنوان ناقص',
          kind: 'confirmed_defect',
          severity: 'high',
          confidence: 'confirmed',
          source: 'rule',
          url: 'https://example.com',
          occurrences: 1,
          observed: 'No title',
          steps: [],
          evidence: [{ type: 'snippet', value: '<title></title>', ref: '<title>' }],
          recommendedFix: 'Add title'
        },
        {
          id: 'f2',
          ruleId: 'RC010_RECONCILE',
          category: 'seo',
          title: 'Discrepancy',
          titleAr: 'اختلاف بين مصدر الصفحة والصفحة المعروضة',
          kind: 'suspected_issue',
          severity: 'low',
          confidence: 'likely',
          source: 'rule',
          url: 'https://example.com',
          occurrences: 1,
          observed: 'Static vs rendered',
          steps: [],
          evidence: [{ type: 'snippet', value: '0 h1', ref: '0 h1' }],
          recommendedFix: 'Check SSR'
        }
      ]
    });

    assert.ok(pack.masterPrompt.includes('المشاكل المؤكدة'), 'Master prompt must include confirmed section');
    assert.ok(pack.masterPrompt.includes('محتاج تحقق'), 'Master prompt must include separate محتاج تحقق section when suspected items are passed');
    assert.ok(pack.masterPrompt.includes('أعد الاختبار واكتب إيه اللي اتغير'), 'Master prompt must end with أعد الاختبار واكتب إيه اللي اتغير');
  });
});
