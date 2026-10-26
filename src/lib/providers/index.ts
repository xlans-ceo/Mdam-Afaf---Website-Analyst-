import {
  Finding,
  LighthouseRun,
  NotMeasuredItem,
  PageInfo,
  PassItem,
  ScanRequest,
  ScanResult,
  ScanStreamEvent
} from '../../types/contract';
import { getRegistrableDomain } from '../domain-parser';
import { HIGH_PROFILE_NOTICE_AR, isHighProfileDomain } from '../../config/limits';
import { SCAN_LIMITS } from '../../config/limits.server';
import { detectCapabilities } from '../capabilities';
import { safeFetchHtmlWithSsrf } from '../ssrf-validator';
import {
  computeVerdict,
  evaluateAiClaims,
  PsiLcpElement,
  PsiMeasurement,
  PsiOpportunityItem,
  PsiRenderedAudits,
  PsiRenderedAuditItem,
  runHonestChecks,
  SampledImageSize
} from '../honest-checks';
import { isSharedTemplateSectionAr } from '../html-dom';
import { normalizeAndCapFindings } from '../normalize-finding';
import { computeFindingFingerprint, computeDeploymentFingerprint } from '../fingerprint';
import { detectSiteStatus } from '../site-status';
import { DiscoveredCandidate, discoverSitePages } from '../page-discovery';
import { buildSiteProfile } from '../site-profiler';
import { globalPsiCache } from '../psi-cache';

export { computeFindingFingerprint, computeDeploymentFingerprint };

export interface ScanContext {
  deadlineMs: number;
  signal: AbortSignal;
  canMakeRequest: () => boolean;
  remainingMs: () => number;
  isDeadlineExpired: () => boolean;
  isCancelled: () => boolean;
}

export interface RunScanOptions {
  scanTimeoutMs?: number;
  psiTimeoutMs?: number;
  rootRequestTimeoutMs?: number;
  rootRetryTimeoutMs?: number;
  maxPagesOverride?: number;
  allowLocalFixtures?: boolean;
  isRescan?: boolean;
  signal?: AbortSignal;
  psiFetch?: typeof fetch;
  psiApiKey?: string;
  psiFetcher?: (
    targetUrl: string,
    timeoutMs: number,
    signal: AbortSignal
  ) => Promise<PsiMeasurement | null>;
}

export interface ScannerProvider {
  runScan(
    scanId: string,
    request: ScanRequest,
    onEvent: (event: ScanStreamEvent) => void,
    options?: RunScanOptions
  ): Promise<ScanResult>;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop()) break;
      const idx = cursor++;
      if (idx >= items.length) break;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

export type PsiFailureCode =
  | 'key_absent'
  | 'timeout'
  | 'http_400'
  | 'http_403'
  | 'http_429'
  | 'http_5xx'
  | 'http_other'
  | 'malformed'
  | 'network_error';

export interface PsiFetchOutcome {
  data: PsiMeasurement | null;
  timedOut: boolean;
  failureCode?: PsiFailureCode;
  httpStatus?: number;
  notMeasured?: NotMeasuredItem;
}

export function mapPsiFailureToNotMeasured(
  code: PsiFailureCode,
  httpStatus?: number
): NotMeasuredItem {
  switch (code) {
    case 'key_absent':
      return {
        id: 'nm_lcp_cls',
        checkId: 'R013',
        category: 'performance',
        titleAr: 'قياس سرعة ظهور الشاشة الفعلي (LCP / CLS)',
        reasonAr:
          'مفيش مفتاح PSI_API_KEY أو متصفح حي في البيئة دي — ومش بنخمّن أرقام سرعة من غير قياس حقيقي.',
        missingCapability: 'psi'
      };
    case 'timeout':
      return {
        id: 'nm_psi_timeout',
        checkId: 'PSI_TIMEOUT',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr: 'قياس السرعة ما خلصش في الوقت',
        missingCapability: 'psi'
      };
    case 'http_400':
      return {
        id: 'nm_psi_400',
        checkId: 'PSI_HTTP_400',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr:
          'مفتاح خدمة PageSpeed غير صالح أو طلب القياس اترفض من جوجل (كود 400) — ومش بنخمّن أرقام.',
        missingCapability: 'psi'
      };
    case 'http_403':
      return {
        id: 'nm_psi_403',
        checkId: 'PSI_HTTP_403',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr:
          'خدمة PageSpeed Insights API غير مفعّلة في مشروع جوجل أو الصلاحية مرفوضة (كود 403) — ومش بنخمّن أرقام.',
        missingCapability: 'psi'
      };
    case 'http_429':
      return {
        id: 'nm_psi_429',
        checkId: 'PSI_HTTP_429',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr:
          'خلصت حصة طلبات PageSpeed Insights المسموحة حالياً من جوجل (كود 429) — جرب كمان شوية.',
        missingCapability: 'psi'
      };
    case 'http_5xx':
      return {
        id: 'nm_psi_5xx',
        checkId: 'PSI_HTTP_5XX',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr: `سيرفر PageSpeed Insights رجّع خطأ مؤقت من عنده (كود ${httpStatus || 500}) — ومش بنخمّن أرقام.`,
        missingCapability: 'psi'
      };
    case 'malformed':
      return {
        id: 'nm_psi_malformed',
        checkId: 'PSI_MALFORMED',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr:
          'رد خدمة PageSpeed Insights رجع ناقص أو بصيغة غير صالحة — ومش بنخمّن أرقام سرعة.',
        missingCapability: 'psi'
      };
    case 'http_other':
    case 'network_error':
    default:
      return {
        id: 'nm_psi_error',
        checkId: 'PSI_ERROR',
        category: 'performance',
        titleAr: 'قياس السرعة الفعلي (PageSpeed Insights)',
        reasonAr: 'تعذر إكمال الاتصال بخدمة PageSpeed Insights — ومش بنخمّن أرقام سرعة.',
        missingCapability: 'psi'
      };
  }
}

function extractPsiFieldData(rawResponse: any): PsiMeasurement['fieldData'] | undefined {
  const urlExp = rawResponse?.loadingExperience;
  const originExp = rawResponse?.originLoadingExperience;
  const chosen =
    urlExp && urlExp.metrics && Object.keys(urlExp.metrics).length > 0
      ? { exp: urlExp, source: 'url' as const }
      : originExp && originExp.metrics && Object.keys(originExp.metrics).length > 0
      ? { exp: originExp, source: 'origin' as const }
      : null;

  if (!chosen) return undefined;
  const m = chosen.exp.metrics;
  const lcpRaw = m?.LARGEST_CONTENTFUL_PAINT_MS;
  const clsRaw = m?.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  const inpRaw = m?.INTERACTION_TO_NEXT_PAINT;
  const fcpRaw = m?.FIRST_CONTENTFUL_PAINT_MS;

  const hasAnyNumeric =
    typeof lcpRaw?.percentile === 'number' ||
    typeof clsRaw?.percentile === 'number' ||
    typeof inpRaw?.percentile === 'number' ||
    typeof fcpRaw?.percentile === 'number';
  if (!hasAnyNumeric) return undefined;

  const normalizeClsPercentile = (val: number | undefined): number | undefined => {
    if (typeof val !== 'number') return undefined;
    // CrUX API stores CLS percentile as integer * 100 (e.g. 5 -> 0.05)
    return val >= 1 ? Number((val / 100).toFixed(2)) : Number(val.toFixed(3));
  };

  return {
    source: chosen.source,
    overallCategory:
      typeof chosen.exp.overall_category === 'string' ? chosen.exp.overall_category : undefined,
    lcpMs:
      typeof lcpRaw?.percentile === 'number'
        ? { percentile: Math.round(lcpRaw.percentile), category: lcpRaw.category }
        : undefined,
    cls:
      typeof clsRaw?.percentile === 'number'
        ? { percentile: normalizeClsPercentile(clsRaw.percentile), category: clsRaw.category }
        : undefined,
    inpMs:
      typeof inpRaw?.percentile === 'number'
        ? { percentile: Math.round(inpRaw.percentile), category: inpRaw.category }
        : undefined,
    fcpMs:
      typeof fcpRaw?.percentile === 'number'
        ? { percentile: Math.round(fcpRaw.percentile), category: fcpRaw.category }
        : undefined
  };
}

function extractPsiLcpElement(audits: Record<string, any>): PsiLcpElement | undefined {
  const candidateAuditIds = [
    'lcp-breakdown-insight',
    'lcp-discovery-insight',
    'largest-contentful-paint-element'
  ];

  const findNodeRecursive = (obj: any): { selector?: string; snippet?: string } | null => {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'node' && (obj.selector || obj.snippet)) {
      return {
        selector: typeof obj.selector === 'string' ? obj.selector : undefined,
        snippet: typeof obj.snippet === 'string' ? obj.snippet : undefined
      };
    }
    if (obj.node && obj.node.type === 'node' && (obj.node.selector || obj.node.snippet)) {
      return {
        selector: typeof obj.node.selector === 'string' ? obj.node.selector : undefined,
        snippet: typeof obj.node.snippet === 'string' ? obj.node.snippet : undefined
      };
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findNodeRecursive(item);
        if (found) return found;
      }
      return null;
    }
    for (const val of Object.values(obj)) {
      const found = findNodeRecursive(val);
      if (found) return found;
    }
    return null;
  };

  for (const id of candidateAuditIds) {
    const audit = audits[id];
    if (!audit?.details) continue;
    const node = findNodeRecursive(audit.details);
    if (node) {
      const rawSnippet = (node.snippet || '').trim();
      const rawSelector = (node.selector || '').trim();
      const combined = `${rawSnippet} ${rawSelector}`.toLowerCase();
      let type = 'section';
      if (/<img\b|\bimg\b|image|picture|svg/i.test(combined)) {
        type = 'image';
      } else if (/<(?:h[1-6]|p|span)\b/i.test(combined)) {
        type = 'text';
      } else if (/<video\b/i.test(combined)) {
        type = 'video';
      }
      return {
        selector: rawSelector || undefined,
        snippet: rawSnippet ? rawSnippet.slice(0, 200) : undefined,
        type
      };
    }
  }
  return undefined;
}

