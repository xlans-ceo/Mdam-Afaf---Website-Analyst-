/**
 * Steps 3, 4, 5, 6, 8 & PHASE J1: Honest Multi-Method Evidence Checks,
 * Platform-Aware Fix Adapter, Deterministic Verdict, and AI Claims vs Reality.
 *
 * Truthfulness rules:
 * - Every finding MUST have concrete evidence and a populated `where` locator.
 * - Never fabricate LCP/CLS numbers without PSI or a real browser.
 * - Never suggest Tailwind unless Tailwind is detected.
 * - Never suggest overflow-x:hidden as a mobile layout fix.
 * - Never suggest enabling SSL on an https:// site.
 */
import {
  CapabilitiesReport,
  ClaimComparisonItem,
  Evidence,
  Finding,
  FindingWhere,
  NotMeasuredItem,
  PassItem,
  SiteProfile,
  VerdictInfo
} from '../types/contract';
import { getRegistrableDomain } from './domain-parser';
import { normalizeAndCapFindings } from './normalize-finding';
import { buildSiteProfile } from './site-profiler';
import { getPlatformAwareFix } from './platform-adapter';
import { isVerifiedBuilderHostedUrl } from '../knowledge/ai-builders';
import {
  collapseWhitespace,
  HTMLElement,
  isElementAriaHidden,
  isInsideNoscriptOrTemplate,
  isSharedTemplateSectionAr,
  parsePageHtml
} from './html-dom';

export interface SampledImageSize {
  url: string;
  bytes: number;
  contentType?: string;
  broken?: boolean;
  status?: number;
  error?: string;
}

export interface PsiRenderedAuditItem {
  id: string;
  passed: boolean;
  score?: number | null;
  title?: string;
  description?: string;
  displayValue?: string;
  details?: any;
}

export interface PsiRenderedAudits {
  documentTitle?: PsiRenderedAuditItem;
  headingOrder?: PsiRenderedAuditItem;
  hasRenderedH1?: boolean;
  renderedH1Text?: string;
  imageAlt?: PsiRenderedAuditItem;
  linkName?: PsiRenderedAuditItem;
  formLabel?: PsiRenderedAuditItem;
  colorContrast?: PsiRenderedAuditItem;
  tapTargets?: PsiRenderedAuditItem;
  viewport?: PsiRenderedAuditItem;
  fontSize?: PsiRenderedAuditItem;
  crawlableAnchors?: PsiRenderedAuditItem;
}

export interface PsiFieldMetric {
  percentile?: number;
  category?: 'FAST' | 'AVERAGE' | 'SLOW' | string;
}

export interface PsiFieldData {
  source: 'url' | 'origin';
  overallCategory?: 'FAST' | 'AVERAGE' | 'SLOW' | string;
  lcpMs?: PsiFieldMetric;
  cls?: PsiFieldMetric;
  inpMs?: PsiFieldMetric;
  fcpMs?: PsiFieldMetric;
}

export interface PsiLcpElementInfo {
  selector?: string;
  snippet?: string;
  nodeLabel?: string;
  type: string;
}

export type PsiLcpElement = PsiLcpElementInfo;

export interface PsiOpportunityItem {
  id: string;
  title: string;
  displayValue?: string;
  savingsMs?: number;
  savingsBytes?: number;
}

export interface PsiMeasurement {
  available?: boolean;
  source?: 'lighthouse';
  lcpMs?: number;
  cls?: number;
  fcpMs?: number;
  tbtMs?: number;
  speedIndexMs?: number;
  performanceScore?: number;
  seoScore?: number;
  cacheLabelAr?: string;
  cacheAgeMinutes?: number;
  fromCache?: boolean;
  fieldData?: PsiFieldData;
  lcpElement?: PsiLcpElementInfo;
  topOpportunities?: PsiOpportunityItem[];
  renderedAudits?: PsiRenderedAudits;
}

export interface HonestAnalysisInput {
  url: string;
  html: string;
  status?: number;
  statusCode?: number;
  headers?: Headers | Record<string, string | undefined> | null;
  ttfbMs?: number;
  htmlBytes?: number;
  sampledImageSizes?: SampledImageSize[];
  psiData?: PsiMeasurement | null;
  psiNotMeasured?: NotMeasuredItem | null;
  capabilities?: CapabilitiesReport;
  profile?: SiteProfile;
  siteProfile?: SiteProfile;
  discoveryMeta?: {
    robotsTxtPresent?: boolean;
    sitemapXmlPresent?: boolean;
  };
}

export interface HonestAnalysisOutput {
  profile: SiteProfile;
  findings: Finding[];
  allNormalizedFindings: Finding[];
  overflowCountsByCategory: Partial<Record<string, number>>;
  passes: PassItem[];
  notMeasured: NotMeasuredItem[];
}

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'live.com',
  'msn.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'yandex.com',
  'zoho.com',
  'mail.com'
]);

const TRACKING_PIXEL_PATTERNS =
  /facebook\.com\/tr|connect\.facebook\.net|google-analytics\.com|googletagmanager\.com|doubleclick\.net|analytics|pixel|beacon|bat\.bing\.com|tiktok\.com\/i18n\/pixel|snapchat\.com|linkedin\.com\/px/i;

function getHeader(
  headers: Headers | Record<string, string | undefined> | undefined,
  name: string
): string {
  if (!headers) return '';
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) || '';
  }
  const rec = headers as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower && v) return v;
  }
  return '';
}

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function extractVisibleText(html: string): string {
  return stripScriptsAndStyles(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeLevenshteinDistance(a: string, b: string): number {
  const s = a.toLowerCase().trim();
  const t = b.toLowerCase().trim();
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  const dp: number[][] = Array.from({ length: s.length + 1 }, () =>
    new Array<number>(t.length + 1).fill(0)
  );
  for (let i = 0; i <= s.length; i++) dp[i][0] = i;
  for (let j = 0; j <= t.length; j++) dp[0][j] = j;

  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[s.length][t.length];
}

export function formatArabicNoteCount(count: number): string {
  if (count === 0) return 'صفر ملاحظات';
  if (count === 1) return 'ملاحظة واحدة';
  if (count === 2) return 'ملاحظتين';
  if (count >= 3 && count <= 10) return `${count} ملاحظات`;
  return `${count} ملاحظة`;
}

function isTrackingOrDecorativeImage(imgEl: HTMLElement): {
  skipCompletely: boolean;
  isDecorativeEmptyAlt: boolean;
} {
  if (isInsideNoscriptOrTemplate(imgEl) || isElementAriaHidden(imgEl)) {
    return { skipCompletely: true, isDecorativeEmptyAlt: false };
  }

  const role = (imgEl.getAttribute('role') || '').trim().toLowerCase();
  if (role === 'presentation' || role === 'none') {
    return { skipCompletely: true, isDecorativeEmptyAlt: true };
  }

  const widthAttr = (imgEl.getAttribute('width') || '').trim();
  const heightAttr = (imgEl.getAttribute('height') || '').trim();
  if (widthAttr === '1' || heightAttr === '1' || widthAttr === '0' || heightAttr === '0') {
    return { skipCompletely: true, isDecorativeEmptyAlt: false };
  }

  const styleAttr = (imgEl.getAttribute('style') || '').toLowerCase();
  if (
    /display\s*:\s*none|visibility\s*:\s*hidden|width\s*:\s*[01]px|height\s*:\s*[01]px/.test(
      styleAttr
    )
  ) {
    return { skipCompletely: true, isDecorativeEmptyAlt: false };
  }

  const src = (
    imgEl.getAttribute('src') ||
    imgEl.getAttribute('data-src') ||
    imgEl.getAttribute('data-lazy-src') ||
    ''
  ).trim();
  if (src && TRACKING_PIXEL_PATTERNS.test(src)) {
    return { skipCompletely: true, isDecorativeEmptyAlt: false };
  }

  if (imgEl.hasAttribute('alt')) {
    const altVal = (imgEl.getAttribute('alt') ?? '').trim();
    if (altVal === '') {
      return { skipCompletely: false, isDecorativeEmptyAlt: true };
    }
  }

  return { skipCompletely: false, isDecorativeEmptyAlt: false };
}

function isInsideProductGallery(imgEl: HTMLElement): boolean {
  let curr = imgEl.parentNode as HTMLElement | null;
  while (curr) {
    const clsId = `${curr.getAttribute?.('id') || ''} ${curr.getAttribute?.('class') || ''}`.toLowerCase();
    if (
      /woocommerce-product-gallery|product-gallery|product-images|gallery-thumbs|swiper-wrapper|carousel-inner|product-thumbnails/.test(
        clsId
      ) ||
      curr.hasAttribute?.('data-gallery')
    ) {
      return true;
    }
    curr = curr.parentNode as HTMLElement | null;
  }
  return false;
}

function normalizeImageSrcKey(rawSrc: string): string {
  const clean = rawSrc.trim().split('?')[0].split('#')[0];
  // Normalize WordPress thumbnail dimensions like -300x300.jpg -> .jpg only if same file
  return clean.toLowerCase();
}

function detectKnownTranslationSignals(html: string, domRoot: HTMLElement, profile: SiteProfile): {
  detected: boolean;
  detail: string;
} {
  if (profile.markets?.hasAlternateLanguage && profile.markets.alternateLangEvidence) {
    return {
      detected: true,
      detail: profile.markets.alternateLangEvidence
    };
  }

  // Check known translation plugins / scripts / widgets
  if (/cdn\.gtranslate\.net|doGTranslate|gt_float_switcher|gtranslate_wrapper/i.test(html)) {
    return { detected: true, detail: 'GTranslate widget detected' };
  }
  if (/cdn\.weglot\.com|Weglot\.initialize|weglot-container/i.test(html)) {
    return { detected: true, detail: 'Weglot translation detected' };
  }
  if (/wpml-ls|icl_lang_sel|sitepress-multilingual-cms/i.test(html)) {
    return { detected: true, detail: 'WPML language switcher detected' };
  }
  if (/trp-language-switcher|translatepress/i.test(html)) {
    return { detected: true, detail: 'TranslatePress language switcher detected' };
  }
  if (/google_translate_element|goog-te-combo|translate\.google\.com\/translate_a/i.test(html)) {
    return { detected: true, detail: 'Google Translate element detected' };
  }

  // Check Polylang or explicit alternate hreflang / path links (with real non-# href)
  const anchors = domRoot.querySelectorAll('a');
  for (const a of anchors) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) continue;
    const cls = `${a.getAttribute('class') || ''} ${a.getAttribute('id') || ''}`;
    const langAttr = a.getAttribute('hreflang') || a.getAttribute('lang') || '';
    if (
      /\b(pll-|lang-item)\b/i.test(cls) ||
      /^(en|fr|de|es|zh)/i.test(langAttr) ||
      /\/(en|ar)(\/|$)|\?(lang|locale)=(en|ar)/i.test(href)
    ) {
      return { detected: true, detail: `Language alternate link (${href})` };
    }
  }

  return { detected: false, detail: '' };
}

