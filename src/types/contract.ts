// CONTRACT v1.1 - Honest Engine shared types for Madam Afaf scanner and UI.
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'improvement';
export type Confidence = 'confirmed' | 'likely' | 'suspected' | 'unverified';
export type Kind =
  | 'confirmed_defect'
  | 'suspected_issue'
  | 'unverified_behavior'
  | 'recommendation'
  | 'measurement';

export type TaxonomyCategory =
  | 'security'
  | 'accessibility'
  | 'seo'
  | 'links'
  | 'content'
  | 'performance'
  | 'responsive';

// Include legacy category aliases so existing tests and callers remain type-safe before normalization
export type Category =
  | TaxonomyCategory
  | 'navigation'
  | 'images'
  | 'console'
  | 'forms'
  | 'interaction'
  | 'requirement_gap';

export type FindingMethod = 'static_html' | 'http' | 'psi' | 'rendered' | 'llm_judgment';

export type Source = 'playwright' | 'lighthouse' | 'rule' | 'brief';

export type ScanStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unsupported_large_ecommerce'
  | 'blocked';


export type Stage = 'url_check' | 'discovery' | 'interaction' | 'lighthouse' | 'report';

export type Capability =
  | 'serverFetch'
  | 'responseHeaders'
  | 'timing'
  | 'htmlParser'
  | 'headRequests'
  | 'psi'
  | 'geminiStructuredOutput'
  | 'browserRendering';

export type CapabilitiesReport = Record<Capability, boolean>;

export interface Evidence {
  type:
    | 'snippet'
    | 'selector'
    | 'header'
    | 'url'
    | 'measurement'
    | 'quote'
    | 'screenshot'
    | 'dom_snippet'
    | 'network'
    | 'console'
    | 'lighthouse_audit'
    | 'text';
  id?: string;
  value?: string;
  location?: string;
  ref: string; // Backward-compatible alias for value
  note?: string;
  method?: FindingMethod;
}

export interface FindingWhere {
  pageUrl: string;
  sectionAr: string;
  visibleText: string;
  selector: string;
  snippet: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  category: Category;
  title: string;
  titleAr?: string;
  kind: Kind;
  severity: Severity;
  confidence: Confidence;
  method?: FindingMethod;
  needsHumanDecision?: boolean;
  affectsVerdict?: boolean;
  scope?: 'page' | 'site-wide';
  pages?: string[];
  where?: FindingWhere;
  source: Source;
  url: string;
  location?: string;
  affectedUrls?: string[];
  occurrences: number;
  observed: string;
  expected?: string;
  steps: string[];
  evidence: Evidence[];
  recommendedFix: string;
  explanationAr?: string;
  whyItMattersAr?: string;
  isAiGenerated?: boolean;
}

export interface PassItem {
  id: string;
  ruleId: string;
  category: TaxonomyCategory;
  titleAr: string;
  detailAr: string;
  evidence: string;
  method: FindingMethod;
}

export interface NotMeasuredItem {
  id: string;
  checkId: string;
  category: TaxonomyCategory;
  titleAr: string;
  reasonAr: string;
  whyNotMeasuredAr?: string;
  howItWillWorkAr?: string;
  whenAr?: string;
  missingCapability?: Capability;
  chipAr?: string;
  method?: FindingMethod;
}

export type PlatformKind =
  | 'wordpress'
  | 'shopify'
  | 'wix'
  | 'squarespace'
  | 'webflow'
  | 'nextjs'
  | 'ai_builder'
  | 'spa'
  | 'static_html'
  | 'custom'
  | 'unknown';

export type BuilderKind =
  | 'elementor'
  | 'divi'
  | 'wpbakery'
  | 'gutenberg'
  | 'lovable'
  | 'replit'
  | 'base44'
  | 'bolt'
  | 'v0'
  | 'emergent'
  | 'ai-studio'
  | 'none'
  | 'unknown';

export type SiteTypeKind =
  | 'b2b_manufacturer'
  | 'b2b_services'
  | 'ecommerce'
  | 'portfolio'
  | 'landing'
  | 'blog'
  | 'corporate'
  | 'unknown';

