import { ScanResult, SiteProfile } from '../types/contract';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatFindingSummaryItem {
  ruleId: string;
  category: string;
  severity: string;
  titleAr: string;
  url: string;
  observed?: string;
  recommendedFix?: string;
}

export interface ChatContext {
  scanId?: string;
  url?: string;
  domain?: string;
  findingId?: string;
  findingTitle?: string;
  findingsSummary?: string;
  masterRepairPrompt?: string;
  verdictLabelAr?: string;
  pagesCount?: number;
  pagesUrls?: string[];
  topFindings?: ChatFindingSummaryItem[];
  notMeasuredTitles?: string[];
  siteProfile?: SiteProfile;
}

export const NO_SITE_SCANNED_PROMPT =
  'أنت لسه ما ضفتش موقع عشان أفحصهولك، ابعتلي لينك الموقع هنا في الشات أو ضيفه في خانة الفحص وأنا أراجعهولك فوراً.';

export function buildContextFromScanResult(scanResult?: ScanResult | null): ChatContext | undefined {
  if (!scanResult) return undefined;
  const topFindings: ChatFindingSummaryItem[] = (scanResult.findings || []).slice(0, 12).map(f => ({
    ruleId: f.ruleId,
    category: f.category,
    severity: f.severity,
    titleAr: f.titleAr || f.title,
    url: f.url || scanResult.finalUrl || scanResult.requestedUrl,
    observed: f.observed,
    recommendedFix: f.recommendedFix
  }));

  const pagesUrls = (scanResult.pages || []).slice(0, 10).map(p => p.url);
  const notMeasuredTitles = (scanResult.notMeasured || []).slice(0, 6).map(nm => `${nm.titleAr} (${nm.reasonAr})`);

  return {
    scanId: scanResult.isSharedView ? undefined : scanResult.scanId,
    url: scanResult.finalUrl || scanResult.requestedUrl,
    domain: scanResult.registrableDomain,
    verdictLabelAr: scanResult.verdict?.labelAr,
    siteProfile: scanResult.siteProfile,
    pagesCount: scanResult.uniquePagesInspected || pagesUrls.length || 1,
    pagesUrls,
    findingsSummary:
      scanResult.summaryAr ||
      `الموقع ${scanResult.registrableDomain} اتفحص فيه ${scanResult.uniquePagesInspected || 1} صفحات وطلع فيه ${(scanResult.findings || []).length} ملاحظات.`,
    masterRepairPrompt: scanResult.masterRepairPrompt,
    topFindings,
    notMeasuredTitles
  };
}