export function runHonestChecks(input: HonestAnalysisInput): HonestAnalysisOutput {
  const {
    url,
    html,
    headers,
    ttfbMs,
    htmlBytes,
    sampledImageSizes = [],
    psiData = null,
    psiNotMeasured = null,
    capabilities
  } = input;

  const profile =
    input.profile ||
    input.siteProfile ||
    buildSiteProfile({
      url,
      html,
      headers: headers as Headers | Record<string, string> | null | undefined
    });

  const dom = parsePageHtml(html, url);
  const isHttps = url.toLowerCase().startsWith('https://');
  const rawFindings: Finding[] = [];
  const passes: PassItem[] = [];
  const notMeasured: NotMeasuredItem[] = [];

  const caps: CapabilitiesReport = capabilities || {
    serverFetch: true,
    responseHeaders: Boolean(headers),
    timing: typeof ttfbMs === 'number',
    htmlParser: true,
    headRequests: sampledImageSizes.length > 0,
    psi: Boolean(psiData),
    geminiStructuredOutput: false,
    browserRendering: false
  };

  const registrableDomain = getRegistrableDomain(url) || '';
  const visibleText = extractVisibleText(html);
  const titleEl = dom.root.querySelector('title');
  const titleText = collapseWhitespace(titleEl?.text);
  const metaDescEl =
    dom.root.querySelector('meta[name="description"]') ||
    dom.root.querySelector('meta[name="Description"]');
  const metaDesc = collapseWhitespace(metaDescEl?.getAttribute('content'));
  const viewportEl = dom.root.querySelector('meta[name="viewport"]');
  const viewportContent = collapseWhitespace(viewportEl?.getAttribute('content'));

  // ---------------------------------------------------------------------------
  // 1. HTTPS & Security Headers (R010) — Method: http
  // ---------------------------------------------------------------------------
  if (isHttps) {
    passes.push({
      id: 'pass_https',
      ruleId: 'R010',
      category: 'security',
      titleAr: 'الموقع شغال بتشفير HTTPS آمن',
      detailAr: 'الاتصال بين الزائر والموقع مشفر بشهادة SSL شغالة.',
      evidence: `URL: ${url}`,
      method: 'http'
    });
  } else if (url.toLowerCase().startsWith('http://') && !url.includes('127.0.0.1') && !url.includes('localhost')) {
    rawFindings.push({
      id: 'f_r010_http',
      ruleId: 'R010',
      category: 'security',
      title: 'Site Loaded Over Unencrypted HTTP',
      titleAr: 'الموقع شغال من غير تشفير HTTPS',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'http',
      source: 'rule',
      url,
      where: dom.defaultWhere('إعدادات الاتصال (HTTP)', `URL: ${url}`),
      occurrences: 1,
      observed: `Site responded over plain HTTP: ${url}`,
      expected: 'HTTPS with valid TLS certificate and automatic redirect from HTTP to HTTPS',
      steps: ['افتح الرابط في المتصفح وشوف علامة القفل جنب العنوان'],
      evidence: [{ type: 'url', value: url, ref: url }],
      recommendedFix: 'فعّل شهادة SSL مجانية (Let’s Encrypt) من الاستضافة أو Cloudflare واعمل تحويل تلقائي لـ HTTPS.'
    });
  }

  if (headers) {
    const hsts = getHeader(headers, 'strict-transport-security');
    const xcto = getHeader(headers, 'x-content-type-options');
    const xfo = getHeader(headers, 'x-frame-options');
    const csp = getHeader(headers, 'content-security-policy');

    const missingHeaders: string[] = [];
    if (isHttps && !hsts) missingHeaders.push('Strict-Transport-Security');
    if (!xcto) missingHeaders.push('X-Content-Type-Options');
    if (!xfo && !csp.toLowerCase().includes('frame-ancestors')) {
      missingHeaders.push('X-Frame-Options / CSP frame-ancestors');
    }

    if (missingHeaders.length === 0) {
      passes.push({
        id: 'pass_sec_headers',
        ruleId: 'R010',
        category: 'security',
        titleAr: 'إعدادات حماية المتصفح الأساسية موجودة (Security Headers)',
        detailAr: 'السيرفر بيبعت هيدرز الحماية الأساسية للمتصفح.',
        evidence: `HSTS=${Boolean(hsts)}, XCTO=${xcto}`,
        method: 'http'
      });
    } else {
      rawFindings.push({
        id: 'f_r010_sec_headers',
        ruleId: 'R010',
        category: 'security',
        title: 'Missing Baseline Security Headers',
        titleAr: 'تحسين حماية: بعض إعدادات الحماية الأساسية للرد مش مفعلة (Security Headers)',
        kind: 'recommendation',
        severity: 'low',
        confidence: 'confirmed',
        affectsVerdict: false,
        method: 'http',
        source: 'rule',
        url,
        where: dom.defaultWhere('هيدرز استجابة السيرفر (HTTP Headers)', `Missing: ${missingHeaders.join(', ')}`),
        occurrences: 1,
        observed: `Missing HTTP response headers: ${missingHeaders.join(', ')}`,
        expected: 'Baseline security headers (X-Content-Type-Options: nosniff, X-Frame-Options, HSTS)',
        steps: [
          'افتح أدوات المطور في المتصفح (F12) → تبويب Network',
          'اضغط على أول طلب للصفحة وشوف Response Headers'
        ],
        evidence: [
          {
            type: 'header',
            value: `Missing: ${missingHeaders.join(', ')}`,
            ref: `Missing: ${missingHeaders.join(', ')}`
          }
        ],
        recommendedFix: getPlatformAwareFix('R010', profile, {
          isHttps
        })
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. SEO Essentials: Title, Meta Description, H1, Canonical (R008 / R009 / RC010)
  // ---------------------------------------------------------------------------
  if (!titleText) {
    rawFindings.push({
      id: 'f_r008_missing_title',
      ruleId: 'R008',
      category: 'seo',
      title: 'Missing Page <title>',
      titleAr: 'الصفحة ملهاش عنوان رئيسي في المتصفح (<title>)',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: {
        pageUrl: url,
        sectionAr: 'الهيدر',
        visibleText: 'عنوان الصفحة (<title>)',
        selector: 'head > title',
        snippet: '<head> (missing <title>)'
      },
      occurrences: 1,
      observed: 'No non-empty <title> element found in HTML head',
      expected: 'Descriptive <title> between 15 and 65 characters',
      steps: ['افتح الصفحة وبص على اسم التاب فوق في المتصفح'],
      evidence: [{ type: 'snippet', value: '<head> (no <title>)', ref: '<head>' }],
      recommendedFix: getPlatformAwareFix('R008', profile, { isHttps })
    });
  } else {
    passes.push({
      id: 'pass_title',
      ruleId: 'R008',
      category: 'seo',
      titleAr: 'عنوان الصفحة (<title>) موجود وواضح',
      detailAr: `العنوان الحالي: "${titleText.slice(0, 70)}"`,
      evidence: `<title>${titleText.slice(0, 90)}</title>`,
      method: 'static_html'
    });
  }

  if (!metaDesc) {
    rawFindings.push({
      id: 'f_r009_missing_desc',
      ruleId: 'R009',
      category: 'seo',
      title: 'Missing Meta Description',
      titleAr: 'وصف الصفحة لمحركات البحث (Meta Description) مش موجود',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: {
        pageUrl: url,
        sectionAr: 'الهيدر',
        visibleText: titleText || 'وصف الصفحة (meta description)',
        selector: 'head > meta[name="description"]',
        snippet: `<title>${titleText.slice(0, 120)}</title>`
      },
      occurrences: 1,
      observed: 'No <meta name="description"> tag found in HTML',
      expected: 'Clear summary of the page (120–160 chars) for Google search results',
      steps: ['اعمل كليك يمين في الصفحة واختار View Page Source ودور على meta name="description"'],
      evidence: [{ type: 'snippet', value: `<title>${titleText.slice(0, 80)}</title> (no meta description)`, ref: 'head' }],
      recommendedFix: getPlatformAwareFix('R009', profile, { isHttps })
    });
  } else if (metaDesc.length < 40) {
    rawFindings.push({
      id: 'f_r009_short_desc',
      ruleId: 'R009',
      category: 'seo',
      title: 'Very Short Meta Description',
      titleAr: 'وصف الصفحة لمحركات البحث قصير أوي ومش بيشرح النشاط كفاية',
      kind: 'recommendation',
      severity: 'low',
      confidence: 'confirmed',
      affectsVerdict: false,
      method: 'static_html',
      source: 'rule',
      url,
      where: metaDescEl ? dom.locate(metaDescEl) : dom.defaultWhere('meta description'),
      occurrences: 1,
      observed: `Meta description is only ${metaDesc.length} chars: "${metaDesc}"`,
      expected: 'Between 80 and 160 characters summarizing the offer',
      steps: ['افحص وسم meta name="description" في مصدر الصفحة'],
      evidence: [{ type: 'snippet', value: `<meta name="description" content="${metaDesc}">`, ref: 'meta[name="description"]' }],
      recommendedFix: getPlatformAwareFix('R009', profile, { isHttps })
    });
  } else {
    passes.push({
      id: 'pass_meta_desc',
      ruleId: 'R009',
      category: 'seo',
      titleAr: 'وصف الصفحة لمحركات البحث (Meta Description) مكتوب',
      detailAr: `طول الوصف ${metaDesc.length} حرف.`,
      evidence: metaDesc.slice(0, 110),
      method: 'static_html'
    });
  }

  // H1 check (P2b.1 & P2b.5: reconcile with rendered PSI evidence; low severity; never medium)
  const h1Elements = dom.root
    .querySelectorAll('h1')
    .filter(el => !isInsideNoscriptOrTemplate(el));

  const hasRenderedH1 = Boolean(
    psiData?.renderedAudits?.hasRenderedH1 ||
    psiData?.lcpElement?.type === 'h1' ||
    (psiData?.lcpElement?.nodeLabel || '').toLowerCase().startsWith('h1') ||
    (psiData?.lcpElement?.snippet || '').toLowerCase().includes('<h1')
  );

  if (h1Elements.length === 0) {
    if (hasRenderedH1) {
      // Discrepancy between static HTML and rendered page
      rawFindings.push({
        id: 'f_reconcile_h1_discrepancy',
        ruleId: 'RC010_RECONCILE',
        category: 'seo',
        title: 'Discrepancy Between Page Source and Rendered Page: H1 Heading',
        titleAr: 'اختلاف بين مصدر الصفحة والصفحة المعروضة: عنوان H1',
        kind: 'suspected_issue',
        severity: 'low',
        confidence: 'likely',
        affectsVerdict: false,
        method: 'psi',
        source: 'rule',
        url,
        where: dom.defaultWhere(titleText || 'المحتوى الرئيسي'),
        occurrences: 1,
        observed: 'كود الصفحة المصدري المبدئي مفيش فيه وسم <h1>، لكن بعد العرض بالمتصفح (Lighthouse/PSI) ظهر عنوان <h1> في المحتوى المعروض.',
        expected: 'تضمين وسم <h1> في كود الصفحة المبدئي لضمان قراءة سريعة لمحركات البحث ومساعدات القراءة',
        steps: ['قارن بين كود الـ HTML المصدري (عرض المصدر) وبين الصفحة بعد ما تفتح في المتصفح'],
        evidence: [
          {
            id: 'ev_reconcile_static_h1',
            type: 'snippet',
            value: `مصدر HTML الثابت: 0 <h1>`,
            ref: 'static_html'
          },
          {
            id: 'ev_reconcile_rendered_h1',
            type: 'measurement',
            value: `الصفحة المعروضة معملياً (PSI): ${psiData?.renderedAudits?.renderedH1Text || psiData?.lcpElement?.nodeLabel || psiData?.lcpElement?.snippet || 'وجد عنوان H1 معروض'}`,
            ref: 'psi'
          }
        ],
        whyItMattersAr: 'محركات البحث والزواحف اللي مش بتشغل جافاسكريبت ممكن ما تشوفش العنوان الرئيسي في أول بايت.',
        recommendedFix: 'لو الموقع شغال بتقنية SPA (زي React أو Vite)، الأفضل تفعيل Server-Side Rendering (SSR) أو Prerendering عشان العناوين تكون ظاهرة من أول بايت.'
      });
    } else if (profile.platform === 'spa' || profile.platform === 'ai_builder') {
      // Unrendered SPA shell with no rendered H1 measurement
      notMeasured.push({
        id: 'nm_h1_spa',
        checkId: 'H1_SPA',
        category: 'seo',
        titleAr: 'فحص عنوان H1 في صفحات SPA بدون عرض كامل',
        reasonAr: 'الموقع شغال بتقنية SPA ولم تتوفر بيانات معملية كافية لتأكيد وجود عنوان <h1> بعد العرض.',
        method: 'psi'
      });
    } else {
      // Static HTML page without H1 — low severity (P2b.5: low, never medium)
      rawFindings.push({
        id: 'f_rc010_no_h1',
        ruleId: 'RC010',
        category: 'seo',
        title: 'Missing Primary Heading (<h1>)',
        titleAr: 'الصفحة مفيهاش عنوان رئيسي واضح بوسم <h1>',
        kind: 'confirmed_defect',
        severity: 'low',
        confidence: 'confirmed',
        affectsVerdict: false,
        method: 'static_html',
        source: 'rule',
        url,
        where: dom.defaultWhere(titleText || 'المحتوى الرئيسي'),
        occurrences: 1,
        observed: 'Zero <h1> elements found in static HTML document',
        expected: 'One clear <h1> describing the main topic of the page',
        steps: ['افتح مصدر الصفحة ودور على وسم <h1'],
        evidence: [
          {
            id: 'ev_rc010_no_h1',
            type: 'snippet',
            value: `<title>${titleText.slice(0, 80)}</title> (0 <h1> tags found)`,
            ref: 'body'
          }
        ],
        whyItMattersAr: 'محركات البحث ومساعدات القراءة بتعتمد على العنوان الرئيسي لفهم موضوع الصفحة بدقة.',
        recommendedFix: getPlatformAwareFix('RC010', profile, { isHttps })
      });
    }
  } else {
    const firstH1 = collapseWhitespace(h1Elements[0].text);
    if (firstH1) {
      passes.push({
        id: 'pass_h1',
        ruleId: 'RC010',
        category: 'seo',
        titleAr: 'العنوان الرئيسي للصفحة (<h1>) موجود',
        detailAr: `العنوان: "${firstH1.slice(0, 70)}"`,
        evidence: `<h1>${firstH1.slice(0, 90)}</h1>`,
        method: 'static_html'
      });
    }
  }

  // B1.3g: Favicon link, robots.txt, and sitemap.xml (low, recommendation, affectsVerdict=false, each with a PASS when present)
  const faviconLinkEl = dom.root.querySelectorAll('link').find(el => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    const href = (el.getAttribute('href') || '').trim();
    return Boolean(href) && /\b(?:icon|apple-touch-icon)\b/.test(rel);
  });
  if (faviconLinkEl) {
    const favHref = (faviconLinkEl.getAttribute('href') || '').trim();
    const favRel = (faviconLinkEl.getAttribute('rel') || 'icon').trim();
    passes.push({
      id: 'pass_favicon',
      ruleId: 'R_FAVICON',
      category: 'seo',
      titleAr: 'أيقونة الموقع في المتصفح (Favicon) موجودة',
      detailAr: `الرابط: ${favHref.slice(0, 80)}`,
      evidence: `<link rel="${favRel}" href="${favHref}">`,
      method: 'static_html'
    });
  } else {
    rawFindings.push({
      id: 'f_r_favicon_missing',
      ruleId: 'R_FAVICON',
      category: 'seo',
      title: 'Missing Favicon Link (<link rel="icon">)',
      titleAr: 'أيقونة الموقع المصغرة في المتصفح (Favicon) مش موجودة',
      kind: 'recommendation',
      severity: 'low',
      confidence: 'confirmed',
      affectsVerdict: false,
      method: 'static_html',
      source: 'rule',
      url,
      where: {
        pageUrl: url,
        sectionAr: 'الهيدر',
        visibleText: 'أيقونة الموقع (Favicon)',
        selector: 'head > link[rel="icon"]',
        snippet: '<head> (missing <link rel="icon">)'
      },
      occurrences: 1,
      observed: 'No <link rel="icon"> or <link rel="shortcut icon"> found in HTML <head>',
      expected: 'A valid <link rel="icon" href="/favicon.ico"> in <head>',
      steps: ['بص على التاب بتاع الموقع في المتصفح وشوف هل لوجو الموقع الصغير ظاهر'],
      evidence: [{ type: 'snippet', value: '<head> (no <link rel="icon">)', ref: 'head' }],
      whyItMattersAr: 'أيقونة المتصفح بتخلي شكل الموقع احترافي وسهل التمييز وسط التابات المفتوحة.',
      recommendedFix: 'ضيف ملف أيقونة صغير للموقع واربطه جوه <head> بوسم <link rel="icon" href="/favicon.ico">.'
    });
  }

  if (input.discoveryMeta?.robotsTxtPresent !== undefined) {
    if (input.discoveryMeta.robotsTxtPresent) {
      passes.push({
        id: 'pass_robots_txt',
        ruleId: 'R_ROBOTS',
        category: 'seo',
        titleAr: 'ملف توجيه محركات البحث (robots.txt) موجود',
        detailAr: 'ملف robots.txt متاح للزواحف ومحركات البحث.',
        evidence: '/robots.txt (HTTP 200)',
        method: 'http'
      });
    } else {
      rawFindings.push({
        id: 'f_r_robots_missing',
        ruleId: 'R_ROBOTS',
        category: 'seo',
        title: 'Missing robots.txt File',
        titleAr: 'ملف توجيه محركات البحث (robots.txt) مش موجود',
        kind: 'recommendation',
        severity: 'low',
        confidence: 'confirmed',
        affectsVerdict: false,
        method: 'http',
        source: 'rule',
        url,
        where: dom.defaultWhere('ملف /robots.txt', '/robots.txt'),
        occurrences: 1,
        observed: 'Request to /robots.txt did not return a valid robots.txt file',
        expected: 'A public /robots.txt file guiding search engine crawlers',
        steps: ['افتح /robots.txt على دومين الموقع وشوف هل الملف بيفتح'],
        evidence: [{ type: 'url', value: '/robots.txt (missing)', ref: '/robots.txt' }],
        whyItMattersAr: 'ملف robots.txt بيساعد محركات البحث تعرف إيه الصفحات المسموح أرشفتها في موقعك.',
        recommendedFix: 'ضيف ملف robots.txt في المسار الرئيسي للموقع يوضح قواعد الزحف ورابط خريطة الموقع Sitemap.'
      });
    }
  }

  if (input.discoveryMeta?.sitemapXmlPresent !== undefined) {
    if (input.discoveryMeta.sitemapXmlPresent) {
      passes.push({
        id: 'pass_sitemap_xml',
        ruleId: 'R_SITEMAP',
        category: 'seo',
        titleAr: 'خريطة الموقع لمحركات البحث (sitemap.xml) موجودة',
        detailAr: 'ملف خريطة الموقع متاح لتسهيل أرشفة الصفحات في جوجل.',
        evidence: '/sitemap.xml (HTTP 200)',
        method: 'http'
      });
    } else {
      rawFindings.push({
        id: 'f_r_sitemap_missing',
        ruleId: 'R_SITEMAP',
        category: 'seo',
        title: 'Missing sitemap.xml File',
        titleAr: 'خريطة الموقع لمحركات البحث (sitemap.xml) مش موجودة',
        kind: 'recommendation',
        severity: 'low',
        confidence: 'confirmed',
        affectsVerdict: false,
        method: 'http',
        source: 'rule',
        url,
        where: dom.defaultWhere('ملف /sitemap.xml', '/sitemap.xml'),
        occurrences: 1,
        observed: 'Request to /sitemap.xml did not return an XML sitemap',
        expected: 'A valid /sitemap.xml listing indexable pages',
        steps: ['افتح /sitemap.xml على دومين الموقع وشوف هل خريطة الصفحات موجودة'],
        evidence: [{ type: 'url', value: '/sitemap.xml (missing)', ref: '/sitemap.xml' }],
        whyItMattersAr: 'خريطة الموقع بتسهل على جوجل اكتشاف كل صفحاتك المهمة وأرشفتها أسرع.',
        recommendedFix: 'أنشئ ملف sitemap.xml لصفحات الموقع الأساسية وضيف رابطه في Google Search Console وملف robots.txt.'
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Responsive Viewport & Fixed Widths (R007 / R005)
  // ---------------------------------------------------------------------------
  if (!viewportEl || !/width\s*=\s*device-width/i.test(viewportContent)) {
    rawFindings.push({
      id: 'f_r007_viewport',
      ruleId: 'R007',
      category: 'responsive',
      title: 'Missing or Incomplete Mobile Viewport Meta Tag',
      titleAr: 'إعداد تظبيط الشاشة للموبايل (Viewport Meta) ناقص',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: viewportEl ? dom.locate(viewportEl) : {
        pageUrl: url,
        sectionAr: 'الهيدر',
        visibleText: 'meta viewport',
        selector: 'head > meta[name="viewport"]',
        snippet: '<head> (missing viewport meta)'
      },
      occurrences: 1,
      observed: 'No <meta name="viewport" content="width=device-width..."> found',
      expected: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      steps: ['افتح الموقع من الموبايل هتلاقي الصفحة مصغرة كأنها شاشة كمبيوتر'],
      evidence: [{ type: 'snippet', value: 'Missing <meta name="viewport" content="width=device-width, initial-scale=1">', ref: 'head' }],
      recommendedFix: 'ضيف وسم <meta name="viewport" content="width=device-width, initial-scale=1.0"> جوة <head>.'
    });
  } else {
    passes.push({
      id: 'pass_viewport',
      ruleId: 'R007',
      category: 'responsive',
      titleAr: 'وسم تظبيط مقاس الموبايل (Viewport) موجود',
      detailAr: 'الصفحة مجهزة إنها تتعرف على عرض شاشة الموبايل.',
      evidence: viewportContent,
      method: 'static_html'
    });
  }

  const styledElements = dom.root.querySelectorAll('[style]');
  const wideFixedElements: { el: HTMLElement; px: number; snippet: string }[] = [];
  for (const el of styledElements) {
    if (isInsideNoscriptOrTemplate(el)) continue;
    const st = el.getAttribute('style') || '';
    const m = st.match(/(?:^|;|\s)width\s*:\s*([4-9]\d{2}|[1-9]\d{3,})px/i);
    if (m) {
      const px = Number(m[1]);
      if (px > 420 && !/max-width\s*:\s*100%/i.test(st)) {
        const where = dom.locate(el);
        wideFixedElements.push({ el, px, snippet: where.snippet });
      }
    }
  }

  if (wideFixedElements.length > 0) {
    const firstWideWhere = dom.locate(wideFixedElements[0].el);
    rawFindings.push({
      id: 'f_r005_fixed_width',
      ruleId: 'R005',
      category: 'responsive',
      title: `Inline Fixed Pixel Widths (>420px) Found in ${wideFixedElements.length} Element(s)`,
      titleAr: `لقيت ${wideFixedElements.length} عنصر واخد عرض ثابت بالبيكسل ممكن يخرّج التصميم بره شاشة الموبايل`,
      kind: 'suspected_issue',
      severity: 'medium',
      confidence: 'likely',
      affectsVerdict: false,
      method: 'static_html',
      needsHumanDecision: true,
      source: 'rule',
      url,
      where: firstWideWhere,
      scope: isSharedTemplateSectionAr(firstWideWhere.sectionAr) ? 'site-wide' : 'page',
      occurrences: wideFixedElements.length,
      observed: `Found ${wideFixedElements.length} element(s) with inline fixed pixel width > 420px without max-width: 100%`,
      expected: 'Responsive width (width: 100%; max-width: ...)',
      steps: ['افتح الصفحة من موبايل (عرض 360–390 بيكسل) وجرب تحرك الشاشة يمين وشمال'],
      evidence: wideFixedElements.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.snippet,
        ref: item.snippet
      })),
      recommendedFix: getPlatformAwareFix('R005', profile, { isHttps })
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Placeholder Links Split (R003_LANG / R003_SOCIAL / R003) — PHASE J1 A3
  // ---------------------------------------------------------------------------
  const translationSignal = detectKnownTranslationSignals(html, dom.root, profile);
  if (translationSignal.detected) {
    passes.push({
      id: 'pass_lang_switcher',
      ruleId: 'R003_LANG',
      category: 'content',
      titleAr: 'وسيلة تغيير اللغة أو الترجمة موجودة في الكود',
      detailAr: `تم رصد إشارة ترجمة أو لغة بديلة (${translationSignal.detail}).`,
      evidence: translationSignal.detail,
      method: 'static_html'
    });
  }

  const allAnchors = dom.root
    .querySelectorAll('a')
    .filter(a => !isInsideNoscriptOrTemplate(a));

  const langHashItems: { el: HTMLElement; where: FindingWhere; hasToggleHint: boolean }[] = [];
  const socialHashItems: { el: HTMLElement; where: FindingWhere }[] = [];
  const genericHashItems: { el: HTMLElement; where: FindingWhere }[] = [];

  for (const a of allAnchors) {
    const href = (a.getAttribute('href') || '').trim();
    if (
      href !== '#' &&
      href.toLowerCase() !== 'javascript:void(0)' &&
      href.toLowerCase() !== 'javascript:;'
    ) {
      continue;
    }

    const role = (a.getAttribute('role') || '').toLowerCase();
    if (
      role === 'button' ||
      role === 'tab' ||
      role === 'menuitem' ||
      a.hasAttribute('aria-controls') ||
      a.hasAttribute('aria-expanded') ||
      a.hasAttribute('data-bs-toggle') ||
      a.hasAttribute('data-toggle') ||
      a.hasAttribute('data-elementor-open-lightbox')
    ) {
      continue;
    }

    const clsIdAria = `${a.getAttribute('id') || ''} ${a.getAttribute('class') || ''} ${
      a.getAttribute('aria-label') || ''
    } ${a.getAttribute('title') || ''} ${a.getAttribute('onclick') || ''}`;
    const textContent = collapseWhitespace(a.text);
    const where = dom.locate(a);

    const isLangText = /^(?:en|english|ar|عربي|العربية|fr|de)$/i.test(textContent);
    const hasLangHintAttr =
      /\b(?:lang|language|translate|locale|wpml|polylang|pll|glink)\b|abyadlanguagebutton/i.test(
        clsIdAria
      ) || Boolean(a.getAttribute('onclick'));

    const isSocial =
      /\b(?:facebook|instagram|linkedin|twitter|x-twitter|tiktok|youtube|whatsapp|social|fab\s+fa-)\b/i.test(
        `${clsIdAria} ${a.innerHTML}`
      );

    if (isLangText || hasLangHintAttr) {
      langHashItems.push({
        el: a,
        where,
        hasToggleHint: hasLangHintAttr || Boolean(a.getAttribute('id'))
      });
    } else if (isSocial) {
      socialHashItems.push({ el: a, where });
    } else {
      genericHashItems.push({ el: a, where });
    }
  }

  // R003_LANG Tiers (A3):
  // Tier (a): known translation signals -> no finding + PASS (already added above)
  if (!translationSignal.detected && langHashItems.length > 0) {
    const firstLang = langHashItems[0];
    const isTierB = langHashItems.some(item => item.hasToggleHint);
    const langScope = isSharedTemplateSectionAr(firstLang.where.sectionAr) ? 'site-wide' : 'page';
    const langWording =
      'ما قدرتش أتأكد من غير ما أضغط عليه في متصفح حقيقي. جرّب بنفسك: اضغط EN، لو الصفحة ما اتغيرتش يبقى مش شغال.';

    rawFindings.push({
      id: 'f_r003_lang',
      ruleId: 'R003_LANG',
      category: 'content',
      title: 'Language Switcher Link Uses href="#" Without Verified Static Target',
      titleAr: 'زرار تغيير اللغة (EN) مربوط بـ href="#" ومحتاج تجربة ضغط حقيقية',
      kind: 'suspected_issue',
      severity: 'low',
      confidence: isTierB ? 'likely' : 'suspected',
      affectsVerdict: false,
      method: 'static_html',
      needsHumanDecision: true,
      source: 'rule',
      url,
      where: firstLang.where,
      scope: langScope,
      occurrences: langHashItems.length,
      observed: langWording,
      expected: 'Working language toggle or dedicated alternate URL (e.g. /en) with hreflang',
      steps: [langWording],
      evidence: langHashItems.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.where.snippet,
        ref: item.where.snippet
      })),
      recommendedFix: getPlatformAwareFix('R003_LANG', profile, { isHttps })
    });

    notMeasured.push({
      id: 'nm_lang_click_test',
      checkId: 'R003_LANG',
      category: 'content',
      titleAr: 'تجربة الضغط الفعلي على زر تغيير اللغة (EN) في متصفح حي',
      reasonAr:
        'قريت كود الصفحة من غير ما أفتحها في متصفح، فمش هقدر أضغط على الزر وأشوف هل بيشغّل جافاسكريبت ولا لأ.',
      whyNotMeasuredAr:
        'قريت كود الصفحة من غير ما أفتحها في متصفح، فمش هقدر أضغط على الزر وأشوف هل بيشغّل جافاسكريبت ولا لأ.',
      howItWillWorkAr:
        'لما يتوفر متصفح تفاعلي هضغط على الزر وأتأكد إن نص الصفحة واللغة بيتغيروا فعلياً.',
      whenAr: 'قريبًا (أول ما تتفعل ميزة تجربة الأزرار التفاعلية).',
      missingCapability: 'browserRendering',
      chipAr: 'قريبًا'
    });
  }

  if (socialHashItems.length > 0) {
    const firstSocial = socialHashItems[0];
    rawFindings.push({
      id: 'f_r003_social',
      ruleId: 'R003_SOCIAL',
      category: 'links',
      title: `Social Media Icons Pointing to Placeholder href="#" (${socialHashItems.length})`,
      titleAr: `أيقونات السوشيال ميديا (${socialHashItems.length}) مربوطة بـ (#) ومش بتفتح صفحات الشركة`,
      kind: 'suspected_issue',
      severity: 'low',
      confidence: 'likely',
      affectsVerdict: false,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstSocial.where,
      scope: isSharedTemplateSectionAr(firstSocial.where.sectionAr) ? 'site-wide' : 'page',
      occurrences: socialHashItems.length,
      observed: `Found ${socialHashItems.length} social icon link(s) with href="#"`,
      expected: 'Valid external URLs to official social profiles or removal of unused icons',
      steps: ['اضغط على أيقونات فيسبوك/إنستجرام/لينكدإن في الهيدر أو الفوتر'],
      evidence: socialHashItems.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.where.snippet,
        ref: item.where.snippet
      })),
      recommendedFix: getPlatformAwareFix('R003_SOCIAL', profile, { isHttps })
    });
  }

  if (genericHashItems.length > 0) {
    const firstGen = genericHashItems[0];
    rawFindings.push({
      id: 'f_r003_generic',
      ruleId: 'R003',
      category: 'links',
      title: `Links With Empty Placeholder href="#" (${genericHashItems.length})`,
      titleAr: `فيه ${genericHashItems.length} رابط في الصفحة مربوط بعلامة (#) من غير وجهة`,
      kind: 'suspected_issue',
      severity: 'low',
      confidence: 'likely',
      affectsVerdict: false,
      method: 'static_html',
      needsHumanDecision: true,
      source: 'rule',
      url,
      where: firstGen.where,
      scope: isSharedTemplateSectionAr(firstGen.where.sectionAr) ? 'site-wide' : 'page',
      occurrences: genericHashItems.length,
      observed: `Found ${genericHashItems.length} anchor(s) with href="#"`,
      expected: 'Real destination URL or <button type="button"> for JS actions',
      steps: ['اضغط على الروابط دي واتأكد هل بتفتح حاجة ولا مجرد روابط منسية'],
      evidence: genericHashItems.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.where.snippet,
        ref: item.where.snippet
      })),
      recommendedFix: getPlatformAwareFix('R003', profile, { isHttps })
    });
  }

  // ---------------------------------------------------------------------------
  // 4b. Rule RX001: WhatsApp Link Format Validation (P2b.6)
  // ---------------------------------------------------------------------------
  const waLinks: { el: HTMLElement; href: string; where: FindingWhere }[] = [];
  for (const a of allAnchors) {
    const href = (a.getAttribute('href') || '').trim();
    if (
      /wa\.me\//i.test(href) ||
      /api\.whatsapp\.com\/send/i.test(href) ||
      /whatsapp:\/\/send/i.test(href)
    ) {
      waLinks.push({ el: a, href, where: dom.locate(a) });
    }
  }

  if (waLinks.length > 0) {
    // Always add NOT_MEASURED: مش بنتأكد إن الرقم عليه واتساب فعلًا
    notMeasured.push({
      id: 'nm_rx001_active',
      checkId: 'RX001_ACTIVE',
      category: 'links',
      titleAr: 'التحقق من تفعيل رقم الواتساب',
      reasonAr: 'مش بنتأكد إن الرقم عليه واتساب فعلًا (بنتأكد فقط من صحة صياغة وتنسيق الرابط الدولي)',
      method: 'static_html'
    });

    const badWaLinks: {
      href: string;
      rawPhone: string;
      correctedHref: string;
      where: FindingWhere;
    }[] = [];

    for (const item of waLinks) {
      let phonePart = '';
      const mWaMe = item.href.match(/wa\.me\/([^/?#]+)/i);
      const mApi = item.href.match(/[?&]phone=([^&#]+)/i);
      if (mWaMe) {
        phonePart = decodeURIComponent(mWaMe[1]).trim();
      } else if (mApi) {
        phonePart = decodeURIComponent(mApi[1]).trim();
      }

      if (phonePart) {
        const hasPlus = phonePart.startsWith('+') || phonePart.includes('+');
        const hasDoubleZero = phonePart.startsWith('00');
        const hasSeparators = /[\s\-()_.]/.test(phonePart);
        const cleanDigits = phonePart.replace(/\D/g, '');

        const isEgLocal = /^01[0125]\d{8}$/.test(cleanDigits);
        let correctedDigits = cleanDigits;
        if (isEgLocal) {
          correctedDigits = '2' + cleanDigits;
        } else if (cleanDigits.startsWith('0020')) {
          correctedDigits = cleanDigits.slice(2);
        }

        const isNonStandard =
          hasPlus || hasDoubleZero || hasSeparators || isEgLocal || !/^\d+$/.test(phonePart);

        if (isNonStandard) {
          const correctedHref = `https://wa.me/${correctedDigits}`;
          badWaLinks.push({
            href: item.href,
            rawPhone: phonePart,
            correctedHref,
            where: item.where
          });
        }
      }
    }

    if (badWaLinks.length > 0) {
      const firstBad = badWaLinks[0];
      rawFindings.push({
        id: 'f_rx001_wa_format',
        ruleId: 'RX001',
        category: 'links',
        title: 'Non-Standard WhatsApp Link Format',
        titleAr: 'رابط الواتساب مش بالصيغة الدولية الموثقة',
        kind: 'confirmed_defect',
        severity: 'medium',
        confidence: 'confirmed',
        affectsVerdict: true,
        method: 'static_html',
        source: 'rule',
        url,
        where: firstBad.where,
        occurrences: badWaLinks.length,
        observed: `الرقم مش بصيغة واتساب الموثّقة، غالبًا الرابط مش هيفتح المحادثة الصحيحة (${firstBad.rawPhone}).`,
        expected:
          'International phone format with digits only (no +, no 00, no spaces or dashes)',
        steps: [
          'اضغط على رابط الواتساب من الموبايل واتأكد هل بيفتح المحادثة مباشرة أو بيعطي خطأ في الرقم'
        ],
        evidence: badWaLinks.slice(0, 3).map((bw, i) => ({
          id: `ev_rx001_${i}`,
          type: 'snippet',
          value: `الرابط الحالي: ${bw.href} -> الرقم المقروء: ${bw.rawPhone}`,
          ref: bw.href
        })),
        whyItMattersAr:
          'العميل اللي يضغط ممكن ما يلاقيش محادثة تفتح ويضيع عليك تواصل مهم أو فرصة مبيعات.',
        recommendedFix: `عدل الرابط ليكون بالصيغة الدولية المباشرة بأرقام فقط: ${firstBad.correctedHref}`
      });
    } else {
      passes.push({
        id: 'pass_wa_format',
        ruleId: 'RX001',
        category: 'links',
        titleAr: 'روابط الواتساب مكتوبة بالصيغة الدولية الموثقة',
        detailAr: 'أرقام الواتساب مكتوبة بدون علامات زائد أو مسافات ومتوافقة مع معايير wa.me.',
        evidence: waLinks[0].href,
        method: 'static_html'
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Image Alt Audit: Missing Alt (R012) vs Generic Repeated Alt (RC005) — PHASE J1 A3
  // ---------------------------------------------------------------------------
  const allImgElements = dom.root.querySelectorAll('img');
  const missingAltItems: { el: HTMLElement; where: FindingWhere }[] = [];
  const altGroups = new Map<
    string,
    {
      altText: string;
      elements: HTMLElement[];
      distinctSrcs: Set<string>;
      nonGalleryCount: number;
    }
  >();
  let validAltCount = 0;

  for (const imgEl of allImgElements) {
    const classification = isTrackingOrDecorativeImage(imgEl);
    if (classification.skipCompletely) {
      continue;
    }
    if (classification.isDecorativeEmptyAlt) {
      validAltCount++;
      continue;
    }

    if (!imgEl.hasAttribute('alt')) {
      missingAltItems.push({ el: imgEl, where: dom.locate(imgEl) });
    } else {
      const altVal = collapseWhitespace(imgEl.getAttribute('alt'));
      if (!altVal) {
        validAltCount++;
        continue;
      }
      validAltCount++;
      const srcVal =
        imgEl.getAttribute('src') ||
        imgEl.getAttribute('data-src') ||
        imgEl.getAttribute('data-lazy-src') ||
        `img_${validAltCount}`;
      const srcKey = normalizeImageSrcKey(srcVal);
      const inGallery = isInsideProductGallery(imgEl);

      const existing = altGroups.get(altVal) || {
        altText: altVal,
        elements: [],
        distinctSrcs: new Set<string>(),
        nonGalleryCount: 0
      };
      existing.elements.push(imgEl);
      existing.distinctSrcs.add(srcKey);
      if (!inGallery) {
        existing.nonGalleryCount++;
      }
      altGroups.set(altVal, existing);
    }
  }

  if (missingAltItems.length > 0) {
    const firstMissing = missingAltItems[0];
    const count = missingAltItems.length;
    rawFindings.push({
      id: 'f_r012_missing_alt',
      ruleId: 'R012',
      category: 'accessibility',
      title: `${count} Image(s) Missing Alt Attribute`,
      titleAr: `فيه ${count} صورة من غير خاصية الوصف البديل (alt)`,
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstMissing.where,
      scope: isSharedTemplateSectionAr(firstMissing.where.sectionAr) ? 'site-wide' : 'page',
      occurrences: count,
      observed: `Found ${count} <img> tag(s) lacking an alt attribute entirely`,
      expected: 'Descriptive alt text for content images, or alt="" for decorative images',
      steps: ['افحص وسوم <img> في الصفحة واتأكد من وجود alt'],
      evidence: missingAltItems.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.where.snippet,
        ref: item.where.snippet
      })),
      recommendedFix: getPlatformAwareFix('R012', profile, { isHttps })
    });
  } else if (validAltCount > 0) {
    passes.push({
      id: 'pass_img_alt_present',
      ruleId: 'R012',
      category: 'accessibility',
      titleAr: 'كل الصور اللي اتفحصت فيها خاصية alt موجودة',
      detailAr: `تم فحص ${validAltCount} صورة وكلها بتحتوي على وسم alt.`,
      evidence: `${validAltCount} <img> tags have alt attributes`,
      method: 'static_html'
    });
  }

  // RC005: Flag ONLY a generic repeated alt (site/brand name or repeated across non-gallery sections) across DIFFERENT images (distinctSrcs >= 4)
  const isProductDetailPage = /\/product(?:s)?\/|\/item\//i.test(url);
  const pageH1Text = h1Elements.length > 0 ? collapseWhitespace(h1Elements[0].text) : '';
  const normalizedH1ForAlt = pageH1Text.replace(/[^\p{L}\p{N}\s]/gu, '').trim().toLowerCase();

  let worstRepeatedGroup: {
    altText: string;
    elements: HTMLElement[];
    distinctSrcs: Set<string>;
    nonGalleryCount: number;
  } | null = null;

  for (const grp of altGroups.values()) {
    if (grp.distinctSrcs.size < 4) continue;
    // If all occurrences are inside a product gallery, it's a product title on its gallery -> skip
    if (grp.nonGalleryCount === 0) continue;

    // On a product detail page, if the repeated alt is the product's own H1 title, skip it
    const normalizedAltForH1 = grp.altText.replace(/[^\p{L}\p{N}\s]/gu, '').trim().toLowerCase();
    if (
      isProductDetailPage &&
      normalizedH1ForAlt.length >= 5 &&
      (normalizedAltForH1 === normalizedH1ForAlt ||
        normalizedAltForH1.includes(normalizedH1ForAlt) ||
        normalizedH1ForAlt.includes(normalizedAltForH1))
    ) {
      continue;
    }

    const lowerAlt = grp.altText.toLowerCase();
    const domainRoot = (registrableDomain.split('.')[0] || '').toLowerCase();
    const matchesBrandOrSite =
      (domainRoot.length >= 3 && lowerAlt.includes(domainRoot)) ||
      /مصنع|شركة|متجر|logo|شعار|الأبيض|الابيض/i.test(grp.altText) ||
      grp.nonGalleryCount >= 5;

    if (!matchesBrandOrSite) continue;
    if (!worstRepeatedGroup || grp.elements.length > worstRepeatedGroup.elements.length) {
      worstRepeatedGroup = grp;
    }
  }

  if (worstRepeatedGroup) {
    const repeatedCount = worstRepeatedGroup.elements.length;
    const firstRepeatedWhere = dom.locate(worstRepeatedGroup.elements[0]);
    rawFindings.push({
      id: 'f_rc005_repeated_alt',
      ruleId: 'RC005',
      category: 'seo',
      title: `Generic Repeated Alt Text Across ${repeatedCount} Images ("${worstRepeatedGroup.altText}")`,
      titleAr: `${repeatedCount} صورة واخدين نفس الوصف البديل المكرر بالظبط ("${worstRepeatedGroup.altText}")`,
      kind: 'recommendation',
      severity: 'low',
      confidence: 'confirmed',
      affectsVerdict: false,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstRepeatedWhere,
      scope: isSharedTemplateSectionAr(firstRepeatedWhere.sectionAr) ? 'site-wide' : 'page',
      occurrences: repeatedCount,
      observed: `${repeatedCount} صورة مختلفة واخدين نفس النص البديل ("${worstRepeatedGroup.altText}") على ${worstRepeatedGroup.distinctSrcs.size} ملف صورة مختلف بدل وصف كل صورة لوحدها.`,
      expected: 'Each product or section image should describe its own specific content',
      steps: ['افتح مصدر الصفحة وشوف خاصية alt على الصور هتلاقي نفس الجملة مكررة'],
      evidence: worstRepeatedGroup.elements.slice(0, 3).map(el => {
        const w = dom.locate(el);
        return {
          type: 'snippet',
          value: w.snippet,
          ref: w.snippet
        };
      }),
      recommendedFix: getPlatformAwareFix('RC005', profile, {
        isHttps
      })
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Media & Performance (R013): Video Poster, Sampled Image Sizes, TTFB, PSI
  // ---------------------------------------------------------------------------
  // A3: List as evidence ONLY videos lacking poster
  const allVideos = dom.root
    .querySelectorAll('video')
    .filter(v => !isInsideNoscriptOrTemplate(v));
  const posterlessVideos = allVideos.filter(v => {
    const poster = (v.getAttribute('poster') || '').trim();
    return !poster;
  });

  if (posterlessVideos.length > 0) {
    const firstVideoWhere = dom.locate(posterlessVideos[0]);
    const videoWording = 'ما قدرتش أقيس تأثيره؛ الأحسن تحط poster وpreload=metadata';
    rawFindings.push({
      id: 'f_r013_video_hero',
      ruleId: 'R013',
      category: 'performance',
      title: 'Video Element Without Poster Image',
      titleAr: 'فيديو في الصفحة من غير صورة غلاف مبدئية (poster)',
      kind: 'recommendation',
      severity: 'low',
      confidence: 'likely',
      affectsVerdict: false,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstVideoWhere,
      occurrences: posterlessVideos.length,
      observed: `لقيت ${posterlessVideos.length} عنصر <video> من غير خاصية poster — ${videoWording}.`,
      expected: 'Include poster="..." image and preload="metadata" on <video> elements',
      steps: ['افحص وسم <video> في الكود واتأكد من وجود خاصية poster فقط على الفيديوهات اللي ناقصها غلاف'],
      evidence: posterlessVideos.slice(0, 3).map(v => {
        const w = dom.locate(v);
        return {
          type: 'snippet',
          value: w.snippet,
          ref: w.snippet
        };
      }),
      recommendedFix: `${videoWording}. ${getPlatformAwareFix('R013', profile, { isHttps })}`
    });
  }

  // Rule RX002 (P2b.7): Broken images detected via HEAD returning 404 or network error
  const brokenImages = sampledImageSizes.filter(
    img => img.broken || img.status === 404 || (typeof img.status === 'number' && img.status >= 400)
  );
  if (brokenImages.length > 0) {
    rawFindings.push({
      id: 'f_rx002_broken_images',
      ruleId: 'RX002',
      category: 'content',
      title: `Broken Image(s) Returning 404/Error (${brokenImages.length})`,
      titleAr: `صور مكسورة لا تفتح (404) في الصفحة (${brokenImages.length})`,
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'http',
      source: 'rule',
      url,
      where: dom.defaultWhere('صور مكسورة 404', brokenImages[0].url),
      occurrences: brokenImages.length,
      observed: `HEAD requests confirmed ${brokenImages.length} image(s) returning 404 or network failure; first: ${brokenImages[0].url}`,
      expected: 'All <img> src URLs must return HTTP 200 with valid image content',
      steps: ['افتح رابط الصورة في لسان جديد واتأكد إذا كان السيرفر بيرجع 404 Not Found'],
      evidence: brokenImages.slice(0, 5).map((img, i) => ({
        id: `ev_rx002_${i}`,
        type: 'measurement',
        value: `${img.url} -> HTTP ${img.status || 'Failed'}`,
        ref: img.url
      })),
      whyItMattersAr:
        'الزائر هيشوف أيقونة صورة مكسورة ومساحة فاضية بتدي انطباع إن الموقع مش كامل وممكن يفقد الثقة فيه.',
      recommendedFix:
        'ارفع الصور الناقصة على السيرفر أو عدل مسار الـ src للرابط الصحيح، أو احذف وسوم الصور المكسورة.'
    });
  }

  // Sampled image byte sizes via HEAD (P2b.5: finding only when measured)
  const heavyImages = sampledImageSizes.filter(img => img.bytes > 350 * 1024);
  if (heavyImages.length > 0) {
    const largest = [...heavyImages].sort((a, b) => b.bytes - a.bytes)[0];
    const kb = Math.round(largest.bytes / 1024);
    rawFindings.push({
      id: 'f_r013_heavy_images',
      ruleId: 'R013',
      category: 'performance',
      title: `${heavyImages.length} Heavy Image(s) Over 350 KB (Largest: ${kb} KB)`,
      titleAr: `فيه ${heavyImages.length} صورة حجمها تقيل جداً (أكبرهم ${kb} كيلوبايت) بتبطّأ التحميل`,
      kind: 'confirmed_defect',
      severity: kb > 1000 ? 'high' : 'medium',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'http',
      source: 'rule',
      url,
      where: dom.defaultWhere(`صورة كبيرة (${kb} KB)`, largest.url),
      occurrences: heavyImages.length,
      observed: `HEAD requests confirmed ${heavyImages.length} image(s) > 350KB; largest is ${kb}KB (${largest.url})`,
      expected: 'Compressed WebP/AVIF images typically under 200 KB',
      steps: ['افتح تبويب Network → Img وشوف عمود Size للصور'],
      evidence: heavyImages.slice(0, 3).map((img, i) => ({
        id: `ev_heavy_img_${i}`,
        type: 'measurement',
        value: `${img.url} -> ${Math.round(img.bytes / 1024)} KB`,
        ref: `${Math.round(img.bytes / 1024)} KB`
      })),
      whyItMattersAr: 'الصور التقيلة بتستهلك باقة الزائر وبتأخر فتح الموقع على شبكات الموبايل.',
      recommendedFix: getPlatformAwareFix('R013', profile, { isHttps })
    });
  }

  // ---------------------------------------------------------------------------
  // 6b. Grouped Mobile Performance Finding: "الأداء على الموبايل" (P2b.2 & P2b.3)
  // ---------------------------------------------------------------------------
  const hasAnyPsiMetric = Boolean(
    psiData &&
      (typeof psiData.lcpMs === 'number' ||
        typeof psiData.cls === 'number' ||
        typeof psiData.tbtMs === 'number' ||
        typeof psiData.performanceScore === 'number')
  );

  const roundedTtfb =
    typeof ttfbMs === 'number' && ttfbMs > 0 ? Math.round(ttfbMs) : undefined;
  const roundedLcpMs =
    hasAnyPsiMetric && typeof psiData?.lcpMs === 'number'
      ? Math.round(psiData.lcpMs)
      : undefined;
  const roundedTbtMs =
    hasAnyPsiMetric && typeof psiData?.tbtMs === 'number'
      ? Math.round(psiData.tbtMs)
      : undefined;
  const perfScore =
    hasAnyPsiMetric && typeof psiData?.performanceScore === 'number'
      ? Math.round(psiData.performanceScore)
      : undefined;
  const clsVal =
    hasAnyPsiMetric && typeof psiData?.cls === 'number'
      ? Number(psiData.cls.toFixed(3))
      : undefined;

  const hasFieldData = Boolean(psiData?.fieldData);
  const fieldConfirmsSlow =
    hasFieldData &&
    (psiData?.fieldData?.overallCategory === 'SLOW' ||
      psiData?.fieldData?.overallCategory === 'AVERAGE' ||
      (typeof psiData?.fieldData?.lcpMs?.percentile === 'number' &&
        psiData.fieldData.lcpMs.percentile > 2500) ||
      (typeof psiData?.fieldData?.cls?.percentile === 'number' &&
        psiData.fieldData.cls.percentile > 0.1) ||
      (typeof psiData?.fieldData?.inpMs?.percentile === 'number' &&
        psiData.fieldData.inpMs.percentile > 200));

  const isTtfbSlow = typeof roundedTtfb === 'number' && roundedTtfb > 800;
  const isLcpSlow = typeof roundedLcpMs === 'number' && roundedLcpMs > 2500;
  const isClsHigh = typeof clsVal === 'number' && clsVal > 0.1;
  const isTbtHigh = typeof roundedTbtMs === 'number' && roundedTbtMs > 200;

  // B1.3b Lab-only bands:
  // LCP <=2.5s pass; 2.5–4.0s "تحسين مقترح" (low, recommendation, affectsVerdict=false); >4.0s medium/confirmed(lab) affectsVerdict=true.
  // CLS <=0.1 pass; 0.1–0.25 low; >0.25 medium.
  // TBT <=200ms pass; 201–600 low; >600 medium.
  const lcpBand: 'pass' | 'low' | 'medium' =
    typeof roundedLcpMs !== 'number' || roundedLcpMs <= 2500
      ? 'pass'
      : roundedLcpMs <= 4000
        ? 'low'
        : 'medium';
  const clsBand: 'pass' | 'low' | 'medium' =
    typeof clsVal !== 'number' || clsVal <= 0.1
      ? 'pass'
      : clsVal <= 0.25
        ? 'low'
        : 'medium';
  const tbtBand: 'pass' | 'low' | 'medium' =
    typeof roundedTbtMs !== 'number' || roundedTbtMs <= 200
      ? 'pass'
      : roundedTbtMs <= 600
        ? 'low'
        : 'medium';
  const ttfbBand: 'pass' | 'low' | 'medium' | 'high' =
    typeof roundedTtfb !== 'number' || roundedTtfb <= 800
      ? 'pass'
      : roundedTtfb <= 1800
        ? 'low'
        : roundedTtfb <= 2500
          ? 'medium'
          : 'high';

  // P2b.5: Performance score alone never creates a finding; requires degraded metric
  const hasDegradedMetric = isTtfbSlow || isLcpSlow || isClsHigh || isTbtHigh;

  if (hasDegradedMetric) {
    const measurementsTableLines = [
      'جدول قياسات الأداء:',
      `• استجابة السيرفر (TTFB): ${roundedTtfb ? `${roundedTtfb} ms` : 'غير متوفر'}`,
      `• ظهور المحتوى الأساسي (LCP): ${
        roundedLcpMs ? `${(roundedLcpMs / 1000).toFixed(1)}s (${roundedLcpMs} ms)` : 'غير متوفر'
      }`,
      `• ثبات عناصر الصفحة (CLS): ${clsVal !== undefined ? `${clsVal}` : 'غير متوفر'}`,
      `• وقت حظر المتصفح (TBT): ${roundedTbtMs ? `${roundedTbtMs} ms` : 'غير متوفر'}`,
      `• تقييم أداء Lighthouse: ${perfScore !== undefined ? `${perfScore}/100 (مؤشر استرشادي)` : 'غير متوفر'}`
    ];

    if (psiData?.cacheLabelAr) {
      measurementsTableLines.push(`• حالة القياس: ${psiData.cacheLabelAr}`);
    }

    if (psiData?.lcpElement) {
      measurementsTableLines.push(
        `• العنصر اللي بيعطّل: ${psiData.lcpElement.selector || psiData.lcpElement.snippet || psiData.lcpElement.type}`
      );
    }

    const labNotice = !hasFieldData
      ? 'ده قياس معملي، مش بالضرورة اللي زوارك الحقيقيين بيشوفوه (لم تتوفر بيانات زوار حقيقيين CrUX).'
      : '';

    const observedPerformance = `${measurementsTableLines.join('\n')}\n\n${labNotice}`.trim();

    const perfEvidence: Evidence[] = [];
    if (psiData?.cacheLabelAr) {
      perfEvidence.push({
        id: 'ev_perf_cache_status',
        type: 'measurement',
        value: psiData.cacheLabelAr,
        ref: 'psi_cache'
      });
    }
    if (typeof roundedTtfb === 'number') {
      perfEvidence.push({
        id: 'ev_perf_ttfb',
        type: 'measurement',
        value: `TTFB = ${roundedTtfb} ms`,
        ref: `TTFB = ${roundedTtfb} ms`
      });
    }
    if (typeof roundedLcpMs === 'number') {
      perfEvidence.push({
        id: 'ev_perf_lcp',
        type: 'measurement',
        value: `PSI mobile LCP = ${roundedLcpMs} ms (${(roundedLcpMs / 1000).toFixed(1)}s)`,
        ref: `LCP = ${(roundedLcpMs / 1000).toFixed(1)}s`
      });
    }
    if (typeof clsVal === 'number') {
      perfEvidence.push({
        id: 'ev_perf_cls',
        type: 'measurement',
        value: `PSI mobile CLS = ${clsVal}`,
        ref: `CLS = ${clsVal}`
      });
    }
    if (typeof roundedTbtMs === 'number') {
      perfEvidence.push({
        id: 'ev_perf_tbt',
        type: 'measurement',
        value: `PSI mobile TBT = ${roundedTbtMs} ms`,
        ref: `TBT = ${roundedTbtMs} ms`
      });
    }
    if (typeof perfScore === 'number') {
      perfEvidence.push({
        id: 'ev_perf_score',
        type: 'measurement',
        value: `Lighthouse Performance Score = ${perfScore}/100`,
        ref: `Score = ${perfScore}/100`
      });
    }
    if (psiData?.lcpElement) {
      perfEvidence.push({
        id: 'ev_perf_lcp_elem',
        type: 'dom_snippet',
        value: `LCP Element (${psiData.lcpElement.type}): ${psiData.lcpElement.selector || ''} | ${psiData.lcpElement.snippet || ''}`,
        ref: psiData.lcpElement.snippet || psiData.lcpElement.selector || 'LCP Element',
        location: psiData.lcpElement.selector
      });
    }
    (psiData?.topOpportunities || []).slice(0, 3).forEach((opp, idx) => {
      perfEvidence.push({
        id: `ev_perf_opp_${idx}`,
        type: 'lighthouse_audit',
        value: `Opportunity: ${opp.title}${opp.displayValue ? ` (${opp.displayValue})` : ''}`,
        ref: opp.title
      });
    });
    if (!hasFieldData) {
      perfEvidence.push({
        id: 'ev_perf_lab_note',
        type: 'measurement',
        value: 'ده قياس معملي، مش بالضرورة اللي زوارك الحقيقيين بيشوفوه',
        ref: 'lab_measurement'
      });
    }

    // P2b.2: Cause-to-fix rule citing evidence IDs
    const fixList: string[] = [];
    if (psiData?.lcpElement) {
      const lcpType = psiData.lcpElement.type.toLowerCase();
      const lcpSnippet = (psiData.lcpElement.snippet || '').toLowerCase();
      if (lcpType === 'video' || lcpSnippet.includes('<video')) {
        fixList.push(
          'استناداً إلى عنصر LCP [ev_perf_lcp_elem]: العنصر الأساسي هو فيديو. تأكد من إضافة صورة غلاف (poster)، واستخدام preload="metadata"، وضغط الفيديو عشان ما يعطلش تحميل الصفحة.'
        );
      } else if (
        lcpType === 'img' ||
        lcpType === 'image' ||
        /<img|image|picture/i.test(lcpSnippet)
      ) {
        fixList.push(
          'استناداً إلى عنصر LCP [ev_perf_lcp_elem]: العنصر الأساسي هو صورة. اضغط الصورة بصيغة حديثة (WebP أو AVIF)، وضيف وسم preload للصورة الأساسية في <head>، وحدد أبعاد واضحة (width و height) لمنع اهتزاز الصفحة [ev_perf_cls].'
        );
      } else if (
        lcpType === 'text' ||
        lcpType === 'h1' ||
        lcpType === 'p' ||
        /<h[1-6]|<p\b/i.test(lcpSnippet)
      ) {
        fixList.push(
          'استناداً إلى عنصر LCP [ev_perf_lcp_elem]: العنصر الأساسي هو نص أو عنوان (h1/p). سرّع ظهور النص عبر تفعيل font-display: swap في CSS و preloading لملفات الخط الحرج، وتخلص من ملفات CSS و JS التي تحظر العرض (Render-blocking).'
        );
      } else {
        fixList.push(
          'استناداً إلى قياس LCP [ev_perf_lcp]: السبب المحتمل: تأخر استجابة السيرفر أو ملفات تحظر الرسم. خطوة التحقق: افتح Network Waterfall في أدوات المطور للتأكد من أطول طلبات تحظر ظهور المحتوى.'
        );
      }
    } else if (isLcpSlow) {
      fixList.push(
        'استناداً إلى قياس LCP [ev_perf_lcp]: السبب المحتمل: تأخر استجابة السيرفر أو ملفات تحظر الرسم. خطوة التحقق: افتح Network Waterfall في أدوات المطور للتأكد من أطول طلبات تحظر ظهور المحتوى.'
      );
    }

    if (isTtfbSlow) {
      fixList.push(
        'استناداً إلى استجابة السيرفر [ev_perf_ttfb]: فعّل كاش كامل للصفحات (Full-Page Caching) واربط الموقع بـ CDN زي Cloudflare لتقليل زمن استجابة السيرفر.'
      );
    }
    if (isClsHigh) {
      fixList.push(
        'استناداً إلى ثبات التصميم [ev_perf_cls]: حدد أبعاد width و height لجميع الصور والبانرات لمنع تحرك العناصر فجأة.'
      );
    }
    if (isTbtHigh) {
      fixList.push(
        'استناداً إلى وقت الحظر [ev_perf_tbt]: قلل ملفات الجافاسكريبت التقيلة واستخدم defer أو async للسكريبتات الخارجية.'
      );
    }

    const hasPoorLabOrTtfb =
      lcpBand === 'medium' ||
      clsBand === 'medium' ||
      tbtBand === 'medium' ||
      ttfbBand === 'medium' ||
      ttfbBand === 'high';

    const isNeedsImprovementOnly = !hasPoorLabOrTtfb && !fieldConfirmsSlow;

    const effectiveSeverity = isNeedsImprovementOnly
      ? 'low'
      : (lcpBand === 'medium' && fieldConfirmsSlow) || ttfbBand === 'high'
        ? 'high'
        : 'medium';

    const observedWithBandNote = isNeedsImprovementOnly
      ? `${observedPerformance}\n• التصنيف: تحسين مقترح`
      : observedPerformance;

    let lcpWhere: FindingWhere = dom.defaultWhere('عنصر المحتوى الأساسي (LCP)');
    if (psiData?.lcpElement) {
      lcpWhere = {
        pageUrl: url,
        sectionAr: 'المحتوى الرئيسي',
        visibleText: collapseWhitespace(psiData.lcpElement.nodeLabel) || 'عنصر LCP الرئيسي',
        selector: psiData.lcpElement.selector || 'main',
        snippet: collapseWhitespace(psiData.lcpElement.snippet || '<main>').slice(0, 200)
      };
    }

    rawFindings.push({
      id: 'f_perf_mobile_grouped',
      ruleId: 'R013_PERF',
      category: 'performance',
      title: 'Mobile Performance Overview',
      titleAr: 'الأداء على الموبايل',
      kind: isNeedsImprovementOnly ? 'recommendation' : 'confirmed_defect',
      severity: effectiveSeverity,
      confidence: 'confirmed',
      affectsVerdict: !isNeedsImprovementOnly,
      method: hasAnyPsiMetric ? 'psi' : 'http',
      source: hasAnyPsiMetric ? 'lighthouse' : 'rule',
      url,
      where: lcpWhere,
      occurrences: 1,
      observed: observedWithBandNote,
      expected: 'Core Web Vitals on mobile: TTFB <= 800ms, LCP <= 2.5s, CLS <= 0.1, TBT <= 200ms',
      steps: [
        'افتح PageSpeed Insights وشوف أرقام LCP و CLS و TBT على الموبايل',
        'افتح أدوات المطور (F12) → Network وشوف وقت استجابة السيرفر (TTFB)'
      ],
      evidence: perfEvidence,
      whyItMattersAr: 'الزائر ممكن يستنى قبل ما يشوف المحتوى الأساسي؛ والقياس معملي.',
      recommendedFix: fixList.join(' ') || getPlatformAwareFix('R013', profile, { isHttps })
    });
  }

  // Record individual passes when metrics meet good thresholds
  if (typeof roundedTtfb === 'number' && !isTtfbSlow) {
    passes.push({
      id: 'pass_ttfb',
      ruleId: 'R013',
      category: 'performance',
      titleAr: `استجابة السيرفر المبدئية (TTFB) سريعة (${roundedTtfb} ms)`,
      detailAr: `السيرفر رد بأول بايت خلال ${roundedTtfb} مللي ثانية (أقل من حد جوجل الجيد 800ms).`,
      evidence: `TTFB = ${roundedTtfb} ms (<= 800ms Good threshold)`,
      method: 'http'
    });
  }

  if (hasAnyPsiMetric && psiData) {
    if (typeof roundedLcpMs === 'number' && !isLcpSlow) {
      passes.push({
        id: 'pass_psi_lcp',
        ruleId: 'R013',
        category: 'performance',
        titleAr: `سرعة ظهور المحتوى الرئيسي ممتازة: ${(roundedLcpMs / 1000).toFixed(1)}s (LCP) — قياس معملي من جوجل (محاكاة موبايل بطيء)`,
        detailAr: `أكبر عنصر مرئي ظهر خلال ${(roundedLcpMs / 1000).toFixed(1)} ثانية (أقل من حد جوجل 2.5 ثانية).`,
        evidence: `PSI mobile LCP = ${roundedLcpMs} ms`,
        method: 'psi'
      });
    }
    if (typeof clsVal === 'number' && !isClsHigh) {
      passes.push({
        id: 'pass_psi_cls',
        ruleId: 'R013',
        category: 'performance',
        titleAr: `ثبات عناصر الصفحة أثناء التحميل ممتاز (CLS = ${clsVal}) — قياس معملي من جوجل (محاكاة موبايل بطيء)`,
        detailAr: `العناصر ثابتة ومش بتتحرك فجأة وقت التحميل (أقل من 0.1).`,
        evidence: `PSI mobile CLS = ${clsVal}`,
        method: 'psi'
      });
    }
    if (typeof roundedTbtMs === 'number' && !isTbtHigh) {
      passes.push({
        id: 'pass_psi_tbt',
        ruleId: 'R013',
        category: 'performance',
        titleAr: `استجابة التفاعل وقت التحميل ممتازة (TBT = ${roundedTbtMs} ms) — قياس معملي من جوجل (محاكاة موبايل بطيء)`,
        detailAr: `وقت حظر المتصفح منخفض (${roundedTbtMs} مللي ثانية <= 200ms).`,
        evidence: `PSI mobile TBT = ${roundedTbtMs} ms`,
        method: 'psi'
      });
    }
    if (typeof perfScore === 'number' && perfScore >= 90) {
      passes.push({
        id: 'pass_psi_score',
        ruleId: 'R013',
        category: 'performance',
        titleAr: `تقييم الأداء الكلي على الموبايل ممتاز: \u2066${perfScore}/100\u2069 — قياس معملي من جوجل (محاكاة موبايل بطيء)`,
        detailAr: `الموقع حقق ${perfScore} من 100 في فحص سرعة الموبايل المعملي.`,
        evidence: `PSI mobile performance score = ${perfScore}/100`,
        method: 'psi'
      });
    }
    if (typeof psiData?.seoScore === 'number' && psiData.seoScore >= 90) {
      const seoScoreRounded = Math.round(psiData.seoScore);
      passes.push({
        id: 'pass_psi_seo',
        ruleId: 'R008',
        category: 'seo',
        titleAr: `نتيجة فحص السيو التقني (${seoScoreRounded}/100) — قياس معملي من جوجل`,
        detailAr: `أساسيات الفهرسة وعناوين الموبايل حققت ${seoScoreRounded} من 100 في فحص Lighthouse المعملي.`,
        evidence: `PSI mobile SEO score = ${seoScoreRounded}/100 (lab measurement)`,
        method: 'psi'
      });
    }

    // 5. Real-User Field Data (CrUX) — ONLY when returned by the PSI API
    if (psiData.fieldData) {
      const fd = psiData.fieldData;
      const scopeLabel = fd.source === 'url' ? 'للصفحة دي' : 'للموقع ككل (Origin)';
      const parts: string[] = [];
      if (typeof fd.lcpMs?.percentile === 'number') {
        parts.push(`LCP = ${(fd.lcpMs.percentile / 1000).toFixed(1)}s`);
      }
      if (typeof fd.cls?.percentile === 'number') {
        parts.push(`CLS = ${fd.cls.percentile}`);
      }
      if (typeof fd.inpMs?.percentile === 'number') {
        parts.push(`INP = ${fd.inpMs.percentile}ms`);
      }
      const summaryStr = parts.join(' | ');

      const hasSlowField =
        fd.overallCategory === 'SLOW' ||
        fd.overallCategory === 'AVERAGE' ||
        (typeof fd.lcpMs?.percentile === 'number' && fd.lcpMs.percentile > 2500) ||
        (typeof fd.cls?.percentile === 'number' && fd.cls.percentile > 0.1) ||
        (typeof fd.inpMs?.percentile === 'number' && fd.inpMs.percentile > 200);

      let fieldWhere: FindingWhere = dom.defaultWhere('عنصر المحتوى الأساسي (LCP)');
      if (psiData?.lcpElement) {
        fieldWhere = {
          pageUrl: url,
          sectionAr: 'المحتوى الرئيسي',
          visibleText: collapseWhitespace(psiData.lcpElement.nodeLabel) || 'عنصر LCP الرئيسي',
          selector: psiData.lcpElement.selector || 'main',
          snippet: collapseWhitespace(psiData.lcpElement.snippet || '<main>').slice(0, 200)
        };
      }

      if (summaryStr) {
        if (hasSlowField) {
          const isPoor =
            fd.overallCategory === 'SLOW' ||
            (typeof fd.lcpMs?.percentile === 'number' && fd.lcpMs.percentile > 4000) ||
            (typeof fd.cls?.percentile === 'number' && fd.cls.percentile > 0.25) ||
            (typeof fd.inpMs?.percentile === 'number' && fd.inpMs.percentile > 500);

          rawFindings.push({
            id: 'f_r013_psi_field',
            ruleId: 'R013',
            category: 'performance',
            title: `CrUX Real-User Field Data (${scopeLabel}): ${summaryStr}`,
            titleAr: `تجربة الزوار الفعليين (${scopeLabel}) محتاجة تحسين (${summaryStr}) — بيانات زوار حقيقيين من جوجل (CrUX)`,
            kind: 'confirmed_defect',
            severity: isPoor ? 'high' : 'medium',
            confidence: 'confirmed',
            affectsVerdict: true,
            method: 'psi',
            source: 'lighthouse',
            url,
            where: fieldWhere,
            occurrences: 1,
            observed: `بيانات زوار حقيقيين من جوجل (Chrome UX Report ${scopeLabel}): ${summaryStr}`,
            expected: 'Field CWV p75 within Good thresholds (LCP <= 2.5s, CLS <= 0.1, INP <= 200ms)',
            steps: ['افتح PageSpeed Insights وبص على قسم Discover what your real users are experiencing'],
            evidence: [
              {
                type: 'measurement',
                value: `CrUX field data (${fd.source}): ${summaryStr} [overall=${fd.overallCategory || 'N/A'}]`,
                ref: `CrUX (${fd.source}): ${summaryStr}`
              }
            ],
            whyItMattersAr: 'الأرقام دي متقاسة من زوار حقيقيين فتحوا الموقع فعلاً من موبايلاتهم.',
            recommendedFix: getPlatformAwareFix('R013', profile, { isHttps })
          });
        } else {
          passes.push({
            id: 'pass_psi_field',
            ruleId: 'R013',
            category: 'performance',
            titleAr: `سرعة الموقع عند الزوار الفعليين ممتازة (${summaryStr}) — بيانات زوار حقيقيين من جوجل (CrUX)`,
            detailAr: `بيانات زوار كروم الحقيقيين (${scopeLabel}): ${summaryStr}.`,
            evidence: `CrUX field data (${fd.source}): ${summaryStr}`,
            method: 'psi'
          });
        }
      }
    }
  } else if (psiNotMeasured) {
    notMeasured.push(psiNotMeasured);
  } else {
    notMeasured.push({
      id: 'nm_lcp_cls',
      checkId: 'R013',
      category: 'performance',
      titleAr: 'قياس سرعة ظهور الشاشة الفعلي (LCP / CLS)',
      reasonAr: caps.psi
        ? 'طلب PageSpeed Insights مارجعش أرقام للصفحة دي في المهلة المحددة — ومش بنخمّن أرقام سرعة.'
        : 'مفيش مفتاح PSI_API_KEY أو متصفح حي في البيئة دي — ومش بنخمّن أرقام سرعة من غير قياس حقيقي.',
      missingCapability: 'psi'
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Brand Spelling Consistency (RC001): "الأبيض" vs "الابيض"
  // ---------------------------------------------------------------------------
  if (visibleText.includes('الأبيض') && visibleText.includes('الابيض')) {
    const countWithHamza = (visibleText.match(/الأبيض/g) || []).length;
    const countWithoutHamza = (visibleText.match(/الابيض/g) || []).length;
    const firstTextNodeEl =
      dom.root.querySelectorAll('p, h1, h2, h3, li, span').find(el => {
        const txt = el.text || '';
        return txt.includes('الابيض') || txt.includes('الأبيض');
      }) || dom.root.querySelector('h1');

    rawFindings.push({
      id: 'f_rc001_brand_hamza',
      ruleId: 'RC001',
      category: 'content',
      title: 'Inconsistent Arabic Brand Spelling ("الأبيض" vs "الابيض")',
      titleAr: 'اسم البراند مكتوب بطريقتين في نفس الصفحة ("الأبيض" بالهمزة و"الابيض" من غير همزة)',
      kind: 'recommendation',
      severity: 'low',
      confidence: 'confirmed',
      affectsVerdict: false,
      method: 'static_html',
      needsHumanDecision: true,
      source: 'rule',
      url,
      where: firstTextNodeEl ? dom.locate(firstTextNodeEl) : dom.defaultWhere('اسم البراند'),
      occurrences: countWithHamza + countWithoutHamza,
      observed: `Found "الأبيض" (${countWithHamza}x) and "الابيض" (${countWithoutHamza}x) on the same page`,
      expected: 'Consistent official brand spelling across headings, body text, and metadata',
      steps: ['ابحث في الصفحة (Ctrl+F) عن "الأبيض" و"الابيض" وشوف الفرق'],
      evidence: [
        {
          type: 'quote',
          value: `"الأبيض" (${countWithHamza} مرات) مقابل "الابيض" (${countWithoutHamza} مرات)`,
          ref: 'الأبيض / الابيض'
        }
      ],
      recommendedFix: getPlatformAwareFix('RC001', profile, { isHttps })
    });
  }

  // ---------------------------------------------------------------------------
  // 8. Email vs Domain Mismatch (RC002) — PHASE J1 A3
  // Question only (kind: recommendation, severity: low) in "محتاج قرار منك",
  // not counted in main findings or verdict; escalate to "احتمال غلطة كتابة"
  // ONLY when Levenshtein distance <= 2 and not free-mail.
  // ---------------------------------------------------------------------------
  const mailtoAnchors = allAnchors.filter(a =>
    (a.getAttribute('href') || '').trim().toLowerCase().startsWith('mailto:')
  );
  const mismatchedEmails: { email: string; emailDomain: string; isTypo: boolean; where: FindingWhere }[] = [];

  for (const a of mailtoAnchors) {
    const rawHref = (a.getAttribute('href') || '').trim();
    const email = rawHref
      .replace(/^mailto:/i, '')
      .split('?')[0]
      .trim()
      .toLowerCase();
    const parts = email.split('@');
    if (parts.length !== 2) continue;
    const emailDomain = parts[1];
    const emailRegDomain = getRegistrableDomain(`https://${emailDomain}`) || emailDomain;

    if (
      registrableDomain &&
      emailRegDomain &&
      emailRegDomain !== registrableDomain &&
      !registrableDomain.includes('127.0.0.1') &&
      !registrableDomain.includes('localhost')
    ) {
      const isFreeMail = FREE_MAIL_DOMAINS.has(emailRegDomain.toLowerCase());
      const distFull = computeLevenshteinDistance(emailRegDomain, registrableDomain);
      const emailMainLabel = emailRegDomain.split('.')[0] || emailRegDomain;
      const siteMainLabel = registrableDomain.split('.')[0] || registrableDomain;
      const distLabel = computeLevenshteinDistance(emailMainLabel, siteMainLabel);
      const isTypo = !isFreeMail && Math.min(distFull, distLabel) <= 2;

      if (!mismatchedEmails.some(item => item.email === email)) {
        mismatchedEmails.push({
          email,
          emailDomain: emailRegDomain,
          isTypo,
          where: dom.locate(a)
        });
      }
    }
  }

  if (mismatchedEmails.length > 0) {
    const firstMismatch = mismatchedEmails[0];
    const builderHostCheck = isVerifiedBuilderHostedUrl(url);
    if (builderHostCheck.isBuilderHosted && builderHostCheck.host) {
      // B1.3e: Staging domain note replaces the email-domain question
      const stagingNoteAr = `الموقع لسه على دومين تجريبي من المنصة (${builderHostCheck.host}). لما تربط دومينك الأساسي راجع الإيميل والروابط تاني.`;
      rawFindings.push({
        id: 'f_rc002_staging_domain',
        ruleId: 'RC002',
        category: 'content',
        title: `Staging Domain on AI Builder Platform (${builderHostCheck.host})`,
        titleAr: stagingNoteAr,
        kind: 'recommendation',
        severity: 'low',
        confidence: 'confirmed',
        affectsVerdict: false,
        method: 'static_html',
        needsHumanDecision: true,
        source: 'rule',
        url,
        where: firstMismatch.where,
        scope: 'site-wide',
        occurrences: 1,
        observed: stagingNoteAr,
        expected: 'Verify contact email and links after connecting the primary custom domain',
        steps: ['لما تربط دومينك الأساسي راجع الإيميل والروابط تاني'],
        evidence: [
          {
            type: 'snippet',
            value: `Host: ${builderHostCheck.host} | mailto:${firstMismatch.email}`,
            ref: builderHostCheck.host
          }
        ],
        recommendedFix: stagingNoteAr
      });
    } else {
      const typoPrefixAr = firstMismatch.isTypo ? 'احتمال غلطة كتابة في دومين الإيميل: ' : '';
      rawFindings.push({
        id: 'f_rc002_email_domain',
        ruleId: 'RC002',
        category: 'content',
        title: `Contact Email Domain (${firstMismatch.email}) Differs From Site Domain (${registrableDomain})`,
        titleAr: `${typoPrefixAr}إيميل التواصل (${firstMismatch.email}) على دومين مختلف عن دومين الموقع (${registrableDomain}) — هل ده مقصود؟`,
        kind: 'recommendation',
        severity: 'low',
        confidence: 'likely',
        affectsVerdict: false,
        method: 'static_html',
        needsHumanDecision: true,
        source: 'rule',
        url,
        where: firstMismatch.where,
        scope: isSharedTemplateSectionAr(firstMismatch.where.sectionAr) ? 'site-wide' : 'page',
        occurrences: mismatchedEmails.length,
        observed: firstMismatch.isTypo
          ? `احتمال غلطة كتابة: إيميل التواصل (${firstMismatch.email}) قريب جداً في الحروف من دومين الموقع (${registrableDomain}).`
          : `لقيت إيميل التواصل (${firstMismatch.email}) على دومين مختلف عن دومين الموقع (${registrableDomain}) — محتاج قرار منك هل ده إيميل الشركة المعتمد ولا إيميل قديم.`,
        expected: `Official domain email (e.g. info@${registrableDomain}) or intentional verified address`,
        steps: ['راجع إيميل التواصل المكتوب في الموقع واتأكد إن الرسائل بتوصلك عليه'],
        evidence: mismatchedEmails.slice(0, 3).map(item => ({
          type: 'snippet',
          value: `mailto:${item.email} (site domain: ${registrableDomain})`,
          ref: item.email
        })),
        recommendedFix: getPlatformAwareFix('RC002', profile, { isHttps })
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Leaked CMS / Template Defaults (RC004) — PHASE J1 A3
  // severity: low, kind: recommendation, with where on the <meta> in <head>
  // ---------------------------------------------------------------------------
  const metaElements = dom.root.querySelectorAll('meta');
  const adminMetaElements = metaElements.filter(m => {
    const nameOrProp = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
    const content = (m.getAttribute('content') || '').trim().toLowerCase();
    return (nameOrProp === 'author' || nameOrProp === 'twitter:data1') && content === 'admin';
  });

  const leakedSnippets: string[] = [];
  let rc004Where: FindingWhere | undefined;

  if (adminMetaElements.length > 0) {
    rc004Where = dom.locate(adminMetaElements[0]);
    for (const m of adminMetaElements) {
      leakedSnippets.push(dom.locate(m).snippet);
    }
  }

  const jsonLdAdmin = html.match(/"author"\s*:\s*\{[^}]*"name"\s*:\s*"admin"/i);
  if (jsonLdAdmin) {
    leakedSnippets.push(collapseWhitespace(jsonLdAdmin[0]).slice(0, 140));
  }

  if (/Just another WordPress site|موقع ووردبريس آخر|Lorem ipsum dolor sit amet/i.test(html)) {
    const match = html.match(/Just another WordPress site|موقع ووردبريس آخر|Lorem ipsum dolor sit amet/i);
    if (match) leakedSnippets.push(match[0]);
  }

  if (leakedSnippets.length > 0) {
    rawFindings.push({
      id: 'f_rc004_leaked_defaults',
      ruleId: 'RC004',
      category: 'content',
      title: 'Leaked CMS / Template Default Metadata (e.g., author "admin")',
      titleAr: 'بيانات افتراضية منسية في الكود (اسم الكاتب طالع "admin")',
      kind: 'recommendation',
      severity: 'low',
      confidence: 'confirmed',
      affectsVerdict: false,
      method: 'static_html',
      source: 'rule',
      url,
      where:
        rc004Where || {
          pageUrl: url,
          sectionAr: 'الهيدر',
          visibleText: 'admin',
          selector: 'head > meta[name="twitter:data1"]',
          snippet: leakedSnippets[0]
        },
      occurrences: leakedSnippets.length,
      observed: `Found leaked default metadata/copy: ${leakedSnippets[0]}`,
      expected: 'Replace default "admin" author and template placeholders with the official brand name',
      steps: ['افحص وسوم الميتا (twitter:data1 / author) في كود الصفحة'],
      evidence: leakedSnippets.slice(0, 3).map(s => ({
        type: 'snippet',
        value: s,
        ref: s
      })),
      recommendedFix: getPlatformAwareFix('RC004', profile, { isHttps })
    });
  }

  // ---------------------------------------------------------------------------
  // 10. Form Inputs Accessibility (R011) — PHASE J1 A3
  // Count distinct controls per template; accessible name = label[for] (including sr-only),
  // wrapping label, aria-label, aria-labelledby, title (weak); placeholder alone is weak;
  // ignore hidden/submit/button/reset/image.
  // ---------------------------------------------------------------------------
  const allLabels = dom.root.querySelectorAll('label');
  const labelForMap = new Map<string, string>();
  for (const lbl of allLabels) {
    const forId = (lbl.getAttribute('for') || '').trim();
    const lblText = collapseWhitespace(lbl.text || lbl.getAttribute('aria-label'));
    if (forId && lblText) {
      labelForMap.set(forId, lblText);
    }
  }

  const formControls = dom.root
    .querySelectorAll('input, textarea, select')
    .filter(ctrl => !isInsideNoscriptOrTemplate(ctrl) && !isElementAriaHidden(ctrl));

  const seenTemplateControlKeys = new Set<string>();
  const unlabeledControls: {
    el: HTMLElement;
    where: FindingWhere;
    hasWeakName: boolean;
    weakNameText: string;
  }[] = [];

  for (const ctrl of formControls) {
    const tag = (ctrl.rawTagName || ctrl.tagName || 'input').toLowerCase();
    const type = (ctrl.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase().trim();
    if (
      type === 'hidden' ||
      type === 'submit' ||
      type === 'button' ||
      type === 'reset' ||
      type === 'image'
    ) {
      continue;
    }

    const id = (ctrl.getAttribute('id') || '').trim();
    const name = (ctrl.getAttribute('name') || '').trim();
    const placeholder = collapseWhitespace(ctrl.getAttribute('placeholder'));
    const titleAttr = collapseWhitespace(ctrl.getAttribute('title'));
    const ariaLabel = collapseWhitespace(ctrl.getAttribute('aria-label'));
    const ariaLabelledBy = (ctrl.getAttribute('aria-labelledby') || '').trim();

    // Check strong accessible name
    let hasStrongLabel = Boolean(ariaLabel);
    if (!hasStrongLabel && id && labelForMap.has(id)) {
      hasStrongLabel = true;
    }
    if (!hasStrongLabel && ariaLabelledBy) {
      const refIds = ariaLabelledBy.split(/\s+/).filter(Boolean);
      for (const refId of refIds) {
        const refEl = dom.root.querySelector(`[id="${refId.replace(/"/g, '')}"]`);
        if (refEl && collapseWhitespace(refEl.text)) {
          hasStrongLabel = true;
          break;
        }
      }
    }
    if (!hasStrongLabel) {
      let p = ctrl.parentNode as HTMLElement | null;
      while (p) {
        const pTag = (p.rawTagName || p.tagName || '').toLowerCase();
        if (pTag === 'label' && collapseWhitespace(p.text)) {
          hasStrongLabel = true;
          break;
        }
        p = p.parentNode as HTMLElement | null;
      }
    }

    if (hasStrongLabel) {
      continue;
    }

    // Deduplicate distinct controls per template
    const templateKey = `${tag}::${type}::${name || id || placeholder || titleAttr}`;
    if (seenTemplateControlKeys.has(templateKey)) {
      continue;
    }
    seenTemplateControlKeys.add(templateKey);

    const hasWeakName = Boolean(placeholder || titleAttr);
    const where = dom.locate(ctrl);
    unlabeledControls.push({
      el: ctrl,
      where,
      hasWeakName,
      weakNameText: placeholder || titleAttr
    });
  }

  if (unlabeledControls.length > 0) {
    const firstCtrl = unlabeledControls[0];
    const allHaveWeakName = unlabeledControls.every(c => c.hasWeakName);
    const count = unlabeledControls.length;
    const nearbyContext = firstCtrl.where.visibleText
      ? ` (النص القريب/الظاهر: «${firstCtrl.where.visibleText}»)`
      : '';

    rawFindings.push({
      id: 'f_r011_inputs',
      ruleId: 'R011',
      category: 'accessibility',
      title: `Form Controls Missing Explicit <label> (${count})`,
      titleAr: allHaveWeakName
        ? `فيه ${count} خانة في الفورم معتمدة على النص المؤقت (placeholder) بس من غير عنوان <label> ثابت`
        : `فيه ${count} خانة في الفورم من غير عنوان توضيحي (Label)`,
      kind: allHaveWeakName ? 'suspected_issue' : 'confirmed_defect',
      severity: allHaveWeakName ? 'low' : 'medium',
      confidence: allHaveWeakName ? 'likely' : 'confirmed',
      affectsVerdict: !allHaveWeakName,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstCtrl.where,
      scope: isSharedTemplateSectionAr(firstCtrl.where.sectionAr) ? 'site-wide' : 'page',
      occurrences: count,
      observed: allHaveWeakName
        ? `لقيت ${count} خانة إدخال بتعتمد على placeholder أو title بس من غير وسم <label>${nearbyContext}.`
        : `لقيت ${count} خانة إدخال من غير <label> أو aria-label${nearbyContext}.`,
      expected: 'Every form input should have an explicit <label for="..."> or aria-label',
      steps: ['افحص خانات الفورم في الصفحة واتأكد إن لكل خانة عنوان واضح فوقها مش بيختفي لما تكتب'],
      evidence: [
        {
          type: 'snippet',
          value: `${firstCtrl.where.sectionAr}${nearbyContext} | ${firstCtrl.where.snippet}`,
          ref: firstCtrl.where.snippet
        }
      ],
      recommendedFix: 'اربط كل خانة إدخال بوسم <label> ثابت أو ضيف خاصية aria-label واضحة.'
    });
  }

  // ---------------------------------------------------------------------------
  // 11. Primary Conversion Visibility (RC008) & Market-Language Gap (RC009) — PHASE J1 A3
  // ---------------------------------------------------------------------------
  if (profile.primaryConversion?.type && profile.primaryConversion.type !== 'none') {
    if (profile.primaryConversion.inTopOfPage) {
      passes.push({
        id: 'pass_rc008_conversion',
        ruleId: 'RC008',
        category: 'content',
        titleAr: 'وسيلة التواصل أو الطلب واضحة في أول الصفحة',
        detailAr: `وسيلة التحويل الأساسية (${profile.primaryConversion.type}) ظاهرة للزائر فوق.`,
        evidence: profile.primaryConversion.evidence || profile.primaryConversion.type,
        method: 'static_html'
      });
    } else {
      rawFindings.push({
        id: 'f_rc008_conversion_buried',
        ruleId: 'RC008',
        category: 'content',
        title: 'Primary Conversion Action Not Visible in Top of Page',
        titleAr: 'وسيلة التواصل أو الطلب مش ظاهرة في أول شاشة (الهيدر/البانر)',
        kind: 'recommendation',
        severity: 'low',
        confidence: 'likely',
        affectsVerdict: false,
        method: 'static_html',
        needsHumanDecision: true,
        source: 'rule',
        url,
        where: dom.defaultWhere('وسيلة التواصل الأساسية'),
        occurrences: 1,
        observed: `Primary conversion (${profile.primaryConversion.type}) was only found lower in the page`,
        expected: 'Clear CTA (WhatsApp / Call / Request Quote) visible in the header or hero section',
        steps: ['افتح أول شاشة في الموقع وشوف هل فيه زرار تواصل مباشر واضح قبل السكرول'],
        evidence: [
          {
            type: 'snippet',
            value: `Conversion (${profile.primaryConversion.type}) not found in top 40% of document`,
            ref: `Conversion (${profile.primaryConversion.type}) not found in top 40% of document`
          }
        ],
        recommendedFix: 'حط زرار تواصل واضح (واتساب أو اطلب عرض سعر) في الهيدر وأول بانر في الصفحة.'
      });
    }
  }

  // B1.3c: RC009 (export/market claims) fires ONLY when the claim is in the site's own positioning
  // (title, meta description, hero h1, nav, about/footer tagline) and NOT inside portfolio/case-study/blog/product listing context.
  // Always low, recommendation, affectsVerdict=false.
  let urlPathnameForRc009 = '';
  try {
    urlPathnameForRc009 = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    urlPathnameForRc009 = url.toLowerCase();
  }
  const isNonPositioningPath =
    /(?:^|\/)(?:case-stud(?:y|ies)|portfolio|projects?|blog|news|articles?|posts?|products?|shop|store|item|اعمالنا|أعمالنا|سابقة-الاعمال|سابقة-الأعمال|مشاريعنا|مقالات|مدونة|المدونة|أخبار|اخبار|المنتجات)(?:\/|$|-)/i.test(
      urlPathnameForRc009
    );

  const exportPattern =
    /(?:تصدير|نصدر|التصدير|أسواق عالمية|جميع أنحاء العالم|دول العالم|عالمياً|عالميا|export|worldwide|international markets)/i;
  const nonPositioningHeadingRegex =
    /(?:دراسة حالة|سابقة أعمال|سابقة اعمال|أعمالنا|اعمالنا|مشاريعنا|عملائنا|عملاؤنا|المدونة|مقالات|أحدث الأخبار|منتجاتنا|case[\s-_]?stud|portfolio|our projects|client|blog|news|products)/i;

  const isInsideNonPositioningSection = (el: HTMLElement | null): boolean => {
    let curr: HTMLElement | null = el;
    while (curr) {
      const idCls = `${curr.getAttribute('id') || ''} ${curr.getAttribute('class') || ''}`;
      if (nonPositioningHeadingRegex.test(idCls)) return true;
      const sectionHeading = curr.querySelector('h1, h2, h3, h4');
      if (sectionHeading && nonPositioningHeadingRegex.test(collapseWhitespace(sectionHeading.text))) {
        return true;
      }
      curr = curr.parentNode as HTMLElement | null;
    }
    return false;
  };

  let positioningExportQuote = '';
  let positioningExportNode: HTMLElement | null = null;

  if (!isNonPositioningPath) {
    // Check positioning candidates in order: hero h1, title, meta description, nav, about/footer tagline
    const heroH1 = h1Elements[0] || null;
    const navElements = dom.root.querySelectorAll('nav, header');
    const aboutOrFooterElements = dom.root.querySelectorAll(
      'footer, #about, .about, [id*="about"], [class*="about"]'
    );

    if (
      heroH1 &&
      !isInsideNonPositioningSection(heroH1) &&
      !nonPositioningHeadingRegex.test(collapseWhitespace(heroH1.text)) &&
      exportPattern.test(collapseWhitespace(heroH1.text))
    ) {
      const heroParent = heroH1.parentNode as HTMLElement | null;
      const heroPara = heroParent
        ? heroParent
            .querySelectorAll('p')
            .find(
              p =>
                !isInsideNoscriptOrTemplate(p) &&
                !isInsideNonPositioningSection(p) &&
                exportPattern.test(collapseWhitespace(p.text))
            )
        : null;
      if (heroPara) {
        positioningExportNode = heroPara;
        positioningExportQuote = collapseWhitespace(heroPara.text).slice(0, 180);
      } else {
        positioningExportNode = heroH1;
        positioningExportQuote = collapseWhitespace(heroH1.text).slice(0, 180);
      }
    } else if (
      titleText &&
      !nonPositioningHeadingRegex.test(titleText) &&
      exportPattern.test(titleText)
    ) {
      positioningExportNode = titleEl || null;
      positioningExportQuote = titleText.slice(0, 180);
    } else if (
      metaDesc &&
      !nonPositioningHeadingRegex.test(metaDesc) &&
      exportPattern.test(metaDesc)
    ) {
      positioningExportNode = metaDescEl || null;
      positioningExportQuote = metaDesc.slice(0, 180);
    } else {
      for (const candidate of [...navElements, ...aboutOrFooterElements]) {
        if (isInsideNoscriptOrTemplate(candidate) || isInsideNonPositioningSection(candidate)) {
          continue;
        }
        const txt = collapseWhitespace(candidate.text);
        if (txt && !nonPositioningHeadingRegex.test(txt) && exportPattern.test(txt)) {
          positioningExportNode = candidate;
          const sentences = txt.split(/(?<=[.!؟।\n])\s+/);
          const matchingSentence = sentences.find(s => exportPattern.test(s)) || txt;
          positioningExportQuote = matchingSentence.slice(0, 180).trim();
          break;
        }
      }
    }
  }

  if (
    positioningExportQuote &&
    !translationSignal.detected &&
    (!profile.markets?.hasAlternateLanguage || langHashItems.length > 0)
  ) {
    rawFindings.push({
      id: 'f_rc009_market_lang',
      ruleId: 'RC009',
      category: 'content',
      title: 'Export / International Market Claims Without Working Foreign Language Version',
      titleAr: 'الموقع بيتكلم عن تصدير وأسواق خارجية بس مفيش نسخة إنجليزي شغالة',
      kind: 'recommendation',
      severity: 'low',
      confidence: 'likely',
      affectsVerdict: false,
      method: 'static_html',
      needsHumanDecision: true,
      source: 'rule',
      url,
      where: positioningExportNode ? dom.locate(positioningExportNode) : dom.defaultWhere(positioningExportQuote),
      occurrences: 1,
      observed: `الموقع بيذكر التصدير أو الأسواق الخارجية («${positioningExportQuote}») من غير وجود نسخة إنجليزية مفعلة في الكود.`,
      expected: 'Sites targeting export buyers should provide a working English/alternate language page with hreflang',
      steps: ['لاحظ كلام الموقع عن التصدير وجرب تفتح النسخة الإنجليزية'],
      evidence: [
        {
          type: 'quote',
          value: positioningExportQuote,
          ref: positioningExportQuote
        }
      ],
      recommendedFix: 'جهّز صفحة أو نسخة إنجليزية شغالة لعملاء التصدير واربطها بزرار EN ووسم hreflang.'
    });
  }

  // ---------------------------------------------------------------------------
  // 12. Broken / Empty Media Embeds & B2B Hype/Emoji Tone (RC006) — PHASE J1 A6
  // ---------------------------------------------------------------------------
  const emptyMediaElements: { el: HTMLElement; where: FindingWhere }[] = [];
  for (const iframe of dom.root.querySelectorAll('iframe')) {
    if (isInsideNoscriptOrTemplate(iframe)) continue;
    const srcVal = (iframe.getAttribute('src') || iframe.getAttribute('data-src') || '').trim();
    if (!srcVal || srcVal === '#' || srcVal.toLowerCase() === 'about:blank') {
      emptyMediaElements.push({ el: iframe, where: dom.locate(iframe) });
    }
  }
  for (const v of allVideos) {
    const directSrc = (v.getAttribute('src') || v.getAttribute('data-src') || '').trim();
    const sourceEl = v.querySelector('source');
    const nestedSrc = (sourceEl?.getAttribute('src') || sourceEl?.getAttribute('data-src') || '').trim();
    const hasValidSrc =
      (directSrc && directSrc !== '#') || (nestedSrc && nestedSrc !== '#');
    if (!hasValidSrc) {
      emptyMediaElements.push({ el: v, where: dom.locate(v) });
    }
  }

  if (emptyMediaElements.length > 0) {
    const firstEmpty = emptyMediaElements[0];
    rawFindings.push({
      id: 'f_rc006_empty_media',
      ruleId: 'RC006',
      category: 'content',
      title: 'Broken or Empty Media Embeds (iframe / video without valid src)',
      titleAr: `فيه ${emptyMediaElements.length} عنصر فيديو أو إطار (iframe) فاضي من غير رابط تشغيل`,
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstEmpty.where,
      occurrences: emptyMediaElements.length,
      observed: `Found ${emptyMediaElements.length} media embed(s) with missing or blank src attribute`,
      expected: 'Embedded <video> and <iframe> elements must have a valid media source URL',
      steps: ['افحص عناصر الفيديو أو الخرائط المدمجة في الصفحة'],
      evidence: emptyMediaElements.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.where.snippet,
        ref: item.where.snippet
      })),
      recommendedFix: 'حط رابط الفيديو أو الخريطة الصحيح في خاصية src أو امسح العنصر الفاضي من الصفحة.'
    });
  }

  // A6: RC006 hype/emoji tone on a B2B site (method: llm_judgment, severity: low, verbatim quote, needsHumanDecision)
  if (profile.siteType === 'b2b_manufacturer' || profile.siteType === 'b2b_services') {
    const hypeRegex =
      /(?:🔥|🚀|💥|💯|🤑){2,}|أقوى عرض في التاريخ|رقم\s*1\s*في العالم|الأفضل في العالم بلا منازع|ضمان\s*100%\s*خصم خيالي|خصم خيالي لفترة محدودة/i;
    const textCandidate = dom.root
      .querySelectorAll('p, h1, h2, h3, li')
      .find(el => !isInsideNoscriptOrTemplate(el) && hypeRegex.test(el.text || ''));

    if (textCandidate) {
      const verbatimQuote = collapseWhitespace(textCandidate.text).slice(0, 180);
      rawFindings.push({
        id: 'f_rc006_b2b_tone',
        ruleId: 'RC006',
        category: 'content',
        title: 'Informal Hype / Emoji Tone on B2B Industrial Site',
        titleAr: 'نبرة مبالغة تسويقية أو إيموجي كتير في موقع صناعي / شركات (B2B)',
        kind: 'recommendation',
        severity: 'low',
        confidence: 'likely',
        affectsVerdict: false,
        method: 'llm_judgment',
        needsHumanDecision: true,
        source: 'rule',
        url,
        where: dom.locate(textCandidate),
        occurrences: 1,
        observed: `لقيت جملة بنبرة دعائية مبالغ فيها لموقع شركات B2B: «${verbatimQuote}»`,
        expected: 'Calm, specification-driven B2B tone backed by certifications, capacity, and clear contact details',
        steps: ['راجع الجملة المقتبسة وقرر هل النبرة دي مناسبة لعملاء الشركات والتصدير'],
        evidence: [
          {
            type: 'quote',
            value: verbatimQuote,
            ref: verbatimQuote
          }
        ],
        recommendedFix: 'لو عملاءك شركات ومستوردين (B2B)، استبدل عبارات المبالغة والإيموجي بأرقام الطاقة الإنتاجية وشهادات الجودة.'
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 13. Contact Details Consistency & Trust Signals (RC007) — PHASE J1 A6
  // ---------------------------------------------------------------------------
  const contactInconsistencies: { msg: string; where: FindingWhere }[] = [];
  for (const a of allAnchors) {
    const href = (a.getAttribute('href') || '').trim();
    if (href.toLowerCase().startsWith('tel:')) {
      const rawHrefPhone = href.slice(4).replace(/\D+/g, '');
      const innerText = collapseWhitespace(a.text);
      const visibleDigits = innerText.replace(/\D+/g, '');
      if (rawHrefPhone.length >= 7 && visibleDigits.length >= 7) {
        const hrefTail = rawHrefPhone.slice(-7);
        const visTail = visibleDigits.slice(-7);
        if (hrefTail !== visTail) {
          contactInconsistencies.push({
            msg: `tel:${href.slice(4).trim()} differs from visible number "${innerText}"`,
            where: dom.locate(a)
          });
        }
      }
    } else if (/^https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)/i.test(href)) {
      const m = href.match(/https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?([0-9+]+)/i);
      const num = (m?.[1] || '').replace(/\D+/g, '');
      if (num.startsWith('01') && num.length === 11) {
        contactInconsistencies.push({
          msg: `WhatsApp link (${href}) uses local format "${num}" without country code (20${num.slice(1)})`,
          where: dom.locate(a)
        });
      }
    }
  }

  if (contactInconsistencies.length > 0) {
    const firstContact = contactInconsistencies[0];
    rawFindings.push({
      id: 'f_rc007_contact_mismatch',
      ruleId: 'RC007',
      category: 'links',
      title: 'Contact Phone / WhatsApp Link Inconsistency',
      titleAr: 'اختلاف بين رقم التليفون المكتوب والرقم المربوط في الزرار أو كود الدولة في واتساب',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: firstContact.where,
      scope: isSharedTemplateSectionAr(firstContact.where.sectionAr) ? 'site-wide' : 'page',
      occurrences: contactInconsistencies.length,
      observed: firstContact.msg,
      expected: 'Phone tel: links must match the displayed phone number and wa.me links must include country code',
      steps: ['اضغط على رقم التليفون أو زرار واتساب وقارنه بالرقم المكتوب قدامك'],
      evidence: contactInconsistencies.slice(0, 3).map(item => ({
        type: 'snippet',
        value: item.msg,
        ref: item.msg
      })),
      recommendedFix: 'وحّد رقم التليفون جوة الرابط (tel:) مع الرقم المكتوب، وتأكد إن رابط واتساب بيبدأ بكود الدولة (مثل 2010...).'
    });
  }

  // A6: RC007 trust signals (privacy/terms/address/commercial registration; recommendation, low, affectsVerdict=false)
  if (
    profile.siteType === 'b2b_manufacturer' ||
    profile.siteType === 'b2b_services' ||
    profile.siteType === 'ecommerce'
  ) {
    const hasLegalLink = allAnchors.some(a => {
      const h = (a.getAttribute('href') || '').toLowerCase();
      const t = collapseWhitespace(a.text).toLowerCase();
      return /privacy|terms|refund|policy|الخصوصية|سياسة|الشروط والأحكام|الاستبدال/.test(`${h} ${t}`);
    });
    const hasAddressOrReg =
      /سجل تجاري|بطاقة ضريبية|المنطقة الصناعية|العنوان|المقر|شارع|مدينة العاشر|برج العرب|السادس من أكتوبر|القاهرة|الجيزة|الإسكندرية|commercial register|tax id/i.test(
        visibleText
      );

    if (!hasLegalLink && !hasAddressOrReg) {
      const footerEl = dom.root.querySelector('footer');
      rawFindings.push({
        id: 'f_rc007_trust_signals',
        ruleId: 'RC007',
        category: 'content',
        title: 'Missing Commercial Trust Signals (Address / Commercial Registration / Privacy Policy)',
        titleAr: 'بيانات الثقة التجارية (العنوان الفعلي أو السجل التجاري أو سياسة الخصوصية) مش واضحة في الصفحة',
        kind: 'recommendation',
        severity: 'low',
        confidence: 'likely',
        affectsVerdict: false,
        method: 'static_html',
        source: 'rule',
        url,
        where: footerEl ? dom.locate(footerEl) : dom.defaultWhere('الفوتر وبيانات الثقة'),
        scope: footerEl ? 'site-wide' : 'page',
        occurrences: 1,
        observed: 'No physical address, commercial registration, or privacy/terms policy link detected on the page',
        expected: 'Clear physical address, commercial registration info, or privacy/terms links in footer',
        steps: ['انزل لآخر الصفحة (الفوتر) وشوف هل العنوان الفعلي أو السجل التجاري أو رابط سياسة الخصوصية مكتوبين بوضوح'],
        evidence: [
          {
            type: 'snippet',
            value: footerEl ? dom.locate(footerEl).snippet : `<title>${titleText.slice(0, 80)}</title>`,
            ref: 'footer'
          }
        ],
        recommendedFix: 'ضيف عنوان المصنع/الشركة الفعلي وروابط سياسة الخصوصية والشروط في الفوتر عشان تزود ثقة العملاء.'
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 14. JSON-LD Structured Data Pass Check & SPA Shell Handling
  // ---------------------------------------------------------------------------
  const jsonLdScripts = dom.root.querySelectorAll('script[type="application/ld+json"]');
  if (jsonLdScripts.length > 0) {
    const firstJson = (jsonLdScripts[0].text || '').trim();
    const typeMatch = firstJson.match(/"@type"\s*:\s*"([^"]+)"/);
    const schemaType = typeMatch ? typeMatch[1] : 'Schema.org';
    passes.push({
      id: 'pass_jsonld_schema',
      ruleId: 'R_SCHEMA',
      category: 'seo',
      titleAr: `بيانات منظمة لمحركات البحث (JSON-LD: ${schemaType}) موجودة`,
      detailAr: 'بتساعد جوجل يفهم نوع النشاط ومحتوى الموقع بدقة.',
      evidence: `@type: ${schemaType}`,
      method: 'static_html'
    });
  }

  // Check template default titles on SPAs / starter templates
  if (/^(?:Vite \+ React|React App|Vite App|Create Next App|Document)$/i.test(titleText)) {
    rawFindings.push({
      id: 'f_rc004_template_title',
      ruleId: 'RC004',
      category: 'seo',
      title: 'Default Framework Starter Title Left Unchanged',
      titleAr: `عنوان الموقع لسه على الاسم الافتراضي للقالب ("${titleText}")`,
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'static_html',
      source: 'rule',
      url,
      where: titleEl ? dom.locate(titleEl) : dom.defaultWhere(titleText),
      occurrences: 1,
      observed: `Document <title> is still set to starter template default "${titleText}"`,
      expected: 'Unique brand and value-proposition <title>',
      steps: ['بص على اسم التاب فوق في المتصفح'],
      evidence: [{ type: 'snippet', value: `<title>${titleText}</title>`, ref: `<title>${titleText}</title>` }],
      recommendedFix: 'غيّر وسم <title> في ملف index.html لاسم موقعك الفعلي ووصف نشاطك.'
    });
  }

  // If SPA with empty unrendered root and no headless browser rendering capability, mark DOM-dependent checks as NOT_MEASURED
  if ((profile.platform === 'spa' || profile.platform === 'ai_builder') && visibleText.length < 100 && !caps.browserRendering) {
    notMeasured.push({
      id: 'nm_spa_dom',
      checkId: 'SPA_RENDER',
      category: 'content',
      titleAr: 'محتوى الصفحة الداخلي والروابط والعناوين بعد تشغيل JavaScript (SPA)',
      reasonAr:
        'الموقع بيحمّل محتواه بالـ JavaScript جوة المتصفح، وأنا قريت كود الصفحة من غير ما أفتحها في متصفح.',
      whyNotMeasuredAr:
        'قريت كود الصفحة من غير ما أفتحها في متصفح، والموقع ده بيرسم المحتوى بالـ JavaScript بعد الفتح.',
      howItWillWorkAr:
        'لما نفتح الصفحة في متصفح حقيقي بيشغّل JavaScript هنفحص العناوين والصور والروابط المرسومة.',
      whenAr: 'قريبًا (مع تفعيل المتصفح الفعلي).',
      missingCapability: 'browserRendering',
      chipAr: 'قريبًا'
    });
  }

  // Ensure every raw finding has a non-empty where.sectionAr and deterministic whyItMattersAr (P2b.9)
  for (const rf of rawFindings) {
    if (!rf.where || !rf.where.sectionAr) {
      rf.where = dom.defaultWhere(rf.titleAr || rf.title);
    }
    if (!rf.whyItMattersAr) {
      rf.whyItMattersAr = getDeterministicWhyItMattersAr(rf);
    }
  }

  // Normalize and cap findings per category
  const { findings, allNormalized, overflowCountsByCategory } = normalizeAndCapFindings(rawFindings);

  return {
    profile,
    findings,
    allNormalizedFindings: allNormalized,
    overflowCountsByCategory,
    passes,
    notMeasured
  };
}

/**
 * PHASE P2b.9: Deterministic per-fixIntent / per-rule "ليه ده يهمك؟" templates (no LLM, no hype).
 */
export const WHY_IT_MATTERS_TEMPLATES_AR: Record<string, string> = {
  R001: 'الزائر هيوصل لصفحة مش موجودة وممكن يسيب الموقع.',
  RX001: 'العميل اللي يضغط ممكن ما يلاقيش محادثة تفتح.',
  RX002: 'الزائر هيشوف صورة مكسورة ومساحة فاضية بتقلل الثقة في الموقع.',
  R013_PERF: 'الزائر ممكن يستنى قبل ما يشوف المحتوى الأساسي؛ والقياس معملي.',
  R013: 'تحميل الصفحة أو الوسائط ممكن يبطّأ التصفح على شبكات الموبايل.',
  R002: 'غياب التشفير بيخلّي المتصفح يعرض تحذير "غير آمن" للزوار.',
  R003: 'الزائر بيضغط على الرابط ومفيش صفحة بتفتح قدامه.',
  R003_LANG: 'العميل الأجنبي لما يضغط تغيير اللغة ممكن الصفحة تفضل عربي وما يفهمش المحتوى.',
  R003_SOCIAL: 'الزائر اللي عايز يشوف صفحاتك الرسمية على السوشيال ميديا هيلاقي الزرار مش شغال.',
  R005: 'العرض الثابت ممكن يخلّي الصفحة تخرج بره شاشة الموبايل وتحتاج سحب بالعرض.',
  R006: 'الخط الصغير بيخلّي القراءة صعبة على شاشة الموبايل من غير تقريب.',
  R007: 'من غير إعداد Viewport الموبايل هيعرض الموقع مصغّر كأنه شاشة كمبيوتر.',
  R008: 'عنوان الصفحة هو أول سطر العميل بيشوفه في نتائج بحث جوجل وفي تاب المتصفح.',
  R009: 'الوصف التعريفي بيساعد الباحث في جوجل يفهم موقعك بيقدم إيه قبل ما يدخل.',
  R010: 'هيدرز الحماية الأساسية بتقلل احتمالات التلاعب بعرض الصفحة في المتصفح.',
  R011: 'الزائر ومساعدات القراءة ممكن يتلخبطوا في المطلوب جوه خانات الفورم لما يكتبوا.',
  R012: 'غياب وصف الصور بيصعّب على قارئات الشاشة ومحركات البحث فهم محتوى الصورة.',
  RC001: 'اختلاف كتابة اسم البراند في نفس الصفحة ممكن يشتت البحث ويضعف الهوية.',
  RC002: 'اختلاف دومين الإيميل عن دومين الموقع ممكن يخلي العميل يتردد أو تكون غلطة كتابة.',
  RC004: 'بقاء بيانات افتراضية من القالب بيدي انطباع إن الموقع لسه تحت الإنشاء.',
  RC005: 'تكرار نفس الوصف لكل الصور بيضيّع فرصة ظهور كل منتج لوحده في بحث الصور.',
  RC006: 'عنصر وسائط فاضي أو نبرة غير مناسبة لطبيعة نشاطك ممكن يقللوا جدية العرض.',
  RC007: 'تضارب أرقام التواصل أو غياب بيانات الشركة الرسمية بيقلل ثقة العميل قبل الطلب.',
  RC008: 'لو وسيلة التواصل مستخبية تحت، الزائر المستعجل ممكن يخرج قبل ما يطلب.',
  RC009: 'المستورد أو العميل الأجنبي هيحتاج نسخة إنجليزي واضحة عشان يتواصل معاك.',
  RC010: 'العنوان الرئيسي بيساعد الزائر ومحركات البحث يفهموا موضوع الصفحة من أول نظرة.',
  RC010_RECONCILE: 'محركات البحث والزواحف اللي مش بتشغل جافاسكريبت ممكن ما تشوفش العنوان الرئيسي في أول بايت.',
  R_FAVICON: 'أيقونة المتصفح بتخلي شكل الموقع احترافي وسهل التمييز وسط التابات المفتوحة.',
  R_ROBOTS: 'ملف robots.txt بيساعد محركات البحث تعرف إيه الصفحات المسموح أرشفتها في موقعك.',
  R_SITEMAP: 'خريطة الموقع بتسهل على جوجل اكتشاف كل صفحاتك المهمة وأرشفتها أسرع.'
};

export function getDeterministicWhyItMattersAr(finding: Partial<Finding>): string {
  if (finding.whyItMattersAr && finding.whyItMattersAr.trim().length > 0) {
    return finding.whyItMattersAr.trim();
  }
  const ruleId = (finding.ruleId || '').trim();
  if (ruleId && WHY_IT_MATTERS_TEMPLATES_AR[ruleId]) {
    return WHY_IT_MATTERS_TEMPLATES_AR[ruleId];
  }
  if (finding.method === 'psi') {
    return 'ده قياس معملي بعد عرض الصفحة لتوضيح تأثير العنصر على تجربة الموبايل.';
  }
  return 'الملاحظة دي بتأثر على وضوح الموقع أو سهولة استخدامه للزائر.';
}

export function getNotMeasuredThreeLines(item: NotMeasuredItem): {
  whyNotMeasuredAr: string;
  howItWillWorkAr: string;
  whenAr: string;
} {
  const cleanReason = (item.whyNotMeasuredAr || item.reasonAr || '')
    .replace(/\(?\s*Static\s+HTML\s*\)?/gi, 'قريت كود الصفحة من غير ما أفتحها في متصفح')
    .trim();

  if (item.whyNotMeasuredAr && item.howItWillWorkAr && item.whenAr) {
    return {
      whyNotMeasuredAr: cleanReason,
      howItWillWorkAr: item.howItWillWorkAr,
      whenAr: item.whenAr
    };
  }

  if (item.missingCapability === 'psi' || item.id.startsWith('nm_psi') || item.id === 'nm_lcp_cls') {
    return {
      whyNotMeasuredAr:
        cleanReason || 'قريت كود الصفحة من غير ما أفتحها في متصفح، وقياس السرعة المعملي مكانش متاح في اللفة دي.',
      howItWillWorkAr:
        'بيتم القياس عن طريق فتح الصفحة في معمل PageSpeed من جوجل على شبكة موبايل وحساب LCP وCLS وTBT.',
      whenAr:
        item.id === 'nm_psi_timeout' || item.id === 'nm_psi_429' || item.id === 'nm_psi_5xx'
          ? 'تقدر تعيد الفحص دلوقتي أو كمان شوية لما ضغط الشبكة يهدى.'
          : 'متاح لما خدمة PageSpeed Insights تكمل الرد في المهلة المحددة.'
    };
  }

  if (item.missingCapability === 'browserRendering' || item.id === 'nm_spa_dom' || item.id === 'nm_lang_click_test') {
    return {
      whyNotMeasuredAr:
        cleanReason || 'قريت كود الصفحة من غير ما أفتحها في متصفح، فالحاجات اللي بتترسم أو تتغير بالـ JavaScript ما اتقاستش.',
      howItWillWorkAr:
        'هنفتح الصفحة في متصفح حقيقي على مقاس الموبايل ونجرب الضغط على الأزرار والقوائم ونقيس أبعاد العناصر.',
      whenAr: 'قريبًا (مع إضافة فحص المتصفح التفاعلي).'
    };
  }

  if (item.id === 'nm_robots_skipped') {
    return {
      whyNotMeasuredAr: cleanReason,
      howItWillWorkAr: 'بفحص بس المسارات اللي ملف robots.txt في موقعك بيسمح بيها.',
      whenAr: 'أول ما تسمح بالمسارات دي في ملف robots.txt وتعمل إعادة فحص.'
    };
  }

  return {
    whyNotMeasuredAr:
      cleanReason || 'قريت كود الصفحة من غير ما أفتحها في متصفح كامل.',
    howItWillWorkAr:
      'لما تتوفر بيانات الصفحة كاملة أو صلاحية الوصول ليها هيتعمل الفحص بالدليل.',
    whenAr: 'في إعادة الفحص الجاية أو قريبًا حسب نوع الفحص.'
  };
}

function doesFindingAffectVerdict(f: Finding): boolean {
  if (f.confidence !== 'confirmed') return false;
  if (f.affectsVerdict !== undefined) return Boolean(f.affectsVerdict);
  return f.kind === 'confirmed_defect' && !f.needsHumanDecision;
}

/**
 * Deterministic Verdict Calculation (Section 5, PHASE J1 A4, & PHASE J2.8: never decided by LLM)
 * - Uses ONLY findings with confidence === 'confirmed' and affectsVerdict === true.
 * - Excludes question-only items (such as RC002) from main finding counts.
 * - Lists top 1-3 confirmed drivers that decided the verdict, each linking to its finding card.
 */
export function computeVerdict(
  paramsOrFindings:
    | {
        findings: Finding[];
        passes: PassItem[];
        notMeasured: NotMeasuredItem[];
        profile?: SiteProfile;
        skippedByRobotsCount?: number;
        pagesAnalyzed?: number;
      }
    | any[],
  legacyNotMeasured?: NotMeasuredItem[],
  legacyIsSpaShellOnly?: boolean
): VerdictInfo {
  const isLegacyArrayCall = Array.isArray(paramsOrFindings);
  const findings: Finding[] = isLegacyArrayCall
    ? (paramsOrFindings as any[]).map((f: any, idx: number) => ({
        id: f.id || `f_${idx}`,
        ruleId: f.ruleId || 'R000',
        category: f.category || 'performance',
        title: f.title || f.titleAr || '',
        titleAr: f.titleAr || f.title || '',
        kind: f.kind || 'confirmed_defect',
        severity: f.severity || 'medium',
        confidence: f.confidence || 'confirmed',
        affectsVerdict: f.affectsVerdict,
        method: f.method || 'static_html',
        needsHumanDecision: Boolean(f.needsHumanDecision),
        source: 'rule',
        url: f.url || '',
        occurrences: f.occurrences || 1,
        observed: f.observed || f.descriptionAr || '',
        steps: f.steps || [],
        evidence: Array.isArray(f.evidence)
          ? f.evidence.map((e: any) =>
              typeof e === 'string' ? { type: 'snippet', value: e } : e
            )
          : [],
        recommendedFix: f.recommendedFix || f.howToFixAr || ''
      }))
    : paramsOrFindings.findings || [];
  const passes: PassItem[] = isLegacyArrayCall ? [] : paramsOrFindings.passes || [];
  const notMeasured: NotMeasuredItem[] = isLegacyArrayCall
    ? legacyNotMeasured || []
    : paramsOrFindings.notMeasured || [];
  const profile: SiteProfile | undefined = isLegacyArrayCall
    ? legacyIsSpaShellOnly
      ? ({ platform: 'spa', type: 'standard', confidence: 1, signals: [] } as SiteProfile)
      : undefined
    : paramsOrFindings.profile;
  const skippedByRobotsCount: number = isLegacyArrayCall
    ? 0
    : paramsOrFindings.skippedByRobotsCount ?? 0;

  // Exclude question-only RC002 from main findings counts (shown only in "محتاج قرار منك")
  const mainFindings = findings.filter(f => f.ruleId !== 'RC002');

  const critical = mainFindings.filter(f => f.severity === 'critical').length;
  const high = mainFindings.filter(f => f.severity === 'high').length;
  const medium = mainFindings.filter(f => f.severity === 'medium').length;
  const low = mainFindings.filter(f => f.severity === 'low' || f.severity === 'improvement').length;

  const verdictFindings = mainFindings.filter(doesFindingAffectVerdict);

  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    improvement: 4
  };
  // K1.5: One primary reason per measurement, overall performance score is informational and never a driver, no duplicated (قياس معملي)
  const eligibleDriverFindings = verdictFindings
    .filter(f => f.ruleId !== 'R013_SCORE' && !(f.titleAr || f.title).includes('مؤشر أداء'))
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  const seenRules = new Set<string>();
  const uniqueDriverFindings: Finding[] = [];
  for (const f of eligibleDriverFindings) {
    if (!seenRules.has(f.ruleId)) {
      seenRules.add(f.ruleId);
      uniqueDriverFindings.push(f);
    }
  }

  const drivers = uniqueDriverFindings.slice(0, 3).map((f, idx) => {
    const prefix = idx === 0 ? 'السبب الأساسي' : `السبب ${idx + 1}`;
    const titleText = f.titleAr || f.title;
    return {
      findingId: f.id,
      ruleId: f.ruleId,
      severity: f.severity,
      summaryAr: `${prefix}: ${titleText}`
    };
  });

  const confirmedHighOrCriticalCount = verdictFindings.filter(
    f => f.severity === 'critical' || f.severity === 'high'
  ).length;
  const confirmedMediumCount = verdictFindings.filter(
    f => f.severity === 'medium'
  ).length;

  const hasConfirmedHighOrCritical = confirmedHighOrCriticalCount > 0;
  const hasConfirmedMedium = confirmedMediumCount > 0;

  const totalNotesText = formatArabicNoteCount(mainFindings.length);

  let level: VerdictInfo['level'] = 'ready_with_notes';
  let labelAr = 'مفيش مشاكل مؤكدة كبيرة في العينة';
  let line1 = `راجعت الموقع بالدليل: لقيت ${passes.length} فحص عدّى، ومفيش مشاكل مؤكدة كبيرة في العينة المفحوصة.`;
  let line2 = 'تقدر تستلم الموقع أو تطلقه، وراجع الملاحظات الخفيفة تحت للتحسين المستمر.';

  if (hasConfirmedHighOrCritical) {
    level = 'fix_before_handover';
    labelAr = 'فيه مشاكل لازم تتحل قبل الاستلام';
    line1 = `لقيت ${formatArabicNoteCount(confirmedHighOrCriticalCount)} أساسية مؤكدة بالدليل (إجمالي ${totalNotesText}) مقابل ${passes.length} نقطة سليمة.`;
    line2 =
      drivers.length > 0
        ? `${drivers[0].summaryAr} — ابدأ بحل أولويات "ابدأ من هنا" قبل الاستلام.`
        : 'ابدأ بحل أولويات "ابدأ من هنا" الأول قبل ما تستلم الموقع أو تطلقه للعملاء.';
  } else if (hasConfirmedMedium) {
    level = 'needs_work_before_launch';
    labelAr = 'محتاج شغل قبل الإطلاق';
    line1 = `الأساسيات شغالة (${passes.length} نقطة تمام)، لكن فيه ${formatArabicNoteCount(confirmedMediumCount)} متوسطة مؤكدة محتاجة تظبيط قبل الإطلاق الرسمي.`;
    line2 =
      drivers.length > 0
        ? `${drivers[0].summaryAr} — راجع قائمة الأولويات وانسخ خطة الإصلاح الجاهزة تحت.`
        : 'راجع قائمة الأولويات وانسخ خطة الإصلاح الجاهزة تحت عشان تظبطها بسرعة.';
  }

  const partialReasonsAr: string[] = [];
  if ((profile?.platform === 'spa' || profile?.platform === 'ai_builder') && notMeasured.some(nm => nm.id === 'nm_spa_dom')) {
    partialReasonsAr.push('الموقع SPA بيعتمد على JavaScript لعرض المحتوى، فالفحص شمل الهيدرز والكود المبدئي بس.');
  }
  if (skippedByRobotsCount > 0) {
    partialReasonsAr.push(`تم تخطي ${skippedByRobotsCount} صفحة احتراماً لقواعد ملف robots.txt.`);
  }
  if (notMeasured.some(nm => nm.id === 'nm_lcp_cls')) {
    partialReasonsAr.push('سرعة العرض المرئي الفعلي (LCP/CLS) ما اتقاسّتش لعدم وجود متصفح قياس حي.');
  }

  return {
    level,
    labelAr,
    headlineAr: labelAr,
    summaryLinesAr: [line1, line2],
    drivers,
    isPartial: partialReasonsAr.length > 0,
    partialReasonsAr,
    counts: {
      critical,
      high,
      medium,
      low,
      passed: passes.length,
      notMeasured: notMeasured.length
    }
  };
}

/**
 * Section 5 item 4 & G5.7: "قالك إيه الـ AI؟" — Claims vs. Reality deterministic evaluator.
 */
export function evaluateAiClaims(params: {
  aiClaimsText?: string;
  findings: Finding[];
  passes: PassItem[];
  notMeasured: NotMeasuredItem[];
}): ClaimComparisonItem[] {
  const raw = (params.aiClaimsText || '').trim();
  if (!raw) return [];

  const { findings, passes, notMeasured } = params;
  const comparisons: ClaimComparisonItem[] = [];

  const clauses = raw
    .split(
      /[\r\n،,;؛.|•]+|(?=\s+و(?:مؤمن|مؤمّن|متجاوب|سريع|جاهز|آمن|أمن|السيو|سيو|كل\s+الصفحات|شغال|المبيعات))/i
    )
    .map(c => c.replace(/^[-*«»"'\s]+|[«»"'\s]+$/g, '').trim())
    .filter(c => c.length > 0);

  if (clauses.length === 0) return [];

  for (const clause of clauses) {
    const verbatimClaim = `«${clause.slice(0, 140)}»`;
    const lower = clause.toLowerCase();

    // 1. Responsive / Mobile claim
    if (/متجاوب|موبايل|شاشات|responsive|mobile/i.test(lower)) {
      const respFindings = findings.filter(
        f => f.category === 'responsive' || f.ruleId === 'R005' || f.ruleId === 'R007'
      );
      if (respFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `غير دقيق: لقيت ${formatArabicNoteCount(respFindings.length)} تخص الموبايل (${respFindings[0].titleAr || respFindings[0].title}).`,
          status: 'contradicted',
          evidenceRef: respFindings[0].evidence?.[0]?.value
        });
      } else {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr:
            'وسم Viewport موجود ومفيش عروض ثابتة صريحة في الـ HTML، لكن الرسم الفعلي على المتصفح ما اتقاسش كامل.',
          status: 'not_measured'
        });
      }
      continue;
    }

    // 2. SEO claim
    if (/سيو|محركات البحث|seo|جوجل|أرشفة|ارشفة|ميتا|meta/i.test(lower)) {
      const seoFindings = findings.filter(
        f =>
          f.category === 'seo' ||
          f.ruleId === 'RC005' ||
          f.ruleId === 'RC004' ||
          f.ruleId === 'R008' ||
          f.ruleId === 'R009'
      );
      if (seoFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `فيه نواقص سيو واضحة بالدليل (${formatArabicNoteCount(seoFindings.length)}): ${seoFindings
            .map(f => f.titleAr || f.title)
            .slice(0, 2)
            .join(' + ')}.`,
          status: 'contradicted',
          evidenceRef: seoFindings[0].evidence?.[0]?.value
        });
      } else {
        const seoPass = passes.find(p => p.category === 'seo');
        if (seoPass) {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'صحيح في الصفحات اللي اتفحصت: العناوين والوصف التعريفي موجودين بالدليل.',
            status: 'verified_true',
            evidenceRef: seoPass.evidence
          });
        } else {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'الحتة دي ما اتقاسّتش بالكامل هنا، ومش هخمّن.',
            status: 'not_measured'
          });
        }
      }
      continue;
    }

    // 3. Security claim
    if (/آمن|أمن|حماية|أمان|امان|تشفير|secure|security|ssl|https/i.test(lower)) {
      const secFindings = findings.filter(f => f.category === 'security' || f.ruleId === 'R010');
      if (secFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `فيه نواقص حماية بالدليل (${secFindings[0].titleAr || secFindings[0].title}).`,
          status: 'contradicted',
          evidenceRef: secFindings[0].evidence?.[0]?.value
        });
      } else {
        const secPass = passes.find(p => p.category === 'security');
        if (secPass) {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'صحيح: الاتصال مشفر وهيدرز الحماية الأساسية اللي اتفحصت موجودة.',
            status: 'verified_true',
            evidenceRef: secPass.evidence
          });
        } else {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'إعدادات الحماية دي ما اتقاسّتش بالكامل في الفحص الحالي، ومش هخمّن.',
            status: 'not_measured'
          });
        }
      }
      continue;
    }

    // 4. Accessibility claim
    if (/وصول|إتاحة|اتاحة|accessibility|a11y|wcag|alt|فورم|تباين/i.test(lower)) {
      const a11yFindings = findings.filter(f => f.category === 'accessibility');
      if (a11yFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `فيه ملاحظات سهولة وصول بالدليل (${a11yFindings[0].titleAr || a11yFindings[0].title}).`,
          status: 'contradicted',
          evidenceRef: a11yFindings[0].evidence?.[0]?.value
        });
      } else {
        const a11yPass = passes.find(p => p.category === 'accessibility');
        if (a11yPass) {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'العناصر الأساسية اللي اتفحصت في الكود سليمة.',
            status: 'verified_true',
            evidenceRef: a11yPass.evidence
          });
        } else {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'الحتة دي ما اتقاسّتش هنا، ومش هخمّن.',
            status: 'not_measured'
          });
        }
      }
      continue;
    }

    // 5. Speed / Performance claim
    if (/سريع|سرعة|أداء|اداء|تحميل|تحمّيل|fast|performance|speed|lcp|cls|core web vitals|pagespeed|lighthouse/i.test(lower)) {
      const perfFindings = findings.filter(f => f.category === 'performance' || f.ruleId === 'R013');
      if (perfFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `فيه عناصر بتبطّأ التحميل بالدليل: ${perfFindings[0].titleAr || perfFindings[0].title}.`,
          status: 'contradicted',
          evidenceRef: perfFindings[0].evidence?.[0]?.value
        });
      } else if (notMeasured.some(nm => nm.id === 'nm_lcp_cls' || nm.category === 'performance')) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr:
            'استجابة السيرفر المبدئية كويسة، لكن سرعة العرض المرئي على الموبايل (LCP/CLS) ما اتقاسّتش هنا ومش بنخمّنها.',
          status: 'not_measured'
        });
      } else {
        const perfPass = passes.find(p => p.category === 'performance');
        if (perfPass) {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'صحيح في حدود قياس استجابة السيرفر وحجم الملفات.',
            status: 'verified_true',
            evidenceRef: perfPass.evidence
          });
        } else {
          comparisons.push({
            claimAr: verbatimClaim,
            realityAr: 'الحتة دي ما اتقاسّتش هنا، ومش هخمّن.',
            status: 'not_measured'
          });
        }
      }
      continue;
    }

    // 6. Links / Ready / Complete claim
    if (/جاهز|خلص|كامل|روابط|لينكات|شغال|done|ready|complete|links/i.test(lower)) {
      const linkOrContentFindings = findings.filter(
        f =>
          f.category === 'links' ||
          f.ruleId.startsWith('R003') ||
          f.ruleId === 'RC004' ||
          f.ruleId === 'RC009'
      );
      const confirmedFindings = findings.filter(f => f.confidence === 'confirmed');
      if (linkOrContentFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `لقيت ${formatArabicNoteCount(linkOrContentFindings.length)} في الروابط أو المحتوى (${linkOrContentFindings
            .map(f => f.titleAr || f.title)
            .slice(0, 2)
            .join('، ')}).`,
          status: 'contradicted',
          evidenceRef: linkOrContentFindings[0].evidence?.[0]?.value
        });
      } else if (confirmedFindings.length > 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: `فيه ${formatArabicNoteCount(confirmedFindings.length)} مؤكدة بالدليل محتاجة تتظبط الأول (${confirmedFindings[0].titleAr || confirmedFindings[0].title}).`,
          status: 'contradicted',
          evidenceRef: confirmedFindings[0].evidence?.[0]?.value
        });
      } else if (passes.length > 0 && findings.length === 0) {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: 'صحيح في حدود الفحص الثابت للصفحات المختارة.',
          status: 'verified_true',
          evidenceRef: passes[0].evidence
        });
      } else {
        comparisons.push({
          claimAr: verbatimClaim,
          realityAr: 'الحتة دي ما اتقاسّتش بالكامل هنا، ومش هخمّن.',
          status: 'not_measured'
        });
      }
      continue;
    }

    // 7. Unrecognized / unmeasured claim: never fabricate or guess
    comparisons.push({
      claimAr: verbatimClaim,
      realityAr: 'الحتة دي ما اتقاسّتش هنا، ومش هخمّن.',
      status: 'not_measured'
    });
  }

  return comparisons;
}