export type ConversionKind = 'whatsapp' | 'phone' | 'form' | 'cart' | 'none';

export interface SiteProfile {
  // Legacy compatibility fields
  type: 'standard' | 'ecommerce' | 'unknown';
  confidence: number;
  signals: string[];
  // Honest Engine v1.1 rich site profile fields
  platform?: PlatformKind;
  builder?: BuilderKind;
  version?: string;
  confidenceLevel?: 'high' | 'medium' | 'low';
  platformConfidence?: 'high' | 'medium' | 'low';
  hasTailwind?: boolean;
  isCodeRepoPlatform?: boolean;
  language?: string;
  direction?: 'rtl' | 'ltr' | 'auto';
  arabicRatio?: number;
  siteType?: SiteTypeKind;
  siteTypeReason?: string;
  primaryConversion?: {
    type: ConversionKind;
    inTopOfPage: boolean;
    evidence?: string;
  };
  markets?: {
    countriesOrRegions: string[];
    hasExportClaims: boolean;
    hasAlternateLanguage: boolean;
    alternateLangEvidence?: string;
  };
}

export interface PageInfo {
  url: string;
  title?: string;
  httpStatus?: number;
  pageType?: 'home' | 'listing' | 'product' | 'content' | 'contact' | 'other';
  viewportsChecked: ('desktop' | 'mobile')[];
}

export interface LighthouseRun {
  url: string;
  formFactor: 'mobile' | 'desktop';
  metrics: {
    fcpMs?: number;
    lcpMs?: number;
    cls?: number;
    tbtMs?: number;
    speedIndexMs?: number;
  };
  categoryScores?: {
    performance?: number;
    seo?: number;
  };
  failedAudits: {
    id: string;
    title: string;
    displayValue?: string;
  }[];
  note: 'lab measurement';
  cacheLabelAr?: string;
  fromCache?: boolean;
}

export interface Brief {
  siteType?: 'company' | 'store' | 'landing' | 'booking' | 'unknown';
  goals?: string[];
  mustHavePages?: string[];
  keyJourneys?: string[];
}

export type SiteStateType =
  | 'ok'
  | 'maintenance_or_coming_soon'
  | 'blocked_by_protection'
  | 'parked_or_default_page'
  | 'unreachable'
  | 'auth_wall'
  | 'redirected_elsewhere'
  | 'non_html'
  | 'empty_response';

export interface SiteStatusReport {
  state: SiteStateType;
  whatISawAr: string;
  whatItMeansAr: string;
  whatToDoAr: string;
  redirectedToDomain?: string;
  evidence: Evidence[];
}

export interface VerdictDriver {
  findingId: string;
  ruleId: string;
  severity: Severity;
  summaryAr: string;
}

export interface VerdictInfo {
  level: 'fix_before_handover' | 'needs_work_before_launch' | 'ready_with_notes' | 'status_only';
  labelAr: string;
  headlineAr?: string;
  summaryLinesAr: [string, string];
  drivers?: VerdictDriver[];
  isPartial: boolean;
  partialReasonsAr: string[];
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    passed: number;
    notMeasured: number;
  };
}

export interface ClaimComparisonItem {
  claimAr: string;
  realityAr: string;
  status: 'verified_true' | 'contradicted' | 'not_measured';
  evidenceRef?: string;
}

export interface RescanMetricDelta {
  metric: 'LCP' | 'CLS' | 'TBT' | 'TTFB';
  before: number;
  after: number;
  unit: 'ms' | 's' | '';
  delta: number;
  deltaText?: string;
  statusAr: 'تحسّن' | 'ثابت' | 'اتراجع';
  note: 'lab';
}

export type RescanMode = 'same_pages' | 'remaining_pages';

