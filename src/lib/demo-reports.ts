/**
 * MOCK Sample Reports for 1-Click Preview on the Landing Screen (PHASE P3.1).
 * Truthfulness Protocol Rule 3:
 * "Mock data is labeled MOCK in code and in UI. Mock is never shown as a real scan."
 */
import { Finding, NotMeasuredItem, PassItem, ScanResult, SiteProfile } from '../types/contract';
import { computeVerdict, evaluateAiClaims } from './honest-checks';
import { buildRepairPrompts } from './repair-prompt-builder';

export interface MockDemoReportEntry {
  id: 'wordpress_b2b' | 'spa_ai_built';
  labelAr: string;
  subtitleAr: string;
  report: ScanResult;
}

function createWordPressB2bMockReport(): ScanResult {
  const requestedUrl = 'https://mock-b2b-factory.example.com/';
  const startedAt = '2026-10-25T08:00:00.000Z';
  const finishedAt = '2026-10-25T08:00:12.000Z';

  const siteProfile: SiteProfile = {
    type: 'standard',
    confidence: 0.95,
    signals: ['WordPress generator meta tag', '/wp-content/themes/ marker', 'Elementor CSS classes'],
    platform: 'wordpress',
    builder: 'elementor',
    version: '6.6',
    confidenceLevel: 'high',
    isCodeRepoPlatform: false,
    language: 'ar',
    direction: 'rtl',
    arabicRatio: 0.88,
    siteType: 'b2b_manufacturer',
    siteTypeReason: 'كلمات مفتاحية للتصنيع والتصدير وطلب عرض سعر',
    primaryConversion: {
      type: 'whatsapp',
      inTopOfPage: true,
      evidence: '<a href="https://wa.me/01012345678">تواصل واتساب لطلبات التصدير</a>'
    },
    markets: {
      countriesOrRegions: ['مصر', 'السعودية'],
      hasExportClaims: true,
      hasAlternateLanguage: false
    }
  };

  const findings: Finding[] = [
    {
      id: 'mock_f_rx001',
      ruleId: 'RX001',
      category: 'links',
      title: 'WhatsApp link uses local phone format without country code',
      titleAr: 'رابط واتساب مكتوب برقم محلي من غير كود الدولة',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      method: 'static_html',
      affectsVerdict: true,
      needsHumanDecision: false,
      scope: 'site-wide',
      pages: [requestedUrl, `${requestedUrl}contact`],
      where: {
        pageUrl: requestedUrl,
        sectionAr: 'الهيدر (أعلى الصفحة)',
        visibleText: 'تواصل واتساب لطلبات التصدير',
        selector: 'header a[href*="wa.me"]',
        snippet: '<a href="https://wa.me/01012345678" class="btn-wa">تواصل واتساب لطلبات التصدير</a>'
      },
      source: 'rule',
      url: requestedUrl,
      occurrences: 2,
      observed:
        'الرقم مش بصيغة واتساب الموثّقة (مكتوب برقم محلي يبدأ بـ 010 من غير كود الدولة 20)، فمش هيفتح محادثة صح.',
      expected: 'روابط wa.me لازم تبدأ بكود الدولة الدولي من غير + أو أصفار في الأول (مثال: 201012345678).',
      whyItMattersAr:
        'العميل اللي يضغط على زرار واتساب عشان يطلب عرض سعر ممكن تطلعله رسالة رقم غير صحيح وتضيع الفرصة البيعية.',
      steps: [
        'افتح الصفحة الرئيسية واضغط على زرار «تواصل واتساب لطلبات التصدير» في الهيدر.',
        'لاحظ إن الرابط في المتصفح رايح لـ wa.me/01012345678 من غير كود مصر 20.'
      ],
      evidence: [
        {
          id: 'EV-RX001-1',
          type: 'snippet',
          value: '<a href="https://wa.me/01012345678" class="btn-wa">تواصل واتساب لطلبات التصدير</a>',
          ref: 'header a[href*="wa.me"]',
          method: 'static_html'
        }
      ],
      recommendedFix:
        'في Elementor افتح قالب الهيدر (Header Template) وعدّل رابط زرار الواتساب ليصبح https://wa.me/201012345678 (استناداً إلى الدليل [EV-RX001-1]).'
    },
    {
      id: 'mock_f_r013',
      ruleId: 'R013',
      category: 'performance',
      title: 'Mobile performance slow LCP',
      titleAr: 'الأداء على الموبايل',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'psi',
      affectsVerdict: true,
      needsHumanDecision: false,
      scope: 'page',
      where: {
        pageUrl: requestedUrl,
        sectionAr: 'أول الشاشة (Hero Section)',
        visibleText: 'مصنع النيل للتعبئة والتغليف والتصدير',
        selector: 'img.elementor-hero-bg',
        snippet: '<img src="/wp-content/uploads/factory-banner-uncompressed.png" class="elementor-hero-bg">'
      },
      source: 'lighthouse',
      url: requestedUrl,
      occurrences: 1,
      observed:
        'جدول قياسات الموبايل: TTFB: 420ms | FCP: 2.1s | LCP: 4.8s | CLS: 0.03 | TBT: 290ms — ده قياس معملي، مش بالضرورة اللي زوارك الحقيقيين بيشوفوه.',
      expected: 'ظهور أكبر عنصر في الصفحة (LCP) في أقل من 2.5 ثانية على الموبايل.',
      whyItMattersAr:
        'الزائر اللي بيفتح من باقة الموبايل ممكن يستنى قدام شاشة بيضاء قبل ما يشوف صورة المصنع الأساسية؛ والقياس معملي.',
      steps: [
        'افتح PageSpeed Insights وحلل الصفحة الرئيسية على وضع الموبايل.',
        'راجع عنصر Largest Contentful Paint هتلاقيه صورة البانر بصيغة PNG وحجمها كبير.'
      ],
      evidence: [
        {
          id: 'EV-PERF-1',
          type: 'measurement',
          value: 'LCP: 4800ms (img.elementor-hero-bg) | TTFB: 420ms | CLS: 0.03 | TBT: 290ms (قياس معملي)',
          ref: 'img.elementor-hero-bg',
          method: 'psi'
        }
      ],
      recommendedFix:
        'حوّل صورة البانر في مكتبة وسائط ووردبريس إلى صيغة WebP بحجم أقل من 180KB مع إضافة fetchpriority="high" (استناداً إلى الدليل [EV-PERF-1]).'
    },
    {
      id: 'mock_f_rc005',
      ruleId: 'RC005',
      category: 'content',
      title: 'Lorem ipsum placeholder text left on About page',
      titleAr: 'نص تجريبي (Lorem Ipsum) منسي في صفحة من نحن',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'static_html',
      affectsVerdict: true,
      needsHumanDecision: false,
      scope: 'page',
      where: {
        pageUrl: `${requestedUrl}about`,
        sectionAr: 'المحتوى الرئيسي — قسم رؤية الشركة',
        visibleText: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit',
        selector: 'section#vision p',
        snippet: '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper.</p>'
      },
      source: 'rule',
      url: `${requestedUrl}about`,
      occurrences: 1,
      observed: 'لقيت نص قالب افتراضي باللاتيني (Lorem ipsum dolor sit amet...) ظاهر للزوار في صفحة «من نحن».',
      expected: 'كل نصوص القالب التجريبية لازم تتبدل بمحتوى حقيقي عن الشركة قبل استلام الموقع.',
      whyItMattersAr: 'وجود نص وهمي من القالب بيقلل ثقة العميل أو المستورد وبيبان إن الموقع لسه تحت الإنشاء.',
      steps: [
        'افتح صفحة /about وانزل لحد قسم «رؤية الشركة».',
        'هتلاقي فقرة كاملة مكتوبة بـ Lorem ipsum.'
      ],
      evidence: [
        {
          id: 'EV-RC005-1',
          type: 'snippet',
          value: '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper.</p>',
          ref: 'section#vision p',
          method: 'static_html'
        }
      ],
      recommendedFix:
        'افتح صفحة «من نحن» بالضغط على Edit with Elementor واستبدل فقرة Lorem ipsum بنص حقيقي عن تاريخ المصنع وشهادات الجودة (استناداً إلى الدليل [EV-RC005-1]).'
    }
  ];

  const passes: PassItem[] = [
    {
      id: 'mock_pass_https',
      ruleId: 'SEC_HTTPS',
      category: 'security',
      titleAr: 'الاتصال مشفر عبر HTTPS شغال سليم',
      detailAr: 'شهادة الأمان شغالة والصفحة بتفتح على https:// مباشرة.',
      evidence: 'https://mock-b2b-factory.example.com/ (HTTP 200)',
      method: 'http'
    },
    {
      id: 'mock_pass_title',
      ruleId: 'SEO_TITLE',
      category: 'seo',
      titleAr: 'عنوان الصفحة (Title) ووصف جوجل (Meta Description) موجودين',
      detailAr: 'العنوان واضح ومناسب لنشاط المصنع ومفيش اسم قالب افتراضي.',
      evidence: '<title>مصنع النيل للتعبئة والتغليف | تصدير لجميع الدول</title>',
      method: 'static_html'
    },
    {
      id: 'mock_pass_viewport',
      ruleId: 'RESP_VIEWPORT',
      category: 'responsive',
      titleAr: 'وسم ضبط شاشة الموبايل (meta viewport) مضبوط',
      detailAr: 'الصفحة فيها meta viewport بيخلي العرض يتكيف مع شاشة الموبايل.',
      evidence: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      method: 'static_html'
    }
  ];

  const notMeasured: NotMeasuredItem[] = [
    {
      id: 'mock_nm_wa_active',
      checkId: 'RX001_ACTIVE',
      category: 'links',
      titleAr: 'التأكد إن رقم الواتساب شغال ومربوط بحساب فعلي',
      reasonAr: 'مش بنتأكد إن الرقم عليه واتساب فعلًا؛ بنراجع صيغة الرابط في الكود بس.',
      missingCapability: 'browserRendering',
      chipAr: 'حدود الفحص'
    },
    {
      id: 'mock_nm_form_submit',
      checkId: 'FORM_SUBMIT',
      category: 'accessibility',
      titleAr: 'تجربة إرسال فورم التواصل ووصول الإيميل الفعلي',
      reasonAr: 'مدام عفاف مش بتبعت رسائل تجريبية في الفورم عشان ما تملاش بريدك رسائل وهمية.',
      missingCapability: 'browserRendering',
      chipAr: 'قريبًا'
    }
  ];

  const verdict = computeVerdict({
    findings,
    passes,
    notMeasured,
    profile: siteProfile
  });

  const aiClaimsText = 'الموقع سريع وجاهز للتصدير وكل الزراير والمحتوى كاملين';
  const aiClaimsComparison = evaluateAiClaims({
    aiClaimsText,
    findings,
    passes,
    notMeasured
  });

  const prompts = buildRepairPrompts({
    requestedUrl,
    finalUrl: requestedUrl,
    scanId: 'mock_demo_wordpress_b2b',
    startedAt,
    siteProfile,
    verdict,
    findings
  });

  return {
    schemaVersion: '2.0',
    rulesetVersion: '2.1.0',
    isMockFallback: true,
    scanId: 'mock_demo_wordpress_b2b',
    requestedUrl,
    finalUrl: requestedUrl,
    registrableDomain: 'mock-b2b-factory.example.com',
    status: 'completed',
    startedAt,
    finishedAt,
    limits: { maxPages: 10 },
    siteProfile,
    capabilities: {
      serverFetch: true,
      responseHeaders: true,
      timing: true,
      htmlParser: true,
      headRequests: true,
      psi: true,
      geminiStructuredOutput: false,
      browserRendering: false
    },
    pages: [
      { url: requestedUrl, title: 'الرئيسية — مصنع النيل', httpStatus: 200, pageType: 'home', viewportsChecked: ['desktop'] },
      { url: `${requestedUrl}about`, title: 'من نحن', httpStatus: 200, pageType: 'content', viewportsChecked: ['desktop'] },
      { url: `${requestedUrl}products`, title: 'المنتجات', httpStatus: 200, pageType: 'listing', viewportsChecked: ['desktop'] },
      { url: `${requestedUrl}contact`, title: 'تواصل معنا', httpStatus: 200, pageType: 'contact', viewportsChecked: ['desktop'] }
    ],
    uniquePagesInspected: 4,
    findings,
    passes,
    notMeasured,
    lighthouse: [],
    limitations: [
      'بيانات تجريبية MOCK لتوضيح شكل التقرير والأدلة قبل الفحص.',
      'عينة 4 صفحات توضيحية.'
    ],
    verdict,
    aiClaimsText,
    aiClaimsComparison,
    repairMode: prompts.repairMode,
    masterRepairPrompt: prompts.masterPrompt,
    confirmedOnlyMasterRepairPrompt: prompts.confirmedOnlyMasterPrompt,
    developerMarkdownHandoff: prompts.developerMarkdownHandoff,
    confirmedOnlyDeveloperMarkdownHandoff: prompts.confirmedOnlyDeveloperMarkdownHandoff,
    cmsChecklistItems: prompts.cmsChecklistItems,
    individualRepairPrompts: prompts.individualPrompts
  };
}