function extractPsiTopOpportunities(audits: Record<string, any>): PsiOpportunityItem[] {
  const excludedIds = new Set([
    'largest-contentful-paint',
    'first-contentful-paint',
    'total-blocking-time',
    'cumulative-layout-shift',
    'speed-index',
    'interactive',
    'max-potential-fid',
    'lcp-breakdown-insight',
    'lcp-discovery-insight',
    'largest-contentful-paint-element',
    'metrics',
    'diagnostics',
    'network-requests',
    'main-thread-tasks',
    'final-screenshot',
    'screenshot-thumbnails'
  ]);

  const candidates: PsiOpportunityItem[] = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (excludedIds.has(id) || !audit || typeof audit !== 'object') continue;
    if (typeof audit.score === 'number' && audit.score >= 0.9) continue;

    const metricSavings = audit.metricSavings || {};
    const msFromMetric = Math.max(
      Number(metricSavings.LCP) || 0,
      Number(metricSavings.FCP) || 0,
      Number(metricSavings.TBT) || 0
    );
    const msFromDetails = Number(audit.details?.overallSavingsMs) || 0;
    const bytesFromDetails = Number(audit.details?.overallSavingsBytes) || 0;

    const savingsMs = Math.max(msFromMetric, msFromDetails);
    const savingsBytes = bytesFromDetails > 0 ? bytesFromDetails : undefined;

    if (savingsMs > 0 || (savingsBytes && savingsBytes > 0)) {
      candidates.push({
        id,
        title: String(audit.title || id),
        savingsMs: savingsMs > 0 ? Math.round(savingsMs) : undefined,
        savingsBytes: savingsBytes ? Math.round(savingsBytes) : undefined,
        displayValue: typeof audit.displayValue === 'string' ? audit.displayValue : undefined
      });
    }
  }

  candidates.sort((a, b) => {
    const msDiff = (b.savingsMs || 0) - (a.savingsMs || 0);
    if (msDiff !== 0) return msDiff;
    return (b.savingsBytes || 0) - (a.savingsBytes || 0);
  });

  return candidates.slice(0, 3);
}

function extractPsiRenderedAudits(audits: Record<string, any>): PsiRenderedAudits {
  const mapItem = (audit: any, id: string): PsiRenderedAuditItem | undefined => {
    if (!audit || typeof audit !== 'object') return undefined;
    const isPassed =
      audit.score === 1 ||
      (audit.score === null && audit.scoreDisplayMode === 'notApplicable');
    return {
      id,
      passed: Boolean(isPassed),
      score: typeof audit.score === 'number' ? audit.score : null,
      title: typeof audit.title === 'string' ? audit.title : undefined,
      description: typeof audit.description === 'string' ? audit.description : undefined,
      displayValue: typeof audit.displayValue === 'string' ? audit.displayValue : undefined,
      details: audit.details
    };
  };

  let hasRenderedH1 = false;
  let renderedH1Text: string | undefined;

  const headingAudit = audits['heading-order'];
  if (headingAudit?.details?.items && Array.isArray(headingAudit.details.items)) {
    for (const item of headingAudit.details.items) {
      const nodeSnippet = (item.node?.snippet || item.snippet || '').toLowerCase();
      const nodeSelector = (item.node?.selector || item.selector || '').toLowerCase();
      const nodeLabel = (item.node?.nodeLabel || item.nodeLabel || '').toLowerCase();
      if (nodeSnippet.includes('<h1') || nodeSelector.startsWith('h1') || nodeLabel.startsWith('h1')) {
        hasRenderedH1 = true;
        renderedH1Text = item.node?.nodeLabel || item.node?.snippet || item.snippet;
        break;
      }
    }
  }

  const lcpAudit = audits['largest-contentful-paint-element'];
  if (!hasRenderedH1 && lcpAudit?.details) {
    const lcpSnippet = (JSON.stringify(lcpAudit.details) || '').toLowerCase();
    if (lcpSnippet.includes('<h1') || lcpSnippet.includes('"h1.') || lcpSnippet.includes('"h1"')) {
      hasRenderedH1 = true;
    }
  }

  return {
    documentTitle: mapItem(audits['document-title'], 'document-title'),
    headingOrder: mapItem(audits['heading-order'], 'heading-order'),
    hasRenderedH1,
    renderedH1Text,
    imageAlt: mapItem(audits['image-alt'], 'image-alt'),
    linkName: mapItem(audits['link-name'], 'link-name'),
    formLabel: mapItem(audits['label'] || audits['form-field-multiple-labels'], 'form-label'),
    colorContrast: mapItem(audits['color-contrast'], 'color-contrast'),
    tapTargets: mapItem(audits['tap-targets'] || audits['target-size'], 'tap-targets'),
    viewport: mapItem(audits['viewport'], 'viewport'),
    fontSize: mapItem(audits['font-size'], 'font-size'),
    crawlableAnchors: mapItem(audits['crawlable-anchors'], 'crawlable-anchors')
  };
}