export interface RescanComparison {
  previousScanId: string;
  previousScanDate: string;
  resolvedRuleIds: { ruleId: string; titleAr: string; fingerprint?: string; confirmed?: boolean }[];
  stillOpenRuleIds: { ruleId: string; titleAr: string; fingerprint?: string; confirmed?: boolean }[];
  newRuleIds: { ruleId: string; titleAr: string; fingerprint?: string; confirmed?: boolean }[];
  resolvedConfirmedCount?: number;
  stillOpenConfirmedCount?: number;
  allConfirmedResolved?: boolean;
  metricDeltas?: RescanMetricDelta[];
}

export interface ScanOptionsConfig {
  checkPageSpeed?: boolean; // فحص السرعة والأداء (PageSpeed)
  checkLinksAndErrors?: boolean; // فحص الروابط والأخطاء التقنية
  checkSeo?: boolean; // فحص السيو والظهور في محركات البحث (SEO)
  checkSecurityAndMobile?: boolean; // فحص الأمان وتجربة الموبايل
}

export interface ScanRequest {
  url: string;
  purpose?: string;
  keyJourney?: string;
  aiClaims?: string;
  brief?: Brief;
  options?: ScanOptionsConfig;
  isRescan?: boolean;
  rescanMode?: RescanMode;
  forceRescan?: boolean;
  previousDeploymentFingerprint?: string;
  targetUrls?: string[];
  locale: 'ar-EG';
}

export interface ScanResult {
  schemaVersion: '1.0' | '1.1' | '2.0';
  rulesetVersion?: string;
  isMockFallback?: boolean;
  scanId: string;
  requestedUrl: string;
  finalUrl?: string;
  registrableDomain: string;
  status: ScanStatus;
  startedAt: string;
  finishedAt?: string;
  limits: {
    maxPages: number;
    maxLighthousePages?: number;
  };
  siteProfile?: SiteProfile;
  capabilities?: CapabilitiesReport;
  pages: PageInfo[];
  discoveredNotScanned?: string[];
  uniquePagesInspected: number;
  interactionStatesTested?: number;
  findings: Finding[];
  overflowCountsByCategory?: Partial<Record<TaxonomyCategory, number>>;
  passes?: PassItem[];
  notMeasured?: NotMeasuredItem[];
  lighthouse: LighthouseRun[];
  limitations: string[];
  summaryAr?: string;
  repairMode?: 'cms_checklist' | 'code_agent_prompt';
  masterRepairPrompt?: string;
  confirmedOnlyMasterRepairPrompt?: string;
  developerMarkdownHandoff?: string;
  confirmedOnlyDeveloperMarkdownHandoff?: string;
  cmsChecklistItems?: string[];
  individualRepairPrompts?: Record<string, string>;
  siteStatus?: SiteStatusReport;
  verdict?: VerdictInfo;
  aiClaimsText?: string;
  aiClaimsComparison?: ClaimComparisonItem[];
  rescanComparison?: RescanComparison;
  skippedByRobots?: string[];
  isSharedView?: boolean;
  shareExpiresAt?: number;
  isHighProfileDomain?: boolean;
  highProfileNoticeAr?: string;
  deploymentFingerprint?: string;
  psiCacheLabelAr?: string;
  psiData?: any;
  ttfbMs?: number;
  reviewNumber?: number;
  previousScanId?: string;
  rescanMode?: RescanMode;
  unchangedDeployment?: boolean;
  unchangedMessageAr?: string;
}

export interface VisitorReportSummary {
  scanId: string;
  registrableDomain: string;
  requestedUrl: string;
  status: ScanStatus;
  reviewNumber: number;
  createdAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  verdictLevel?: string;
  verdictLabelAr?: string;
  verdictHeadlineAr?: string;
  confirmedCount: number;
  suspectedCount: number;
  notMeasuredCount: number;
  uniquePagesInspected: number;
}

export type ScanStreamEvent =
  | { type: 'stage'; stage: Stage; state: 'started' | 'done' | 'skipped'; detail?: string }
  | { type: 'page'; url: string; index: number }
  | { type: 'done'; result: ScanResult }
  | { type: 'error'; code: 'invalid_url' | 'blocked_target' | 'busy' | 'timeout' | 'internal'; message: string };