function createSpaAiBuiltMockReport(): ScanResult {
  const requestedUrl = 'https://mock-ai-spa.example.com/';
  const startedAt = '2026-10-25T08:05:00.000Z';
  const finishedAt = '2026-10-25T08:05:09.000Z';

  const siteProfile: SiteProfile = {
    type: 'standard',
    confidence: 0.92,
    signals: ['Empty <div id="root"></div> shell', 'Vite module script /assets/index.js'],
    platform: 'spa',
    builder: 'none',
    confidenceLevel: 'high',
    hasTailwind: true,
    isCodeRepoPlatform: true,
    language: 'ar',
    direction: 'rtl',
    arabicRatio: 0.75,
    siteType: 'landing',
    siteTypeReason: 'تطبيق واجهة أحادية الصفحة (SPA) مبني بأداة كود',
    primaryConversion: {
      type: 'none',
      inTopOfPage: false
    }
  };

  const findings: Finding[] = [
    {
      id: 'mock_spa_r008',
      ruleId: 'R008',
      category: 'seo',
      title: 'Default template title left as Vite + React',
      titleAr: 'عنوان التبويب لسه على الاسم الافتراضي للقالب (Vite + React)',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'static_html',
      affectsVerdict: true,
      needsHumanDecision: false,
      scope: 'page',
      where: {
        pageUrl: requestedUrl,
        sectionAr: 'رأس الصفحة (<head>)',
        visibleText: 'Vite + React + TS',
        selector: 'head > title',
        snippet: '<title>Vite + React + TS</title>'
      },
      source: 'rule',
      url: requestedUrl,
      occurrences: 1,
      observed: 'عنوان الصفحة في الكود الأساسي مكتوب «Vite + React + TS» بدل اسم المشروع الحقيقي.',
      expected: 'عنوان الصفحة <title> ووصف meta description لازم يعبروا عن اسم مشروعك وخدمتك بالعربي.',
      whyItMattersAr:
        'لما تشارك رابط موقعك على واتساب أو يظهر في جوجل، هيظهر للعميل باسم «Vite + React» وكأنه مشروع تجريبي مش مكتمل.',
      steps: [
        'افتح الرابط وبص على اسم التاب فوق في المتصفح أو اعمل View Page Source.',
        'هتلاقي <title>Vite + React + TS</title>.'
      ],
      evidence: [
        {
          id: 'EV-SPA-TITLE-1',
          type: 'snippet',
          value: '<title>Vite + React + TS</title>',
          ref: 'head > title',
          method: 'static_html'
        }
      ],
      recommendedFix:
        'في ملف index.html استبدل <title>Vite + React + TS</title> بعنوان موقعك الحقيقي وضيف <meta name="description"> ووسوم OpenGraph (استناداً إلى الدليل [EV-SPA-TITLE-1]).'
    },
    {
      id: 'mock_spa_reconcile',
      ruleId: 'RC010_RECONCILE',
      category: 'seo',
      title: 'Discrepancy between static HTML shell and client-rendered DOM',
      titleAr: 'اختلاف بين مصدر الصفحة والصفحة المعروضة (تطبيق SPA يعتمد على JavaScript)',
      kind: 'suspected_issue',
      severity: 'low',
      confidence: 'likely',
      method: 'psi',
      affectsVerdict: false,
      needsHumanDecision: true,
      scope: 'page',
      where: {
        pageUrl: requestedUrl,
        sectionAr: 'هيكل الصفحة (<div id="root">)',
        visibleText: 'منصة حجوزات العيادات الذكية',
        selector: '#root > main > h1',
        snippet: '<div id="root"></div> <!-- Rendered H1: منصة حجوزات العيادات الذكية -->'
      },
      source: 'rule',
      url: requestedUrl,
      occurrences: 1,
      observed:
        'كود HTML الأولي جاي فاضي (<div id="root"></div>) من غير عنوان H1، لكن قياس المتصفح رصد العنوان بعد تشغيل الجافاسكريبت.',
      expected: 'لو الموقع محتاج أرشفة سريعة ومعاينة روابط على السوشيال ميديا، يفضل توليد العناوين والوسوم مسبقاً (SSR / Prerender).',
      whyItMattersAr:
        'بعض بوتات المعاينة السريعة (زي واتساب وتليجرام) مش بتشغل جافاسكريبت، فبتشوف صفحة فاضية من غير عنوان ولا وصف.',
      steps: [
        'اضغط كليك يمين في المتصفح واختار View Page Source.',
        'قارن الكود الفاضي جوه <div id="root"></div> باللي ظاهر قدامك في Inspect Element.'
      ],
      evidence: [
        {
          id: 'EV-SPA-REC-1',
          type: 'snippet',
          value: 'Static HTML: <div id="root"></div> (0 H1 tags) | Rendered PSI DOM: <h1>منصة حجوزات العيادات الذكية</h1>',
          ref: '#root',
          method: 'psi'
        }
      ],
      recommendedFix:
        'تأكد من ضبط وسوم العنوان والوصف في index.html أو تفعيل Prerendering لو الصفحة تسويقية ومطلوب أرشفتها (استناداً إلى الدليل [EV-SPA-REC-1]).'
    }
  ];

  const passes: PassItem[] = [
    {
      id: 'mock_spa_pass_https',
      ruleId: 'SEC_HTTPS',
      category: 'security',
      titleAr: 'التشفير HTTPS وترويسات الكاش الأساسية شغالة',
      detailAr: 'الملفات الثابتة بتتحمل عبر HTTPS مع ضغط Brotli/Gzip.',
      evidence: 'HTTP/2 200 · content-encoding: br',
      method: 'http'
    }
  ];

  const notMeasured: NotMeasuredItem[] = [
    {
      id: 'mock_spa_nm_content',
      checkId: 'SPA_CONTENT',
      category: 'content',
      titleAr: 'مراجعة كل النصوص والروابط الداخلية اللي بتترسم بالجافاسكريبت',
      reasonAr: 'الموقع شغال بنظام SPA (كود HTML الأولي فاضي)، فالفحص الثابت مش بيشوف الصفحات الداخلية اللي بتتولد في المتصفح بس.',
      missingCapability: 'browserRendering',
      chipAr: 'مراجعة جزئية'
    }
  ];

  const verdict = computeVerdict({
    findings,
    passes,
    notMeasured,
    profile: siteProfile
  });

  const aiClaimsText = 'السيو متظبط 100% والموقع جاهز للنشر ومثالي لمحركات البحث';
  const aiClaimsComparison = evaluateAiClaims({
    aiClaimsText,
    findings,
    passes,
    notMeasured
  });

  const prompts = buildRepairPrompts({
    requestedUrl,
    finalUrl: requestedUrl,
    scanId: 'mock_demo_spa_ai_built',
    startedAt,
    siteProfile,
    verdict,
    findings
  });

  return {
    schemaVersion: '2.0',
    rulesetVersion: '2.1.0',
    isMockFallback: true,
    scanId: 'mock_demo_spa_ai_built',
    requestedUrl,
    finalUrl: requestedUrl,
    registrableDomain: 'mock-ai-spa.example.com',
    status: 'completed',
    startedAt,
    finishedAt,
    reviewNumber: 2,
    previousScanId: 'mock_demo_spa_ai_built_r1',
    discoveredNotScanned: [
      `${requestedUrl}pricing`,
      `${requestedUrl}contact`
    ],
    rescanComparison: {
      previousScanId: 'mock_demo_spa_ai_built_r1',
      previousScanDate: '2026-10-25T07:30:00.000Z',
      resolvedRuleIds: [
        { ruleId: 'RX001', titleAr: 'رابط واتساب محلي', fingerprint: 'fp_1', confirmed: true },
        { ruleId: 'R005', titleAr: 'نص وهمي منسي', fingerprint: 'fp_2', confirmed: true }
      ],
      stillOpenRuleIds: [
        { ruleId: 'R008', titleAr: 'عنوان الصفحة الافتراضي', fingerprint: 'fp_3', confirmed: true }
      ],
      newRuleIds: [],
      resolvedConfirmedCount: 2,
      stillOpenConfirmedCount: 1,
      allConfirmedResolved: false,
      metricDeltas: [
        {
          metric: 'LCP',
          before: 4200,
          after: 2100,
          delta: -2100,
          unit: 'ms',
          deltaText: '-2100ms',
          statusAr: 'تحسّن',
          note: 'lab'
        },
        {
          metric: 'CLS',
          before: 0.14,
          after: 0.03,
          delta: -0.11,
          unit: '',
          deltaText: '-0.11',
          statusAr: 'تحسّن',
          note: 'lab'
        },
        {
          metric: 'TBT',
          before: 380,
          after: 140,
          delta: -240,
          unit: 'ms',
          deltaText: '-240ms',
          statusAr: 'تحسّن',
          note: 'lab'
        },
        {
          metric: 'TTFB',
          before: 520,
          after: 260,
          delta: -260,
          unit: 'ms',
          deltaText: '-260ms',
          statusAr: 'تحسّن',
          note: 'lab'
        }
      ]
    },
    limits: { maxPages: 10 },
    siteProfile,
    capabilities: {
      serverFetch: true,
      responseHeaders: true,
      timing: true,
      htmlParser: true,
      headRequests: true,
      psi: true,
      geminiStructuredOutput: false,
      browserRendering: false
    },
    pages: [
      { url: requestedUrl, title: 'Vite + React + TS', httpStatus: 200, pageType: 'home', viewportsChecked: ['desktop'] }
    ],
    uniquePagesInspected: 1,
    findings,
    passes,
    notMeasured,
    lighthouse: [],
    limitations: [
      'بيانات تجريبية MOCK لتوضيح شكل التقرير لمواقع SPA المبنية بأدوات AI.',
      'مراجعة جزئية لأن الموقع يعتمد على Client-Side Rendering.'
    ],
    verdict,
    aiClaimsText,
    aiClaimsComparison,
    repairMode: prompts.repairMode,
    masterRepairPrompt: prompts.masterPrompt,
    confirmedOnlyMasterRepairPrompt: prompts.confirmedOnlyMasterPrompt,
    developerMarkdownHandoff: prompts.developerMarkdownHandoff,
    confirmedOnlyDeveloperMarkdownHandoff: prompts.confirmedOnlyDeveloperMarkdownHandoff,
    cmsChecklistItems: prompts.cmsChecklistItems,
    individualRepairPrompts: prompts.individualPrompts
  };
}

export const MOCK_DEMO_REPORTS: MockDemoReportEntry[] = [
  {
    id: 'wordpress_b2b',
    labelAr: 'عينة موقع شركة / مصنع ووردبريس (MOCK)',
    subtitleAr: 'مثال يوضح كشف غلطة رقم واتساب محلي، ونص Lorem Ipsum منسي، وبطء صورة البانر',
    report: createWordPressB2bMockReport()
  },
  {
    id: 'spa_ai_built',
    labelAr: 'عينة تطبيق مبني بأداة AI — React SPA (MOCK)',
    subtitleAr: 'مثال يوضح كشف عنوان Vite + React المنسي والفرق بين الكود الثابت والمتصفح',
    report: createSpaAiBuiltMockReport()
  }
];

export function getMockDemoReport(id?: string): ScanResult {
  const found = MOCK_DEMO_REPORTS.find(item => item.id === id);
  return found ? found.report : MOCK_DEMO_REPORTS[0].report;
}