export async function fetchPsiMetricsIfAvailable(
  targetUrl: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  overrides?: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    skipCache?: boolean;
    deploymentFingerprint?: string;
  }
): Promise<PsiFetchOutcome> {
  const shouldCheckCache = !overrides?.skipCache && !overrides?.fetchImpl;
  if (shouldCheckCache) {
    const cached = globalPsiCache.getWithMeta(
      targetUrl,
      'mobile',
      overrides?.deploymentFingerprint
    );
    if (cached) {
      return {
        data: {
          ...cached.data,
          fromCache: true,
          cacheAgeMinutes: cached.ageMinutes,
          cacheLabelAr: cached.labelAr
        },
        timedOut: false
      };
    }
  }

  const rawKey =
    overrides?.apiKey !== undefined ? overrides.apiKey : process.env.PSI_API_KEY || '';
  const psiKey = rawKey.trim();
  if (!psiKey || psiKey === 'YOUR_PSI_API_KEY') {
    return {
      data: null,
      timedOut: false,
      failureCode: 'key_absent',
      notMeasured: mapPsiFailureToNotMeasured('key_absent')
    };
  }

  const fetchFn = overrides?.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1, timeoutMs));

  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      return {
        data: null,
        timedOut: true,
        failureCode: 'timeout',
        notMeasured: mapPsiFailureToNotMeasured('timeout')
      };
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
      targetUrl
    )}&strategy=mobile&category=PERFORMANCE&category=ACCESSIBILITY&category=BEST_PRACTICES&category=SEO&key=${encodeURIComponent(
      psiKey
    )}`;
    const res = await fetchFn(endpoint, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const status = res.status;
      let code: PsiFailureCode = 'http_other';
      if (status === 400) code = 'http_400';
      else if (status === 403 || status === 401) code = 'http_403';
      else if (status === 429) code = 'http_429';
      else if (status >= 500) code = 'http_5xx';
      return {
        data: null,
        timedOut: false,
        failureCode: code,
        httpStatus: status,
        notMeasured: mapPsiFailureToNotMeasured(code, status)
      };
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      return {
        data: null,
        timedOut: false,
        failureCode: 'malformed',
        notMeasured: mapPsiFailureToNotMeasured('malformed')
      };
    }

    const audits = data?.lighthouseResult?.audits;
    const categories = data?.lighthouseResult?.categories;
    if (!audits || typeof audits !== 'object') {
      return {
        data: null,
        timedOut: false,
        failureCode: 'malformed',
        notMeasured: mapPsiFailureToNotMeasured('malformed')
      };
    }

    const lcpMs = audits['largest-contentful-paint']?.numericValue;
    const fcpMs = audits['first-contentful-paint']?.numericValue;
    const cls = audits['cumulative-layout-shift']?.numericValue;
    const tbtMs = audits['total-blocking-time']?.numericValue;
    const speedIndexMs = audits['speed-index']?.numericValue;
    const performanceScore =
      typeof categories?.performance?.score === 'number'
        ? Math.round(categories.performance.score * 100)
        : undefined;
    const seoScore =
      typeof categories?.seo?.score === 'number'
        ? Math.round(categories.seo.score * 100)
        : undefined;

    if (
      typeof lcpMs !== 'number' &&
      typeof cls !== 'number' &&
      typeof tbtMs !== 'number' &&
      typeof performanceScore !== 'number'
    ) {
      return {
        data: null,
        timedOut: false,
        failureCode: 'malformed',
        notMeasured: mapPsiFailureToNotMeasured('malformed')
      };
    }

    const fieldData = extractPsiFieldData(data);
    const lcpElement = extractPsiLcpElement(audits);
    const topOpportunities = extractPsiTopOpportunities(audits);
    const renderedAudits = extractPsiRenderedAudits(audits);

    const psiResult: PsiMeasurement = {
      lcpMs: typeof lcpMs === 'number' ? lcpMs : undefined,
      fcpMs: typeof fcpMs === 'number' ? fcpMs : undefined,
      cls: typeof cls === 'number' ? cls : undefined,
      tbtMs: typeof tbtMs === 'number' ? tbtMs : undefined,
      speedIndexMs: typeof speedIndexMs === 'number' ? speedIndexMs : undefined,
      performanceScore,
      seoScore,
      fieldData,
      lcpElement,
      topOpportunities,
      renderedAudits,
      fromCache: false,
      cacheAgeMinutes: 0,
      cacheLabelAr: 'قياس جديد'
    };

    if (!overrides?.fetchImpl) {
      globalPsiCache.set(
        targetUrl,
        psiResult,
        'mobile',
        overrides?.deploymentFingerprint
      );
    }

    return {
      timedOut: false,
      data: psiResult
    };
  } catch {
    clearTimeout(timer);
    const isTimeout = timedOut || Boolean(externalSignal?.aborted);
    const code: PsiFailureCode = isTimeout ? 'timeout' : 'network_error';
    return {
      data: null,
      timedOut: isTimeout,
      failureCode: code,
      notMeasured: mapPsiFailureToNotMeasured(code)
    };
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * G3.1 & J1.A2: Deduplicates findings across multiple inspected pages by fingerprint
 * (`ruleId::title::location`).
 * - A2 Template Dedupe: an element in the shared header/footer/nav across pages counts ONCE
 *   with `scope: 'site-wide'` and a `pages` list; `occurrences` = distinct elements on one page
 *   template, NEVER the sum across pages.
 */
export function mergeMultiPageFindings(allPageFindings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();

  for (const f of allPageFindings) {
    const key = computeFindingFingerprint(f);
    const existing = byFingerprint.get(key);
    if (!existing) {
      const initialPages =
        f.pages && f.pages.length > 0
          ? [...f.pages]
          : f.affectedUrls && f.affectedUrls.length > 0
          ? [...f.affectedUrls]
          : [f.url];
      byFingerprint.set(key, {
        ...f,
        affectedUrls: initialPages,
        pages: initialPages
      });
    } else {
      const mergedUrls = new Set<string>([
        ...(existing.pages || existing.affectedUrls || [existing.url]),
        ...(f.pages || f.affectedUrls || [f.url])
      ]);
      const mergedEvidence = [...existing.evidence];
      for (const ev of f.evidence) {
        if (
          mergedEvidence.length < 5 &&
          !mergedEvidence.some(e => e.value === ev.value)
        ) {
          mergedEvidence.push(ev);
        }
      }
      const isSharedTemplate =
        existing.scope === 'site-wide' ||
        f.scope === 'site-wide' ||
        isSharedTemplateSectionAr(existing.where?.sectionAr) ||
        isSharedTemplateSectionAr(f.where?.sectionAr);

      const pagesList = Array.from(mergedUrls);
      const nextOccurrences = isSharedTemplate
        ? existing.occurrences
        : existing.occurrences + f.occurrences;
      const prevCountStr = String(existing.occurrences);
      const nextCountStr = String(nextOccurrences);
      const syncCountInText = (txt?: string) => {
        if (!txt || isSharedTemplate || existing.occurrences === nextOccurrences) return txt;
        return txt.replace(new RegExp(`\\b${prevCountStr}\\b`, 'g'), nextCountStr);
      };

      byFingerprint.set(key, {
        ...existing,
        title: syncCountInText(existing.title) || existing.title,
        titleAr: syncCountInText(existing.titleAr),
        observed: syncCountInText(existing.observed) || existing.observed,
        occurrences: nextOccurrences,
        scope: isSharedTemplate && pagesList.length > 1 ? 'site-wide' : existing.scope,
        affectedUrls: pagesList,
        pages: pagesList,
        evidence: mergedEvidence
      });
    }
  }

  return Array.from(byFingerprint.values());
}

/**
 * G3.4: Classifies subpage HTTP error status codes by discovery source and status class:
 * - 401 / 403 / 429 -> NOT_MEASURED (protected or rate-limited subpage, never a broken link)
 * - 5xx -> R001 with severity 'medium', confidence 'likely', kind 'suspected_issue'
 * - 404 / 410 from 'sitemap' or 'wp_api' -> R001 with severity 'medium', confidence 'confirmed', kind 'confirmed_defect'
 * - 404 / 410 (or other 4xx) from 'nav' or 'body_link' -> R001 with severity 'high', confidence 'confirmed', kind 'confirmed_defect'
 */
export function classifySubpageHttpStatus(params: {
  candidate: DiscoveredCandidate;
  status: number;
  rootUrl: string;
  index: number;
}): { finding?: Finding; notMeasured?: NotMeasuredItem } {
  const { candidate, status, rootUrl, index } = params;
  if (status < 400) return {};

  if (status === 401 || status === 403 || status === 429) {
    return {
      notMeasured: {
        id: `nm_subpage_protected_${index + 1}`,
        checkId: 'SUBPAGE_PROTECTED',
        category: 'links',
        titleAr: `صفحة داخلية محمية أو رفضت الفحص الآلي (${status}): ${candidate.url}`,
        reasonAr: `السيرفر رجّع كود HTTP ${status} على الصفحة دي، وده معناه إنها محمية بصلاحيات أو جدار حماية ومش رابط مكسور.`
      }
    };
  }

  if (status >= 500) {
    return {
      finding: {
        id: `f_r001_sub_${index + 1}`,
        ruleId: 'R001',
        category: 'links',
        title: `Server Error (${status}) on Internal Page`,
        titleAr: `صفحة داخلية رجّعت خطأ سيرفر (${status})`,
        kind: 'suspected_issue',
        severity: 'medium',
        confidence: 'likely',
        method: 'http',
        affectsVerdict: false,
        source: 'rule',
        url: candidate.url,
        location: candidate.url,
        where: {
          pageUrl: candidate.url,
          sectionAr: 'الاستجابة من السيرفر (HTTP)',
          visibleText: String(status),
          selector: 'http:status',
          snippet: `GET ${candidate.url} -> ${status}`
        },
        affectedUrls: [candidate.url],
        pages: [candidate.url],
        occurrences: 1,
        observed: `HTTP GET ${candidate.url} returned server error ${status}`,
        expected: 'HTTP 200 OK',
        steps: [`افتح الرابط ${candidate.url}`],
        evidence: [
          {
            type: 'header',
            value: `GET ${candidate.url} -> ${status}`,
            ref: `GET ${candidate.url} -> ${status}`
          }
        ],
        recommendedFix: 'راجع سجل أخطاء السيرفر (Error Logs) للصفحة دي واتأكد إنها بتفتح من غير خطأ 500.'
      }
    };
  }

  if (candidate.source === 'sitemap' || candidate.source === 'wp_api') {
    return {
      finding: {
        id: `f_r001_sub_${index + 1}`,
        ruleId: 'R001',
        category: 'links',
        title: `Stale URL in Sitemap / API Returning ${status}`,
        titleAr: `رابط قديم في خريطة الموقع أو الـ API بيرجع خطأ (${status})`,
        kind: 'confirmed_defect',
        severity: 'medium',
        confidence: 'confirmed',
        method: 'http',
        affectsVerdict: true,
        source: 'rule',
        url: candidate.url,
        location: candidate.url,
        where: {
          pageUrl: candidate.url,
          sectionAr: 'خريطة الموقع (Sitemap / API)',
          visibleText: String(status),
          selector: 'sitemap > loc',
          snippet: `GET ${candidate.url} (source: ${candidate.source}) -> ${status}`.slice(0, 200)
        },
        affectedUrls: [candidate.url],
        pages: [candidate.url],
        occurrences: 1,
        observed: `URL discovered via ${candidate.source} (${candidate.url}) returned HTTP ${status}`,
        expected: 'All URLs listed in sitemap.xml and public APIs should return HTTP 200 OK',
        steps: [`افتح الرابط المذكور في خريطة الموقع: ${candidate.url}`],
        evidence: [
          {
            type: 'header',
            value: `GET ${candidate.url} (source: ${candidate.source}) -> ${status}`,
            ref: `GET ${candidate.url} -> ${status}`
          }
        ],
        recommendedFix: 'احذف الرابط القديم من خريطة الموقع (sitemap.xml) أو اعمله تحويل (Redirect 301) للصفحة البديلة.'
      }
    };
  }

  return {
    finding: {
      id: `f_r001_sub_${index + 1}`,
      ruleId: 'R001',
      category: 'links',
      title: 'Broken Internal Navigation Link',
      titleAr: `رابط داخلي بيرجع خطأ (${status})`,
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'http',
      affectsVerdict: true,
      source: 'rule',
      url: candidate.url,
      location: candidate.url,
      where: {
        pageUrl: candidate.url,
        sectionAr: 'القايمة',
        visibleText: candidate.label || String(status),
        selector: 'nav a[href]',
        snippet: `GET ${candidate.url} -> ${status}`.slice(0, 200)
      },
      affectedUrls: [candidate.url],
      pages: [candidate.url],
      occurrences: 1,
      observed: `HTTP GET ${candidate.url} returned status ${status}`,
      expected: 'HTTP 200 OK',
      steps: [`افتح الصفحة الرئيسية ${rootUrl}`, `اضغط على الرابط ${candidate.url}`],
      evidence: [
        {
          type: 'header',
          value: `GET ${candidate.url} -> ${status}`,
          ref: `GET ${candidate.url} -> ${status}`
        }
      ],
      recommendedFix: 'صلّح مسار الرابط في القائمة أو اعمله تحويل (Redirect 301) لصفحة شغالة.'
    }
  };
}

function maskSecret(raw: string): string {
  const clean = raw.trim();
  if (clean.length <= 8) return '****';
  return `${clean.slice(0, 4)}...${clean.slice(-2)}`;
}

/**
 * Passive secret-pattern check on up to 3 public JS files for SPA sites (Section 6.2 & G3.2).
 * Secrets are masked (first 4 + last 2 characters), never stored or logged in full.
 */
export async function scanPublicSpaJsForSecrets(
  html: string,
  baseUrl: string,
  ctx: ScanContext,
  allowLocalFixtures: boolean
): Promise<Finding[]> {
  const scriptSrcs = Array.from(
    html.matchAll(/<script[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/gi)
  )
    .map(m => m[1].trim())
    .filter(src => !/googletagmanager|google-analytics|facebook|hotjar|clarity|cdnjs|jsdelivr|unpkg/i.test(src));

  const findings: Finding[] = [];
  const checkedJs: string[] = [];

  for (const rawSrc of scriptSrcs) {
    if (checkedJs.length >= SCAN_LIMITS.MAX_PASSIVE_JS_FILES) break;
    if (ctx.isCancelled() || ctx.isDeadlineExpired()) break;
    let fullJsUrl = '';
    try {
      fullJsUrl = new URL(rawSrc, baseUrl).toString();
    } catch {
      continue;
    }
    if (checkedJs.includes(fullJsUrl)) continue;
    if (!ctx.canMakeRequest()) break;
    checkedJs.push(fullJsUrl);

    try {
      const res = await safeFetchHtmlWithSsrf(fullJsUrl, {
        timeoutMs: Math.min(4000, Math.max(1, ctx.remainingMs())),
        maxRedirects: 2,
        maxBytes: 1024 * 1024,
        allowLocalFixtures,
        signal: ctx.signal
      });
      if (!res.ok || !res.html) continue;

      const patterns: { name: string; regex: RegExp }[] = [
        { name: 'Stripe Secret Key', regex: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
        { name: 'OpenAI API Key', regex: /\bsk-(?:proj-)?[0-9a-zA-Z]{24,}\b/ },
        { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
        { name: 'Slack Token', regex: /\bxox[baprs]-[0-9a-zA-Z-]{16,}\b/ }
      ];

      for (const pat of patterns) {
        const match = res.html.match(pat.regex);
        if (match && match[0]) {
          const masked = maskSecret(match[0]);
          findings.push({
            id: `f_r010_js_secret_${findings.length + 1}`,
            ruleId: 'R010',
            category: 'security',
            title: `Exposed Secret Pattern (${pat.name}) in Public JS Bundle`,
            titleAr: `نمط يشبه مفتاح سري (${pat.name}) جوة ملف JavaScript عام`,
            kind: 'confirmed_defect',
            severity: 'high',
            confidence: 'confirmed',
            method: 'http',
            affectsVerdict: true,
            needsHumanDecision: true,
            source: 'rule',
            url: fullJsUrl,
            location: fullJsUrl,
            where: {
              pageUrl: fullJsUrl,
              sectionAr: 'ملف جافاسكريبت عام (JS Bundle)',
              visibleText: masked,
              selector: 'script[src]',
              snippet: `${pat.name}: ${masked} in ${fullJsUrl}`.slice(0, 200)
            },
            occurrences: 1,
            observed: `Detected ${pat.name} pattern (${masked}) in public bundle ${fullJsUrl}`,
            expected: 'Secret keys must only live in server-side environment variables, never in client JS bundles',
            steps: ['افتح ملف الـ JS العام المذكور في الدليل واتأكد هل ده مفتاح سري فعلي ولا قيمة تجريبية'],
            evidence: [
              {
                type: 'snippet',
                value: `${pat.name}: ${masked} in ${fullJsUrl}`,
                ref: `${pat.name}: ${masked}`
              }
            ],
            recommendedFix: 'لو ده مفتاح حقيقي: الغيه فوراً (Rotate Key) وانقله للباك إند جوة متغيرات البيئة (Server Environment Variables).'
          });
        }
      }
    } catch {
      // ignore bundle fetch error
    }
  }

  return findings;
}

export class LiveProvider implements ScannerProvider {
  protected allowMockFallbackWhenUnreachable = false;
  protected defaultOptions?: RunScanOptions;

  constructor(defaultOptions?: RunScanOptions) {
    this.defaultOptions = defaultOptions;
  }

  async runScan(
    scanId: string,
    request: ScanRequest,
    onEvent: (event: ScanStreamEvent) => void,
    callOptions?: RunScanOptions
  ): Promise<ScanResult> {
    const options = { ...this.defaultOptions, ...callOptions };
    const startedAt = new Date().toISOString();
    const scanBudgetMs = options.scanTimeoutMs ?? SCAN_LIMITS.SCAN_TIMEOUT_S * 1000;
    const deadlineMs = Date.now() + scanBudgetMs;

    const scanAbortCtrl = new AbortController();
    let cancelledByCaller = false;
    let expiredByDeadline = false;

    const deadlineTimer = setTimeout(() => {
      expiredByDeadline = true;
      scanAbortCtrl.abort();
    }, Math.max(1, scanBudgetMs));

    const onCallerAbort = () => {
      cancelledByCaller = true;
      scanAbortCtrl.abort();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        cancelledByCaller = true;
        scanAbortCtrl.abort();
      } else {
        options.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    let requestsUsed = 0;
    const ctx: ScanContext = {
      deadlineMs,
      signal: scanAbortCtrl.signal,
      remainingMs: () => Math.max(0, deadlineMs - Date.now()),
      isDeadlineExpired: () => expiredByDeadline || Date.now() >= deadlineMs,
      isCancelled: () => cancelledByCaller || Boolean(options.signal?.aborted),
      canMakeRequest: () => {
        if (cancelledByCaller || options.signal?.aborted) return false;
        if (expiredByDeadline || Date.now() >= deadlineMs) return false;
        if (requestsUsed >= SCAN_LIMITS.MAX_REQUESTS_PER_SCAN) return false;
        requestsUsed++;
        return true;
      }
    };

    try {
      let domain = 'example.com';
      try {
        domain = getRegistrableDomain(request.url) || new URL(request.url).hostname;
      } catch {
        domain = request.url;
      }

      onEvent({
        type: 'stage',
        stage: 'url_check',
        state: 'started',
        detail: 'بنتأكد من أمان الرابط وصلاحية الوصول وقدرات الفحص...'
      });

      const capabilities = await detectCapabilities();
      const checkedViewports: ('desktop' | 'mobile')[] = capabilities.browserRendering
        ? ['desktop', 'mobile']
        : [];
      const allowLocalFixtures =
        Boolean(options.allowLocalFixtures) ||
        request.url.includes('127.0.0.1') ||
        request.url.includes('localhost');

      ctx.canMakeRequest();
      const initialRootTimeout = options?.rootRequestTimeoutMs ?? SCAN_LIMITS.REQUEST_TIMEOUT_S * 1000;
      let rootFetch = await safeFetchHtmlWithSsrf(request.url, {
        maxRedirects: SCAN_LIMITS.MAX_REDIRECTS,
        timeoutMs: Math.min(initialRootTimeout, Math.max(1, ctx.remainingMs())),
        maxBytes: SCAN_LIMITS.MAX_HTML_BYTES,
        allowLocalFixtures,
        signal: ctx.signal
      });

      // K1.8: Slow homepage: one retry with a 20s timeout for the root request only
      if (rootFetch.timedOut && !ctx.isCancelled() && ctx.remainingMs() > 500) {
        onEvent({
          type: 'stage',
          stage: 'url_check',
          state: 'started',
          detail: 'الموقع بطيء شوية، مدام عفاف بتجرب مرة تانية بمهلة أطول للرئيسية...'
        });
        const retryRootTimeout = options?.rootRetryTimeoutMs ?? 20000;
        rootFetch = await safeFetchHtmlWithSsrf(request.url, {
          maxRedirects: SCAN_LIMITS.MAX_REDIRECTS,
          timeoutMs: Math.min(retryRootTimeout, Math.max(1, ctx.remainingMs())),
          maxBytes: SCAN_LIMITS.MAX_HTML_BYTES,
          allowLocalFixtures,
          signal: ctx.signal
        });
      }

      onEvent({ type: 'stage', stage: 'url_check', state: 'done' });

      // Section 6.1: Site Status decided FIRST before any normal check
      const siteStatus = detectSiteStatus({
        requestedUrl: request.url,
        finalUrl: rootFetch.finalUrl || request.url,
        status: rootFetch.status,
        headers: rootFetch.headers,
        html: rootFetch.html,
        errorReasonAr: rootFetch.errorReasonAr
      });

      // If LiveProvider (no mock fallback) and site state is not 'ok', STOP normal checks and return Status Report
      if (siteStatus.state !== 'ok' && !this.allowMockFallbackWhenUnreachable) {
        onEvent({ type: 'stage', stage: 'discovery', state: 'skipped' });
        onEvent({ type: 'stage', stage: 'interaction', state: 'skipped' });
        onEvent({ type: 'stage', stage: 'lighthouse', state: 'skipped' });
        onEvent({
          type: 'stage',
          stage: 'report',
          state: 'started',
          detail: 'مدام عفاف بتجهز تقرير حالة الموقع بالدليل...'
        });

        const statusResult: ScanResult = {
          schemaVersion: '2.0',
          rulesetVersion: SCAN_LIMITS.RULESET_VERSION,
          isMockFallback: false,
          scanId,
          requestedUrl: request.url,
          finalUrl: rootFetch.finalUrl || request.url,
          registrableDomain: domain,
          status: ctx.isCancelled() ? 'cancelled' : 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
          limits: {
            maxPages: SCAN_LIMITS.MAX_PAGES_PER_SCAN
          },
          capabilities,
          pages:
            rootFetch.status > 0
              ? [
                  {
                    url: rootFetch.finalUrl || request.url,
                    httpStatus: rootFetch.status,
                    pageType: 'home',
                    viewportsChecked: checkedViewports
                  }
                ]
              : [],
          uniquePagesInspected: rootFetch.status > 0 ? 1 : 0,
          findings: [],
          passes: [],
          notMeasured: [],
          lighthouse: [],
          limitations: [
            'توقف الفحص المعتاد لأن الموقع في حالة خاصة (تقرير حالة الموقع فقط — ليس حكماً على جودة الكود).'
          ],
          siteStatus,
          verdict: {
            level: 'status_only',
            labelAr: 'تقرير حالة الموقع (لم يكتمل الفحص المعتاد)',
            summaryLinesAr: [siteStatus.whatISawAr, siteStatus.whatToDoAr],
            isPartial: true,
            partialReasonsAr: [siteStatus.whatItMeansAr],
            counts: {
              critical: 0,
              high: 0,
              medium: 0,
              low: 0,
              passed: 0,
              notMeasured: 0
            }
          },
          summaryAr: `${siteStatus.whatISawAr} ${siteStatus.whatItMeansAr} ${siteStatus.whatToDoAr}`,
          isHighProfileDomain: isHighProfileDomain(domain || request.url),
          highProfileNoticeAr: isHighProfileDomain(domain || request.url)
            ? HIGH_PROFILE_NOTICE_AR
            : undefined
        };

        onEvent({ type: 'stage', stage: 'report', state: 'done' });
        onEvent({ type: 'done', result: statusResult });
        return statusResult;
      }

      // If siteStatus === 'ok' (and we have real HTML) -> run full multi-page discovery + checks
      if (siteStatus.state === 'ok' && rootFetch.status > 0 && rootFetch.html.trim().length > 20) {
        const finalUrl = rootFetch.finalUrl || request.url;
        const deploymentFingerprint = computeDeploymentFingerprint({
          url: finalUrl,
          html: rootFetch.html,
          headers: rootFetch.headers
        });
        const isRescan = Boolean(request.isRescan || options.isRescan);

        // B3.3: On re-scan, if deploymentFingerprint is identical to previous scan and forceRescan is not set, stop early without consuming quota
        if (
          isRescan &&
          request.previousDeploymentFingerprint &&
          deploymentFingerprint === request.previousDeploymentFingerprint &&
          !request.forceRescan
        ) {
          const unchangedMessageAr = 'ما لقيتش تغيير في الموقع المنشور. غالبًا التعديلات ما اتنشرتش.';
          const earlyStopResult: ScanResult = {
            schemaVersion: '2.0',
            rulesetVersion: SCAN_LIMITS.RULESET_VERSION,
            isMockFallback: false,
            scanId,
            requestedUrl: request.url,
            finalUrl,
            registrableDomain: domain,
            status: 'completed',
            startedAt,
            finishedAt: new Date().toISOString(),
            limits: {
              maxPages: SCAN_LIMITS.MAX_PAGES_PER_SCAN
            },
            capabilities,
            pages: [],
            uniquePagesInspected: 0,
            findings: [],
            passes: [],
            notMeasured: [],
            lighthouse: [],
            limitations: [unchangedMessageAr],
            deploymentFingerprint,
            unchangedDeployment: true,
            unchangedMessageAr,
            rescanMode: request.rescanMode
          };
          onEvent({ type: 'stage', stage: 'discovery', state: 'skipped' });
          onEvent({ type: 'stage', stage: 'interaction', state: 'skipped' });
          onEvent({ type: 'stage', stage: 'lighthouse', state: 'skipped' });
          onEvent({ type: 'stage', stage: 'report', state: 'done', detail: unchangedMessageAr });
          onEvent({ type: 'done', result: earlyStopResult });
          return earlyStopResult;
        }

        const scanOptions = request.options;
        const checkPageSpeed = scanOptions?.checkPageSpeed ?? true;
        const checkLinks = scanOptions?.checkLinksAndErrors ?? true;
        const checkSeo = scanOptions?.checkSeo ?? true;
        const checkSecurityMobile = scanOptions?.checkSecurityAndMobile ?? true;

        // G1.4 & J1b & B1.3a: Start PSI in parallel right after homepage GET succeeds, with PSI_TIMEOUT_S=25 raced against ctx.remainingMs()
        const psiTimeoutMs = Math.min(
          options.psiTimeoutMs ?? SCAN_LIMITS.PSI_TIMEOUT_S * 1000,
          Math.max(1, ctx.remainingMs())
        );
        const hasCustomPsiRunner = Boolean(options.psiFetcher || options.psiFetch);
        const shouldRunPsi =
          checkPageSpeed &&
          (hasCustomPsiRunner || (capabilities.psi && !allowLocalFixtures)) &&
          ctx.canMakeRequest();
        const psiTaskPromise: Promise<PsiFetchOutcome> = shouldRunPsi
          ? options.psiFetcher
            ? (async (): Promise<PsiFetchOutcome> => {
                if (!isRescan) {
                  const cached = globalPsiCache.getWithMeta(
                    finalUrl,
                    'mobile',
                    deploymentFingerprint
                  );
                  if (cached) {
                    return {
                      data: {
                        ...cached.data,
                        fromCache: true,
                        cacheAgeMinutes: cached.ageMinutes,
                        cacheLabelAr: cached.labelAr
                      },
                      timedOut: false
                    };
                  }
                }
                let timer: NodeJS.Timeout | undefined;
                try {
                  const timeoutProm = new Promise<PsiFetchOutcome>(resolve => {
                    timer = setTimeout(
                      () =>
                        resolve({
                          data: null,
                          timedOut: true,
                          failureCode: 'timeout',
                          notMeasured: mapPsiFailureToNotMeasured('timeout')
                        }),
                      Math.max(1, Math.min(psiTimeoutMs, ctx.remainingMs()))
                    );
                  });
                  const customProm = options
                    .psiFetcher!(finalUrl, psiTimeoutMs, ctx.signal)
                    .then((d): PsiFetchOutcome => {
                      if (!d) return { data: null, timedOut: false };
                      const freshData: PsiMeasurement = {
                        ...d,
                        fromCache: false,
                        cacheAgeMinutes: 0,
                        cacheLabelAr: 'قياس جديد'
                      };
                      globalPsiCache.set(
                        finalUrl,
                        freshData,
                        'mobile',
                        deploymentFingerprint
                      );
                      return { data: freshData, timedOut: false };
                    })
                    .catch(
                      (): PsiFetchOutcome => ({
                        data: null,
                        timedOut: true,
                        failureCode: 'timeout',
                        notMeasured: mapPsiFailureToNotMeasured('timeout')
                      })
                    );
                  return await Promise.race([customProm, timeoutProm]);
                } finally {
                  if (timer) clearTimeout(timer);
                }
              })()
            : fetchPsiMetricsIfAvailable(finalUrl, psiTimeoutMs, ctx.signal, {
                apiKey: options.psiApiKey,
                fetchImpl: options.psiFetch,
                skipCache: isRescan,
                deploymentFingerprint
              })
          : Promise.resolve({ data: null, timedOut: false });

        onEvent({
          type: 'stage',
          stage: 'discovery',
          state: 'started',
          detail: 'بندوّر على أهم صفحات الموقع (القائمة، خريطة الموقع، الصفحات الأساسية)...'
        });

        const rootProfile = buildSiteProfile({
          url: finalUrl,
          html: rootFetch.html,
          headers: rootFetch.headers
        });

        const baseMaxPages =
          rootProfile.siteType === 'ecommerce' || rootProfile.type === 'ecommerce'
            ? Math.min(SCAN_LIMITS.MAX_PAGES_PER_SCAN, SCAN_LIMITS.ECOMMERCE_MAX_PAGES)
            : SCAN_LIMITS.MAX_PAGES_PER_SCAN;
        const effectiveMaxPages =
          typeof options.maxPagesOverride === 'number' && options.maxPagesOverride > 0
            ? Math.min(baseMaxPages, options.maxPagesOverride)
            : baseMaxPages;

        // Discover up to effectiveMaxPages (default 10) pages respecting robots.txt
        const discovery = await discoverSitePages({
          rootUrl: finalUrl,
          rootHtml: rootFetch.html,
          profile: rootProfile,
          maxPages: effectiveMaxPages,
          allowLocalFixtures,
          onRequestMade: ctx.canMakeRequest,
          remainingMs: ctx.remainingMs,
          signal: ctx.signal
        });

        const pages: PageInfo[] = [];
        const allRawFindings: Finding[] = [];
        const allPassesMap = new Map<string, PassItem>();
        const allNotMeasuredMap = new Map<string, NotMeasuredItem>();

        const isRemainingPagesMode =
          request.rescanMode === 'remaining_pages' &&
          Array.isArray(request.targetUrls) &&
          request.targetUrls.length > 0;
        const isSamePagesMode =
          request.rescanMode === 'same_pages' &&
          Array.isArray(request.targetUrls) &&
          request.targetUrls.length > 0;

        if (!isRemainingPagesMode) {
          const titleMatch = rootFetch.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          pages.push({
            url: finalUrl,
            title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'الصفحة الرئيسية',
            httpStatus: rootFetch.status,
            pageType: 'home',
            viewportsChecked: checkedViewports
          });
          onEvent({ type: 'page', url: finalUrl, index: 1 });
        }

        // G1.4 & B3.1: Determine subpage candidates based on rescanMode
        const normRoot = finalUrl.replace(/\/+$/, '');
        let subCandidates: DiscoveredCandidate[];
        let remainingDiscoveredNotScanned: string[] = discovery.discoveredNotScanned || [];

        if (isSamePagesMode) {
          subCandidates = request.targetUrls!
            .filter(u => u && u.replace(/\/+$/, '') !== normRoot)
            .slice(0, Math.max(0, SCAN_LIMITS.MAX_PAGES_PER_SCAN - 1))
            .map(u => ({
              url: u,
              source: 'nav' as const,
              priority: 1,
              pageType: 'content' as const
            }));
        } else if (isRemainingPagesMode) {
          subCandidates = request.targetUrls!
            .slice(0, effectiveMaxPages)
            .map(u => ({
              url: u,
              source: 'nav' as const,
              priority: 1,
              pageType: 'content' as const
            }));
          remainingDiscoveredNotScanned = request.targetUrls!.slice(effectiveMaxPages);
        } else {
          subCandidates = discovery.selectedUrls.slice(1, effectiveMaxPages);
        }

        const completedSubUrls = new Set<string>();
        const subPageResults: {
          cand: (typeof subCandidates)[number];
          index: number;
          subRes: Awaited<ReturnType<typeof safeFetchHtmlWithSsrf>>;
        }[] = [];

        await runWithConcurrency(
          subCandidates,
          SCAN_LIMITS.PAGE_CONCURRENCY,
          () => ctx.isCancelled() || ctx.isDeadlineExpired(),
          async (cand, i) => {
            if (ctx.isCancelled() || ctx.isDeadlineExpired()) return;
            if (!ctx.canMakeRequest()) return;

            onEvent({ type: 'page', url: cand.url, index: i + 2 });
            const subRes = await safeFetchHtmlWithSsrf(cand.url, {
              maxRedirects: 3,
              timeoutMs: Math.min(6000, Math.max(1, ctx.remainingMs())),
              maxBytes: 1536 * 1024,
              allowLocalFixtures,
              signal: ctx.signal
            });

            if (subRes.aborted || (subRes.timedOut && ctx.isDeadlineExpired())) {
              return;
            }

            completedSubUrls.add(cand.url);
            subPageResults.push({ cand, index: i, subRes });
          }
        );

        // Sort subPageResults by original discovery order for deterministic reporting
        subPageResults.sort((a, b) => a.index - b.index);

        for (const { cand, index: i, subRes } of subPageResults) {
          if (subRes.status > 0) {
            const subTitleM = subRes.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const subTitle = subTitleM
              ? subTitleM[1].replace(/\s+/g, ' ').trim()
              : cand.label || cand.url.split('/').filter(Boolean).pop() || 'صفحة داخلية';

            pages.push({
              url: cand.url,
              title: subTitle,
              httpStatus: subRes.status,
              pageType: cand.pageType || 'content',
              viewportsChecked: checkedViewports
            });

            if (subRes.status >= 400) {
              const classified = classifySubpageHttpStatus({
                candidate: cand,
                status: subRes.status,
                rootUrl: finalUrl,
                index: i
              });
              if (classified.finding) {
                allRawFindings.push(classified.finding);
              }
              if (classified.notMeasured) {
                allNotMeasuredMap.set(classified.notMeasured.id, classified.notMeasured);
              }
            } else if (subRes.html && subRes.html.length > 40) {
              const subChecks = runHonestChecks({
                url: cand.url,
                html: subRes.html,
                status: subRes.status,
                headers: subRes.headers,
                ttfbMs: subRes.ttfbMs,
                htmlBytes: subRes.htmlBytes,
                sampledImageSizes: [],
                psiData: null,
                capabilities
              });
              allRawFindings.push(
                ...subChecks.allNormalizedFindings.filter(f => f.ruleId !== 'R013_PERF')
              );
              for (const p of subChecks.passes) {
                if (!allPassesMap.has(p.id)) allPassesMap.set(p.id, p);
              }
            }
          }
        }

        // G1.5: Track unfinished discovered pages if deadline expired
        const unfinishedSubPages = subCandidates.filter(c => !completedSubUrls.has(c.url));
        const hitScanDeadline =
          ctx.isDeadlineExpired() && unfinishedSubPages.length > 0;

        if (hitScanDeadline) {
          for (let idx = 0; idx < unfinishedSubPages.length; idx++) {
            const unfin = unfinishedSubPages[idx];
            allNotMeasuredMap.set(`nm_deadline_page_${idx + 1}`, {
              id: `nm_deadline_page_${idx + 1}`,
              checkId: 'SCAN_DEADLINE_PAGE',
              category: 'performance',
              titleAr: `صفحة لم يكتمل فحصها: ${unfin.url}`,
              reasonAr: 'ميزانية الوقت خلصت'
            });
          }
        }

        onEvent({ type: 'stage', stage: 'discovery', state: 'done' });
        onEvent({
          type: 'stage',
          stage: 'interaction',
          state: 'started',
          detail: 'بنفحص الكود والصور والروابط وإعدادات الأمان...'
        });

        // G1.1 & G1.4: Sample up to 15 images AFTER pages via safeFetchHtmlWithSsrf (HEAD, maxRedirects: 0, concurrency: 4, timeout: 2s)
        const sampledImageSizes: SampledImageSize[] = [];
        if (capabilities.headRequests && !ctx.isCancelled() && !ctx.isDeadlineExpired()) {
          const imgUrls = Array.from(
            rootFetch.html.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi)
          )
            .map(m => m[1].trim())
            .filter(src => src && !src.startsWith('data:'));

          const uniqueImgUrls: string[] = [];
          for (const rawSrc of imgUrls) {
            try {
              const resolved = new URL(rawSrc, finalUrl).toString();
              if (!uniqueImgUrls.includes(resolved)) uniqueImgUrls.push(resolved);
            } catch {
              // ignore
            }
            if (uniqueImgUrls.length >= SCAN_LIMITS.MAX_SAMPLED_IMAGES_HEAD) break;
          }

          await runWithConcurrency(
            uniqueImgUrls,
            SCAN_LIMITS.IMAGE_HEAD_CONCURRENCY,
            () => ctx.isCancelled() || ctx.isDeadlineExpired(),
            async imgUrl => {
              if (ctx.isCancelled() || ctx.isDeadlineExpired()) return;
              if (!ctx.canMakeRequest()) return;
              try {
                const headRes = await safeFetchHtmlWithSsrf(imgUrl, {
                  method: 'HEAD',
                  maxRedirects: 0,
                  timeoutMs: Math.min(2000, Math.max(1, ctx.remainingMs())),
                  maxBytes: 0,
                  allowLocalFixtures,
                  signal: ctx.signal
                });
                if (headRes.ok && headRes.headers) {
                  const cl = headRes.headers.get('content-length');
                  if (cl && !isNaN(Number(cl))) {
                    sampledImageSizes.push({
                      url: imgUrl,
                      bytes: Number(cl),
                      contentType: headRes.headers.get('content-type') || undefined
                    });
                  }
                } else if (headRes.status === 404 || headRes.status >= 400) {
                  sampledImageSizes.push({
                    url: imgUrl,
                    bytes: 0,
                    broken: true,
                    status: headRes.status
                  });
                }
              } catch (err: any) {
                sampledImageSizes.push({
                  url: imgUrl,
                  bytes: 0,
                  broken: true,
                  status: 0,
                  error: err?.message || 'Network error'
                });
              }
            }
          );
        }

        // WordPress passive user enumeration check (single GET on /wp-json/wp/v2/users?per_page=3)
        if (
          rootProfile.platform === 'wordpress' &&
          !ctx.isCancelled() &&
          !ctx.isDeadlineExpired() &&
          ctx.canMakeRequest()
        ) {
          try {
            const origin = new URL(finalUrl).origin;
            const wpUsersUrl = `${origin}/wp-json/wp/v2/users?per_page=3`;
            const wpUsersRes = await safeFetchHtmlWithSsrf(wpUsersUrl, {
              timeoutMs: Math.min(4000, Math.max(1, ctx.remainingMs())),
              maxRedirects: 2,
              maxBytes: 128 * 1024,
              allowLocalFixtures,
              signal: ctx.signal
            });
            if (wpUsersRes.ok && wpUsersRes.status === 200 && wpUsersRes.html.trim().startsWith('[')) {
              const parsedUsers = JSON.parse(wpUsersRes.html);
              if (Array.isArray(parsedUsers) && parsedUsers.length > 0 && parsedUsers[0]?.slug) {
                const firstSlug = String(parsedUsers[0].slug);
                allRawFindings.push({
                  id: 'f_r010_wp_user_enum',
                  ruleId: 'R010',
                  category: 'security',
                  title: 'Publicly Exposed WordPress User Enumeration (/wp-json/wp/v2/users)',
                  titleAr: 'قائمة حسابات الإدارة في ووردبريس مكشوفة للجمهور على (/wp-json/wp/v2/users)',
                  kind: 'confirmed_defect',
                  severity: 'medium',
                  confidence: 'confirmed',
                  method: 'http',
                  affectsVerdict: true,
                  source: 'rule',
                  url: wpUsersUrl,
                  where: {
                    pageUrl: wpUsersUrl,
                    sectionAr: 'واجهة ووردبريس البرمجية (WP REST API)',
                    visibleText: firstSlug,
                    selector: '/wp-json/wp/v2/users',
                    snippet: `GET /wp-json/wp/v2/users -> 200 OK (slug: "${firstSlug}")`
                  },
                  occurrences: parsedUsers.length,
                  observed: `GET ${wpUsersUrl} returned HTTP 200 with ${parsedUsers.length} user object(s) (e.g., slug="${firstSlug}")`,
                  expected: 'Public user enumeration via REST API should be restricted to authenticated users',
                  steps: [`افتح الرابط ${wpUsersUrl} هتلاقي أسماء حسابات الإدارة ظاهرة`],
                  evidence: [
                    {
                      type: 'snippet',
                      value: `GET /wp-json/wp/v2/users -> 200 OK (slug: "${firstSlug}")`,
                      ref: `GET /wp-json/wp/v2/users -> 200 OK (slug: "${firstSlug}")`
                    }
                  ],
                  recommendedFix: 'من إضافة الحماية في ووردبريس (مثل Wordfence أو Disable REST API) اقفل عرض المسار /wp-json/wp/v2/users لغير المسجلين.'
                });
              }
            }
          } catch {
            // ignore wp-json users check failure
          }
        }

        // SPA passive secret-pattern scanning of up to 3 public JS files
        if (rootProfile.platform === 'spa' && !ctx.isCancelled() && !ctx.isDeadlineExpired()) {
          const spaSecrets = await scanPublicSpaJsForSecrets(
            rootFetch.html,
            finalUrl,
            ctx,
            allowLocalFixtures
          );
          allRawFindings.push(...spaSecrets);
        }

        onEvent({ type: 'stage', stage: 'interaction', state: 'done' });
        onEvent({
          type: 'stage',
          stage: 'lighthouse',
          state: 'started',
          detail: capabilities.psi
            ? 'بنقيس السرعة الفعلية من PageSpeed Insights...'
            : 'بنفحص حجم الصفحات ووقت استجابة السيرفر...'
        });

        // Await parallel PSI raced against remaining scan budget
        let psiData: PsiMeasurement | null = null;
        let psiNotMeasured: NotMeasuredItem | null = null;
        if (shouldRunPsi) {
          const remainingForPsi = ctx.remainingMs();
          if (remainingForPsi <= 0) {
            psiNotMeasured = mapPsiFailureToNotMeasured('timeout');
          } else {
            let raceTimer: NodeJS.Timeout | undefined;
            const raceOutcome = await Promise.race([
              psiTaskPromise,
              new Promise<PsiFetchOutcome>(resolve => {
                raceTimer = setTimeout(
                  () =>
                    resolve({
                      data: null,
                      timedOut: true,
                      failureCode: 'timeout',
                      notMeasured: mapPsiFailureToNotMeasured('timeout')
                    }),
                  remainingForPsi
                );
              })
            ]);
            if (raceTimer) clearTimeout(raceTimer);

            if (raceOutcome.timedOut) {
              psiNotMeasured = raceOutcome.notMeasured || mapPsiFailureToNotMeasured('timeout');
            } else if (raceOutcome.data) {
              psiData = raceOutcome.data;
            } else if (raceOutcome.notMeasured) {
              psiNotMeasured = raceOutcome.notMeasured;
            }
          }
        }

        // Run checks on Homepage with sampledImageSizes and psiData
        const homeChecks = runHonestChecks({
          url: finalUrl,
          html: rootFetch.html,
          status: rootFetch.status,
          headers: rootFetch.headers,
          ttfbMs: rootFetch.ttfbMs,
          htmlBytes: rootFetch.htmlBytes,
          sampledImageSizes,
          psiData,
          psiNotMeasured,
          discoveryMeta: {
            robotsTxtPresent: discovery.robotsTxtPresent,
            sitemapXmlPresent: discovery.sitemapXmlPresent
          },
          capabilities: {
            ...capabilities,
            psi: capabilities.psi || Boolean(psiData)
          }
        });

        allRawFindings.unshift(...homeChecks.allNormalizedFindings);
        for (const p of homeChecks.passes) allPassesMap.set(p.id, p);
        for (const nm of homeChecks.notMeasured) {
          allNotMeasuredMap.set(nm.id, nm);
        }

        // Record skipped pages by robots.txt in NOT_MEASURED
        if (discovery.skippedByRobots.length > 0) {
          allNotMeasuredMap.set('nm_robots_skipped', {
            id: 'nm_robots_skipped',
            checkId: 'ROBOTS_TXT',
            category: 'seo',
            titleAr: `صفحات تم تخطيها احتراماً لقواعد robots.txt (${discovery.skippedByRobots.length} صفحة)`,
            reasonAr: `ملف robots.txt في الموقع مانع الفحص الآلي للمسارات دي: ${discovery.skippedByRobots.slice(0, 3).join(' ، ')}`
          });
        }

        // Record skipped options in notMeasured
        if (!checkPageSpeed) {
          allNotMeasuredMap.set('nm_opt_pagespeed', {
            id: 'nm_opt_pagespeed',
            checkId: 'OPT_PAGESPEED',
            category: 'performance',
            titleAr: 'فحص السرعة والأداء (PageSpeed)',
            reasonAr: 'تم استثناء هذا الفحص بناءً على خيارات الفحص المحددة.'
          });
        }
        if (!checkLinks) {
          allNotMeasuredMap.set('nm_opt_links', {
            id: 'nm_opt_links',
            checkId: 'OPT_LINKS',
            category: 'links',
            titleAr: 'فحص الروابط والأخطاء التقنية',
            reasonAr: 'تم استثناء هذا الفحص بناءً على خيارات الفحص المحددة.'
          });
        }
        if (!checkSeo) {
          allNotMeasuredMap.set('nm_opt_seo', {
            id: 'nm_opt_seo',
            checkId: 'OPT_SEO',
            category: 'seo',
            titleAr: 'فحص السيو والظهور في محركات البحث (SEO)',
            reasonAr: 'تم استثناء هذا الفحص بناءً على خيارات الفحص المحددة.'
          });
        }
        if (!checkSecurityMobile) {
          allNotMeasuredMap.set('nm_opt_sec_mob', {
            id: 'nm_opt_sec_mob',
            checkId: 'OPT_SECURITY_MOBILE',
            category: 'security',
            titleAr: 'فحص الأمان وتجربة الموبايل',
            reasonAr: 'تم استثناء هذا الفحص بناءً على خيارات الفحص المحددة.'
          });
        }

        const filteredRawFindings = allRawFindings.filter(f => {
          if (!checkPageSpeed && f.category === 'performance') return false;
          if (!checkLinks && f.category === 'links') return false;
          if (!checkSeo && (f.category === 'seo' || f.category === 'content')) return false;
          if (!checkSecurityMobile && (f.category === 'security' || f.category === 'responsive' || f.category === 'accessibility')) return false;
          return true;
        });

        const deduplicatedFindings = mergeMultiPageFindings(filteredRawFindings);
        const mergedNormalized = normalizeAndCapFindings(deduplicatedFindings);
        const passesList = Array.from(allPassesMap.values()).filter(p => {
          if (!checkPageSpeed && p.category === 'performance') return false;
          if (!checkLinks && p.category === 'links') return false;
          if (!checkSeo && (p.category === 'seo' || p.category === 'content')) return false;
          if (!checkSecurityMobile && (p.category === 'security' || p.category === 'responsive' || p.category === 'accessibility')) return false;
          return true;
        });
        const notMeasuredList = Array.from(allNotMeasuredMap.values());

        const verdict = computeVerdict({
          findings: mergedNormalized.findings,
          passes: passesList,
          notMeasured: notMeasuredList,
          profile: homeChecks.profile,
          skippedByRobotsCount: discovery.skippedByRobots.length
        });

        if (hitScanDeadline && !verdict.isPartial) {
          verdict.isPartial = true;
          verdict.partialReasonsAr.push('ميزانية الوقت خلصت قبل فحص كل الصفحات المكتشفة.');
        }

        const aiClaimsComparison = evaluateAiClaims({
          aiClaimsText: request.aiClaims,
          findings: mergedNormalized.findings,
          passes: passesList,
          notMeasured: notMeasuredList
        });

        const lighthouseRuns: LighthouseRun[] =
          psiData && typeof psiData.lcpMs === 'number'
            ? [
                {
                  url: finalUrl,
                  formFactor: 'mobile',
                  metrics: {
                    fcpMs: psiData.fcpMs ? Math.round(psiData.fcpMs) : undefined,
                    lcpMs: Math.round(psiData.lcpMs),
                    cls: psiData.cls,
                    tbtMs: psiData.tbtMs ? Math.round(psiData.tbtMs) : undefined
                  },
                  categoryScores: {
                    performance: psiData.performanceScore,
                    seo: psiData.seoScore
                  },
                  failedAudits: [],
                  note: 'lab measurement',
                  cacheLabelAr: psiData.cacheLabelAr,
                  fromCache: psiData.fromCache
                }
              ]
            : [];

        onEvent({ type: 'stage', stage: 'lighthouse', state: 'done' });
        onEvent({
          type: 'stage',
          stage: 'report',
          state: 'started',
          detail: 'مدام عفاف بتختم التقرير بالدليل...'
        });

        // A5: ScanResult.status = 'completed' when all planned work finished;
        // 'partial' only for time budget, page failures, or robots skips.
        const hadSubpageFailure = subPageResults.some(
          r => r.subRes.status === 0 || r.subRes.status >= 500
        );
        const hadRobotsSkip = discovery.skippedByRobots.length > 0;
        const finalStatus = ctx.isCancelled()
          ? 'cancelled'
          : hitScanDeadline || hadSubpageFailure || hadRobotsSkip
            ? 'partial'
            : 'completed';

        const result: ScanResult = {
          schemaVersion: '2.0',
          rulesetVersion: SCAN_LIMITS.RULESET_VERSION,
          isMockFallback: false,
          scanId,
          requestedUrl: request.url,
          finalUrl,
          registrableDomain: domain,
          status: finalStatus,
          startedAt,
          finishedAt: new Date().toISOString(),
          limits: {
            maxPages: SCAN_LIMITS.MAX_PAGES_PER_SCAN
          },
          siteProfile: homeChecks.profile,
          capabilities,
          pages,
          discoveredNotScanned: remainingDiscoveredNotScanned,
          rescanMode: request.rescanMode,
          uniquePagesInspected: pages.length,
          findings: mergedNormalized.findings,
          overflowCountsByCategory: mergedNormalized.overflowCountsByCategory,
          passes: passesList,
          notMeasured: notMeasuredList,
          lighthouse: lighthouseRuns,
          limitations: [
            `تم فحص عينة (${pages.length}/${SCAN_LIMITS.MAX_PAGES_PER_SCAN} صفحات) باستخدام ${requestsUsed} طلب شبكة (تقييم للعينة المختارة وليس زحفاً كاملاً للموقع).`
          ],
          siteStatus,
          verdict,
          aiClaimsText: request.aiClaims,
          aiClaimsComparison,
          skippedByRobots: discovery.skippedByRobots,
          isHighProfileDomain: isHighProfileDomain(domain || request.url),
          highProfileNoticeAr: isHighProfileDomain(domain || request.url)
            ? HIGH_PROFILE_NOTICE_AR
            : undefined,
          deploymentFingerprint,
          psiCacheLabelAr: psiData?.cacheLabelAr,
          psiData: psiData || undefined,
          ttfbMs: rootFetch.ttfbMs
        };

        onEvent({ type: 'stage', stage: 'report', state: 'done' });
        onEvent({ type: 'done', result });
        return result;
      }

      // -------------------------------------------------------------------------
      // Labeled MOCK Fallback ONLY when MockProvider is explicitly used in offline tests
      // -------------------------------------------------------------------------
      onEvent({ type: 'page', url: `${request.url.replace(/\/$/, '')}/about`, index: 2 });
      await delay(100);
      onEvent({ type: 'page', url: `${request.url.replace(/\/$/, '')}/contact`, index: 3 });
      onEvent({ type: 'stage', stage: 'discovery', state: 'done' });

      onEvent({
        type: 'stage',
        stage: 'interaction',
        state: 'started',
        detail: 'فحص التجاوب والأزرار وحالات التفاعل (وضع محاكاة MOCK)'
      });
      await delay(100);
      onEvent({ type: 'stage', stage: 'interaction', state: 'done' });

      onEvent({
        type: 'stage',
        stage: 'lighthouse',
        state: 'started',
        detail: 'تجهيز بيانات الفحص التجريبي (MOCK)'
      });
      await delay(100);
      onEvent({ type: 'stage', stage: 'lighthouse', state: 'done' });

      onEvent({
        type: 'stage',
        stage: 'report',
        state: 'started',
        detail: 'تجهيز التقرير التجريبي [MOCK]'
      });
      await delay(100);

      const fallbackPages: PageInfo[] = [
        {
          url: request.url,
          title: 'الصفحة الرئيسية (MOCK)',
          httpStatus: 200,
          pageType: 'home',
          viewportsChecked: ['desktop', 'mobile']
        },
        {
          url: `${request.url.replace(/\/$/, '')}/about`,
          title: 'من نحن والخدمات (MOCK)',
          httpStatus: 200,
          pageType: 'content',
          viewportsChecked: ['desktop', 'mobile']
        },
        {
          url: `${request.url.replace(/\/$/, '')}/contact`,
          title: 'اتصل بنا (MOCK)',
          httpStatus: 200,
          pageType: 'contact',
          viewportsChecked: ['desktop', 'mobile']
        }
      ];

      const rawFallbackFindings: Finding[] = [
        {
          id: 'f_mock_1',
          ruleId: 'R001',
          category: 'links',
          title: '[MOCK] Broken Internal Navigation Link',
          titleAr: '[بيانات تجريبية MOCK] رابط داخلي معطل يفتح صفحة خطأ 404',
          kind: 'confirmed_defect',
          severity: 'high',
          confidence: 'confirmed',
          method: 'http',
          source: 'rule',
          url: `${request.url.replace(/\/$/, '')}/missing-page`,
          affectedUrls: [`${request.url.replace(/\/$/, '')}/missing-page`],
          occurrences: 1,
          observed: '[MOCK] HTTP GET returned status 404 Not Found',
          expected: 'Internal links should resolve with HTTP 200 OK',
          steps: ['Open homepage', 'Click link in primary nav', 'Received 404'],
          evidence: [
            {
              type: 'header',
              value: '[MOCK] GET /missing-page -> 404',
              ref: '[MOCK] GET /missing-page -> 404'
            }
          ],
          recommendedFix: 'قم بإصلاح مسار الرابط أو إعادة توجيهه (301 redirect) إلى الصفحة الصحيحة.'
        },
        {
          id: 'f_mock_2',
          ruleId: 'R005',
          category: 'responsive',
          title: '[MOCK] Inline Fixed Pixel Width (>390px) — Needs Real Mobile Check',
          titleAr: '[بيانات تجريبية MOCK] عرض ثابت بالبيكسل — محتاج تجربة حقيقية على الموبايل',
          kind: 'suspected_issue',
          severity: 'medium',
          confidence: 'likely',
          method: 'static_html',
          needsHumanDecision: true,
          source: 'rule',
          url: request.url,
          occurrences: 1,
          observed: '[MOCK] Inline style width: 520px found in markup (needs real mobile check)',
          expected: 'Containers should use width: 100%; max-width: 100%',
          steps: ['افتح الموقع على شاشة موبايل 390px واتأكد من عدم وجود تمرير أفقي'],
          evidence: [
            {
              type: 'snippet',
              value: '<div style="width: 520px">',
              ref: '<div style="width: 520px">'
            }
          ],
          recommendedFix: 'استبدل العرض الثابت (width: 520px) بـ width: 100%; max-width: 100%.'
        }
      ];

      const normalizedMock = normalizeAndCapFindings(rawFallbackFindings);
      const mockVerdict = computeVerdict({
        findings: normalizedMock.findings,
        passes: [],
        notMeasured: []
      });

      const result: ScanResult = {
        schemaVersion: '2.0',
        rulesetVersion: SCAN_LIMITS.RULESET_VERSION,
        isMockFallback: true,
        scanId,
        requestedUrl: request.url,
        finalUrl: request.url,
        registrableDomain: domain,
        status: 'partial',
        startedAt,
        finishedAt: new Date().toISOString(),
        limits: {
          maxPages: SCAN_LIMITS.MAX_PAGES_PER_SCAN
        },
        siteProfile: {
          type: 'standard',
          confidence: 0.5,
          signals: ['MOCK fallback: target unreachable from sandbox'],
          platform: 'unknown',
          builder: 'unknown',
          confidenceLevel: 'low',
          hasTailwind: false,
          isCodeRepoPlatform: true,
          language: 'ar',
          direction: 'rtl',
          siteType: 'unknown',
          siteTypeReason: 'بيانات محاكاة MOCK للاختبار فقط'
        },
        capabilities,
        pages: fallbackPages,
        uniquePagesInspected: fallbackPages.length,
        findings: normalizedMock.findings,
        overflowCountsByCategory: normalizedMock.overflowCountsByCategory,
        passes: [],
        notMeasured: [
          {
            id: 'nm_mock_unreachable',
            checkId: 'LIVE_FETCH',
            category: 'performance',
            titleAr: 'تعذر الوصول الحقيقي للموقع (بيانات MOCK تجريبية)',
            reasonAr: rootFetch.errorReasonAr || 'السيرفر مقدرش يوصل للرابط ده، فتم عرض نموذج تجريبي موضح بعلامة MOCK.',
            missingCapability: 'serverFetch'
          }
        ],
        lighthouse: [],
        limitations: [
          'تنبيه صدق: هذا التقرير معروض بعلامة [MOCK] للتجربة فقط وليس فحصاً حقيقياً.'
        ],
        verdict: mockVerdict
      };

      onEvent({ type: 'stage', stage: 'report', state: 'done' });
      onEvent({ type: 'done', result });

      return result;
    } finally {
      clearTimeout(deadlineTimer);
      if (options.signal) {
        options.signal.removeEventListener('abort', onCallerAbort);
      }
    }
  }
}

export class MockProvider extends LiveProvider {
  protected override allowMockFallbackWhenUnreachable = true;
}

export function getScannerProvider(mode: 'mock' | 'live'): ScannerProvider {
  if (mode === 'mock') return new MockProvider();
  return new LiveProvider();
}
