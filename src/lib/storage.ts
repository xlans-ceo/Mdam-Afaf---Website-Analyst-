/**
 * Server-Side Persistence, Scan Job Lifecycle, Per-(Visitor, Domain) Quota,
 * Private Report Ownership, Tombstones (410 Gone), Hashed Share Tokens with Revocation & Allowlist DTO,
 * Rate Limiting, Concurrency Slots, and HMAC-SHA256 Visitor Hashing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SCAN_LIMITS } from '../config/limits.server';
import { HIGH_PROFILE_NOTICE_AR, isHighProfileDomain } from '../config/limits';
import {
  Evidence,
  Finding,
  RescanComparison,
  RescanMetricDelta,
  RescanMode,
  ScanResult,
  ScanStatus,
  Stage,
  VisitorReportSummary
} from '../types/contract';
import { getRegistrableDomain } from './domain-parser';
import { computeFindingFingerprint } from './fingerprint';
import {
  truncateReportEvidenceToCap,
  ReportFeedbackRecord,
  FindingFeedbackRecord,
  AdminFeedbackOverview
} from './store-interface';
import { RELEASE_CONFIG } from '../config/release';

export interface VisitorIdentity {
  visitorId: string;
  email?: string;
}

const DEFAULT_DEV_VISITOR_SALT = 'madam-afaf-default-visitor-salt-v2';
const RUNTIME_FALLBACK_VISITOR_SALT = crypto.randomBytes(32).toString('hex');

/**
 * C3: Validates VISITOR_ID_SALT:
 * - Treats empty/whitespace as missing
 * - In NODE_ENV === 'production', requires >= 32 characters or throws to refuse startup
 */
export function validateVisitorIdSalt(
  env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {}
): { valid: true; salt: string } {
  const rawSalt = (env.VISITOR_ID_SALT ?? '').trim();
  const isProd = (env.NODE_ENV || '').trim() === 'production';

  if (isProd) {
    if (!rawSalt || rawSalt.length < 32 || rawSalt === 'change_me_in_production') {
      throw new Error(
        'FATAL [C3]: VISITOR_ID_SALT must be set to a non-empty secret of at least 32 characters in production.'
      );
    }
    return { valid: true, salt: rawSalt };
  }

  return { valid: true, salt: rawSalt || DEFAULT_DEV_VISITOR_SALT };
}

export function ensureRuntimeVisitorIdSalt(
  env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {}
): { provisionedEphemeral: boolean } {
  const rawSalt = (env.VISITOR_ID_SALT ?? '').trim();
  const isProd = (env.NODE_ENV || '').trim() === 'production';
  if (isProd && (!rawSalt || rawSalt.length < 32 || rawSalt === 'change_me_in_production')) {
    env.VISITOR_ID_SALT = RUNTIME_FALLBACK_VISITOR_SALT;
    return { provisionedEphemeral: true };
  }
  return { provisionedEphemeral: false };
}

export function hashVisitorId(rawVisitorId: string, saltOverride?: string): string {
  const clean = (rawVisitorId || '').trim();
  if (/^vh_[0-9a-f]{64}$/i.test(clean)) {
    return clean.toLowerCase();
  }
  const overrideTrimmed = typeof saltOverride === 'string' ? saltOverride.trim() : '';
  let salt = overrideTrimmed;
  if (!salt) {
    try {
      salt = validateVisitorIdSalt().salt;
    } catch {
      salt = RUNTIME_FALLBACK_VISITOR_SALT;
    }
  }
  const digest = crypto.createHmac('sha256', salt).update(clean).digest('hex');
  return `vh_${digest}`;
}

export function hashShareToken(rawToken: string): string {
  const clean = (rawToken || '').trim();
  if (/^sh_[0-9a-f]{64}$/i.test(clean)) {
    return clean.toLowerCase();
  }
  const digest = crypto.createHash('sha256').update(clean).digest('hex');
  return `sh_${digest}`;
}

export function getActiveScanMarkerId(visitorHash: string, registrableDomain: string): string {
  const cleanVh = (visitorHash || '').trim().toLowerCase();
  const cleanDomain = (registrableDomain || '').trim().toLowerCase();
  return `active_${cleanVh}_${cleanDomain}`;
}

/**
 * Redacts secret-like patterns (Bearer tokens, API keys) and private/internal hosts
 * from strings exposed in shared reports.
 */
export function redactSharedText(input: string | undefined): string {
  if (!input || typeof input !== 'string') return '';
  let out = input;

  // 1. Redact Bearer / Authorization tokens
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]');

  // 2. Redact common secret key prefixes (OpenAI, Google, AWS, GitHub, Slack, Stripe)
  out = out.replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|rk_live_[A-Za-z0-9]{12,}|sk_live_[A-Za-z0-9]{12,})\b/g,
    '[REDACTED_SECRET]'
  );

  // 3. Redact generic key=value secret assignments
  out = out.replace(
    /((?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}(["']?)/gi,
    '$1[REDACTED_SECRET]$2'
  );

  // 4. Redact private/loopback/link-local hosts and IPs
  out = out.replace(
    /\b(?:https?:\/\/)?(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|\[::1\])(?::\d{1,5})?\b/gi,
    '[REDACTED_PRIVATE_HOST]'
  );

  return out;
}

function sanitizeSharedEvidence(ev: Evidence): Evidence {
  return {
    type: ev.type,
    value: ev.value !== undefined ? redactSharedText(ev.value) : undefined,
    location: ev.location !== undefined ? redactSharedText(ev.location) : undefined,
    ref: redactSharedText(ev.ref || ev.value || ''),
    note: ev.note !== undefined ? redactSharedText(ev.note) : undefined
  };
}

function sanitizeSharedFinding(f: Finding): Finding {
  return {
    id: f.id,
    ruleId: f.ruleId,
    category: f.category,
    title: redactSharedText(f.title),
    titleAr: f.titleAr ? redactSharedText(f.titleAr) : undefined,
    kind: f.kind,
    severity: f.severity,
    confidence: f.confidence,
    method: f.method,
    affectsVerdict: f.affectsVerdict,
    needsHumanDecision: f.needsHumanDecision,
    source: f.source,
    url: redactSharedText(f.url),
    location: f.location ? redactSharedText(f.location) : undefined,
    where: f.where
      ? {
          pageUrl: redactSharedText(f.where.pageUrl),
          sectionAr: f.where.sectionAr,
          visibleText: redactSharedText(f.where.visibleText),
          selector: f.where.selector,
          snippet: redactSharedText(f.where.snippet)
        }
      : undefined,
    scope: f.scope,
    pages: Array.isArray(f.pages) ? f.pages.map(u => redactSharedText(u)) : undefined,
    affectedUrls: Array.isArray(f.affectedUrls)
      ? f.affectedUrls.map(u => redactSharedText(u))
      : undefined,
    occurrences: f.occurrences,
    observed: redactSharedText(f.observed),
    expected: f.expected ? redactSharedText(f.expected) : undefined,
    steps: Array.isArray(f.steps) ? f.steps.map(s => redactSharedText(s)) : [],
    evidence: Array.isArray(f.evidence) ? f.evidence.map(sanitizeSharedEvidence) : [],
    recommendedFix: redactSharedText(f.recommendedFix),
    explanationAr: f.explanationAr ? redactSharedText(f.explanationAr) : undefined,
    whyItMattersAr: f.whyItMattersAr ? redactSharedText(f.whyItMattersAr) : undefined,
    isAiGenerated: f.isAiGenerated
  };
}

/**
 * H4: Builds a shared report strictly from an ALLOWLIST DTO:
 * - Replaces the real scanId with share.shareId
 * - Redacts secret-like evidence and private hosts
 * - Never includes visitorId, visitorIdHash, rescanComparison, or un-allowlisted properties
 */
export function buildSharedReportDto(source: ScanResult, share: ShareRecord): ScanResult {
  const individualPrompts: Record<string, string> = {};
  if (source.individualRepairPrompts && typeof source.individualRepairPrompts === 'object') {
    for (const [k, v] of Object.entries(source.individualRepairPrompts)) {
      individualPrompts[k] = redactSharedText(v);
    }
  }

  const dto: ScanResult = {
    schemaVersion: source.schemaVersion || '2.0',
    rulesetVersion: source.rulesetVersion,
    isMockFallback: source.isMockFallback,
    scanId: share.shareId,
    isSharedView: true,
    shareExpiresAt: share.expiresAtMs,
    requestedUrl: redactSharedText(source.requestedUrl),
    finalUrl: source.finalUrl ? redactSharedText(source.finalUrl) : undefined,
    registrableDomain: source.registrableDomain,
    status: source.status,
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    limits: source.limits
      ? {
          maxPages: source.limits.maxPages
        }
      : { maxPages: 10 },
    capabilities: source.capabilities ? { ...source.capabilities } : undefined,
    pages: Array.isArray(source.pages)
      ? source.pages.map(p => ({
          url: redactSharedText(p.url),
          title: p.title,
          httpStatus: p.httpStatus,
          pageType: p.pageType,
          viewportsChecked: Array.isArray(p.viewportsChecked) ? [...p.viewportsChecked] : ['desktop']
        }))
      : [],
    uniquePagesInspected: source.uniquePagesInspected,
    findings: Array.isArray(source.findings) ? source.findings.map(sanitizeSharedFinding) : [],
    passes: Array.isArray(source.passes)
      ? source.passes.map(p => ({
          id: p.id,
          ruleId: p.ruleId,
          category: p.category,
          titleAr: p.titleAr,
          detailAr: redactSharedText(p.detailAr),
          evidence: redactSharedText(p.evidence),
          method: p.method
        }))
      : [],
    notMeasured: Array.isArray(source.notMeasured)
      ? source.notMeasured.map(nm => ({
          id: nm.id,
          checkId: nm.checkId,
          category: nm.category,
          titleAr: nm.titleAr,
          reasonAr: redactSharedText(nm.reasonAr),
          whyNotMeasuredAr: nm.whyNotMeasuredAr ? redactSharedText(nm.whyNotMeasuredAr) : undefined,
          howItWillWorkAr: nm.howItWillWorkAr ? redactSharedText(nm.howItWillWorkAr) : undefined,
          whenAr: nm.whenAr ? redactSharedText(nm.whenAr) : undefined,
          missingCapability: nm.missingCapability,
          chipAr: nm.chipAr
        }))
      : [],
    lighthouse: Array.isArray(source.lighthouse) ? [...source.lighthouse] : [],
    limitations: Array.isArray(source.limitations) ? [...source.limitations] : [],
    siteStatus: source.siteStatus
      ? {
          state: source.siteStatus.state,
          whatISawAr: redactSharedText(source.siteStatus.whatISawAr),
          whatItMeansAr: redactSharedText(source.siteStatus.whatItMeansAr),
          whatToDoAr: redactSharedText(source.siteStatus.whatToDoAr),
          redirectedToDomain: source.siteStatus.redirectedToDomain,
          evidence: Array.isArray(source.siteStatus.evidence)
            ? source.siteStatus.evidence.map(sanitizeSharedEvidence)
            : []
        }
      : undefined,
    siteProfile: source.siteProfile ? JSON.parse(JSON.stringify(source.siteProfile)) : undefined,
    verdict: source.verdict ? JSON.parse(JSON.stringify(source.verdict)) : undefined,
    aiClaimsComparison: Array.isArray(source.aiClaimsComparison)
      ? source.aiClaimsComparison.map(c => ({ ...c }))
      : undefined,
    summaryAr: source.summaryAr ? redactSharedText(source.summaryAr) : undefined,
    repairMode: source.repairMode,
    masterRepairPrompt: source.masterRepairPrompt
      ? redactSharedText(source.masterRepairPrompt)
      : undefined,
    cmsChecklistItems: Array.isArray(source.cmsChecklistItems)
      ? source.cmsChecklistItems.map(item => redactSharedText(item))
      : undefined,
    individualRepairPrompts:
      Object.keys(individualPrompts).length > 0 ? individualPrompts : undefined
  };

  return dto;
}

/**
 * H3: Single Quota Structure keyed by `${visitorHash}:${rootDomain}`
 */
export interface VisitorDomainQuotaRecord {
  windowStartMs: number;
  expiresAtMs: number;
  pagesCommitted: number;
  reservations: Record<string, number>; // scanId -> pages reserved
  committedUrls?: string[];
  reviewsCommitted?: number;
  reviewReservations?: Record<string, number>; // scanId -> reviews reserved
  committedScanIds?: string[];
}

export interface QuotaStatus {
  domain: string | null;
  pagesUsed: number;
  pagesRemaining: number;
  maxPages: number;
  reviewsUsed?: number;
  reviewsRemaining?: number;
  maxReviews?: number;
  resetAt: string | null;
  exhausted: boolean;
  remainingMinutes: number;
}

export interface StoredReportRecord {
  scanId: string;
  visitorIdHash: string;
  registrableDomain: string;
  createdAtMs: number;
  expiresAtMs: number;
  result: ScanResult;
}

export interface StoredJobRecord {
  scanId: string;
  visitorIdHash: string;
  requestedUrl: string;
  normalizedUrl: string;
  registrableDomain: string;
  status: ScanStatus;
  currentStage: Stage;
  stageStates: Record<Stage, 'pending' | 'started' | 'done' | 'skipped'>;
  stageDetail?: string;
  inspectedPagesCount: number;
  result?: ScanResult;
  errorMessage?: string;
  errorCode?: string;
  queuePosition?: number;
  createdAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  expiresAtMs: number;
}

export interface TombstoneRecord {
  scanId: string;
  visitorIdHash: string;
  reason: 'deleted' | 'expired';
  tombstonedAtMs: number;
}

export interface ShareRecord {
  tokenHash: string;
  shareId: string;
  scanId: string;
  visitorIdHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs?: number;
}

export interface ActiveScanMarkerRecord {
  markerId: string;
  visitorIdHash: string;
  registrableDomain: string;
  scanId: string;
  status: 'queued' | 'running';
  createdAtMs: number;
  expiresAtMs: number;
}

export interface IdempotencyRecord {
  key: string;
  visitorIdHash: string;
  scanId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

interface PersistentStoreData {
  quotas: Record<string, VisitorDomainQuotaRecord>;
  reports: Record<string, StoredReportRecord>;
  jobs: Record<string, StoredJobRecord>;
  tombstones: Record<string, TombstoneRecord>;
  feedback: FindingFeedbackRecord[];
  reportFeedback?: ReportFeedbackRecord[];
  shares: Record<string, ShareRecord>;
  activeMarkers: Record<string, ActiveScanMarkerRecord>;
  idempotencyKeys: Record<string, IdempotencyRecord>;
}

export type RateLimitBucket = 'scan' | 'chat' | 'tts' | 'transcribe' | 'share';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  process.execArgv.some(arg => arg.includes('test')) ||
  process.env.npm_lifecycle_event === 'test';

const STORE_FILE = path.join(DATA_DIR, isTestEnv ? 'store.test.json' : 'store.json');

export function computeRescanDiff(prev: ScanResult, curr: ScanResult): RescanComparison {
  const prevByFp = new Map<string, { ruleId: string; titleAr: string; fingerprint: string; isConfirmed: boolean }>();
  for (const f of prev.findings || []) {
    const fp = computeFindingFingerprint(f);
    prevByFp.set(fp, {
      ruleId: f.ruleId,
      titleAr: f.titleAr || f.title,
      fingerprint: fp,
      isConfirmed: f.confidence === 'confirmed'
    });
  }
  const currByFp = new Map<string, { ruleId: string; titleAr: string; fingerprint: string; isConfirmed: boolean }>();
  for (const f of curr.findings || []) {
    const fp = computeFindingFingerprint(f);
    currByFp.set(fp, {
      ruleId: f.ruleId,
      titleAr: f.titleAr || f.title,
      fingerprint: fp,
      isConfirmed: f.confidence === 'confirmed'
    });
  }

  const resolvedRuleIds: { ruleId: string; titleAr: string; fingerprint?: string }[] = [];
  const stillOpenRuleIds: { ruleId: string; titleAr: string; fingerprint?: string }[] = [];
  const newRuleIds: { ruleId: string; titleAr: string; fingerprint?: string }[] = [];
  let resolvedConfirmedCount = 0;

  for (const [fp, item] of prevByFp.entries()) {
    const { ruleId, titleAr, fingerprint } = item;
    if (currByFp.has(fp)) {
      stillOpenRuleIds.push({ ruleId, titleAr, fingerprint });
    } else {
      resolvedRuleIds.push({ ruleId, titleAr, fingerprint });
      if (item.isConfirmed) {
        resolvedConfirmedCount++;
      }
    }
  }

  for (const [fp, item] of currByFp.entries()) {
    if (!prevByFp.has(fp)) {
      const { ruleId, titleAr, fingerprint } = item;
      newRuleIds.push({ ruleId, titleAr, fingerprint });
    }
  }

  const stillOpenConfirmedCount = Array.from(currByFp.values()).filter(item => item.isConfirmed).length;
  const prevConfirmedCount = Array.from(prevByFp.values()).filter(item => item.isConfirmed).length;
  const allConfirmedResolved =
    stillOpenConfirmedCount === 0 && (prevConfirmedCount > 0 || resolvedConfirmedCount > 0);

  // B1.3h & B3: Compare grouped performance metrics (before -> after with delta, labeled lab)
  const metricDeltas: RescanMetricDelta[] = [];
  const extractMetrics = (scan: ScanResult) => {
    const lh = Array.isArray(scan.lighthouse) && scan.lighthouse[0]?.metrics ? scan.lighthouse[0].metrics : undefined;
    const psi = (scan as any).psiData;
    return {
      lcpMs: typeof psi?.lcpMs === 'number' ? psi.lcpMs : typeof lh?.lcpMs === 'number' ? lh.lcpMs : undefined,
      cls: typeof psi?.cls === 'number' ? psi.cls : typeof lh?.cls === 'number' ? lh.cls : undefined,
      tbtMs: typeof psi?.tbtMs === 'number' ? psi.tbtMs : typeof lh?.tbtMs === 'number' ? lh.tbtMs : undefined,
      ttfbMs: typeof scan.ttfbMs === 'number' ? scan.ttfbMs : undefined
    };
  };

  const prevM = extractMetrics(prev);
  const currM = extractMetrics(curr);

  const pushDelta = (
    metric: 'LCP' | 'CLS' | 'TBT' | 'TTFB',
    beforeVal: number | undefined,
    afterVal: number | undefined,
    unit: 'ms' | 's' | '',
    decimals = 0
  ) => {
    if (typeof beforeVal !== 'number' || typeof afterVal !== 'number') return;
    const rawDelta = afterVal - beforeVal;
    const delta = decimals > 0 ? Number(rawDelta.toFixed(decimals)) : Math.round(rawDelta);
    const statusAr: 'تحسّن' | 'ثابت' | 'اتراجع' =
      delta < 0 ? 'تحسّن' : delta > 0 ? 'اتراجع' : 'ثابت';
    metricDeltas.push({
      metric,
      before: decimals > 0 ? Number(beforeVal.toFixed(decimals)) : Math.round(beforeVal),
      after: decimals > 0 ? Number(afterVal.toFixed(decimals)) : Math.round(afterVal),
      unit,
      delta,
      statusAr,
      note: 'lab'
    });
  };

  pushDelta('LCP', prevM.lcpMs, currM.lcpMs, 'ms', 0);
  pushDelta('CLS', prevM.cls, currM.cls, '', 3);
  pushDelta('TBT', prevM.tbtMs, currM.tbtMs, 'ms', 0);
  pushDelta('TTFB', prevM.ttfbMs, currM.ttfbMs, 'ms', 0);

  return {
    previousScanId: prev.scanId,
    previousScanDate: prev.finishedAt || prev.startedAt || (prev as any).timestamp || new Date().toISOString(),
    resolvedRuleIds,
    stillOpenRuleIds,
    newRuleIds,
    resolvedConfirmedCount,
    stillOpenConfirmedCount,
    allConfirmedResolved,
    metricDeltas
  };
}

export class PersistentStore {
  private storeFilePath: string;
  private data: PersistentStoreData = {
    quotas: {},
    reports: {},
    jobs: {},
    tombstones: {},
    feedback: [],
    reportFeedback: [],
    shares: {},
    activeMarkers: {},
    idempotencyKeys: {}
  };
  private ipBuckets = new Map<string, number[]>();
  private activeConcurrentScans = new Map<string, string>(); // scanId -> clientIp

  private lastWriteOk = true;
  private hasLoggedDiskError = false;
  private debounceSaveTimer: NodeJS.Timeout | null = null;
  private boundFlush: (() => void) | null = null;

  private static exitHooksRegistered = false;
  private static activeStores = new Set<PersistentStore>();
  private lastWriteTimeMs = 0;

  constructor(customStoreFilePath?: string) {
    this.storeFilePath = customStoreFilePath || STORE_FILE;
    for (const active of PersistentStore.activeStores) {
      if (active !== this && active.storeFilePath === this.storeFilePath) {
        try {
          active.flushSync();
        } catch {
          // ignore flush error
        }
      }
    }
    this.loadFromDisk();
    this.markUnfinishedJobsInterrupted();
    this.setupExitHooks();
  }

  private setupExitHooks(): void {
    PersistentStore.activeStores.add(this);
    if (!PersistentStore.exitHooksRegistered) {
      PersistentStore.exitHooksRegistered = true;
      const flushAll = () => {
        for (const s of PersistentStore.activeStores) {
          try {
            s.flushSync();
          } catch {
            // ignore exit flush errors
          }
        }
      };
      if (typeof process !== 'undefined' && typeof process.on === 'function') {
        process.once('SIGTERM', flushAll);
        process.once('SIGINT', flushAll);
        process.once('beforeExit', flushAll);
      }
    }
  }

  public getPersistenceStatus(): {
    adapter: 'file';
    mode: 'non-durable';
    durable: boolean;
    lastWriteOk: boolean;
    reason: string;
  } {
    return {
      adapter: 'file',
      mode: 'non-durable',
      durable: false,
      lastWriteOk: this.lastWriteOk,
      reason:
        'Local JSON FileStore (data/store.json); container ADC returns HTTP 403 PERMISSION_DENIED on cross-project Firestore with client rules deny-all.'
    };
  }

  public loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storeFilePath)) {
        const raw = fs.readFileSync(this.storeFilePath, 'utf-8');
        let parsed: any = null;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          const ts = Date.now();
          const base = path.basename(this.storeFilePath, '.json');
          const corruptFileName =
            base === 'store' || base === 'store.test'
              ? `store.corrupt.${ts}.json`
              : `${base}.store.corrupt.${ts}.json`;
          const corruptPath = path.join(path.dirname(this.storeFilePath), corruptFileName);
          try {
            fs.renameSync(this.storeFilePath, corruptPath);
            console.error(
              `[STORAGE] Corrupt store file detected and renamed to ${corruptPath}:`,
              parseErr
            );
          } catch (renameErr) {
            console.error('[STORAGE] Failed to rename corrupt store file:', renameErr);
          }
          parsed = null;
        }

        if (parsed && typeof parsed === 'object') {
          this.data = {
            quotas: parsed.quotas || {},
            reports: parsed.reports || {},
            jobs: parsed.jobs || {},
            tombstones: parsed.tombstones || {},
            feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
            reportFeedback: Array.isArray(parsed.reportFeedback) ? parsed.reportFeedback : [],
            shares: parsed.shares || {},
            activeMarkers: parsed.activeMarkers || {},
            idempotencyKeys: parsed.idempotencyKeys || {}
          };
        }
      }
    } catch {
      // start with clean in-memory state if store file read fails
    }
  }

  public flushToDisk(): void {
    this.flushSync();
  }

  public flushSync(): void {
    if (this.debounceSaveTimer) {
      clearTimeout(this.debounceSaveTimer);
      this.debounceSaveTimer = null;
    }
    try {
      const dir = path.dirname(this.storeFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = `${this.storeFilePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.data), 'utf-8');
      fs.renameSync(tmpFile, this.storeFilePath);
      this.lastWriteOk = true;
      this.lastWriteTimeMs = Date.now();
    } catch (err) {
      this.lastWriteOk = false;
      if (!this.hasLoggedDiskError) {
        console.error('[STORAGE] Disk write failure:', err);
        this.hasLoggedDiskError = true;
      }
    }
  }

  private saveToDisk(forceSync = false): void {
    if (forceSync) {
      this.flushSync();
      return;
    }
    const now = Date.now();
    const elapsed = now - this.lastWriteTimeMs;
    if (elapsed >= 1000 && !this.debounceSaveTimer) {
      this.flushSync();
      return;
    }
    if (!this.debounceSaveTimer) {
      const delay = Math.max(50, 1000 - elapsed);
      this.debounceSaveTimer = setTimeout(() => {
        this.debounceSaveTimer = null;
        this.flushSync();
      }, delay);
      if (this.debounceSaveTimer && typeof this.debounceSaveTimer.unref === 'function') {
        this.debounceSaveTimer.unref();
      }
    }
  }

  /**
   * Marks any 'queued' or 'running' job left over from a previous server process as 'interrupted'
   * and releases all uncommitted reservations.
   */
  public markUnfinishedJobsInterrupted(): number {
    const now = Date.now();
    let count = 0;
    for (const job of Object.values(this.data.jobs)) {
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'interrupted';
        job.errorMessage = 'الفحص اتقطع لما السيرفر عمل ريستارت. تقدر تعيد الفحص دلوقتي.';
        job.updatedAtMs = now;
        job.finishedAtMs = now;
        this.releaseReservation(job.scanId);
        count++;
      }
    }
    // Also clean up any orphaned reservations in quotas on startup
    for (const [key, q] of Object.entries(this.data.quotas)) {
      if (q.reservations && Object.keys(q.reservations).length > 0) {
        q.reservations = {};
        if (q.pagesCommitted <= 0) {
          delete this.data.quotas[key];
        }
        count++;
      }
    }
    if ( Object.keys(this.data.activeMarkers || {}).length > 0 ) {
      this.data.activeMarkers = {};
      count++;
    }
    this.activeConcurrentScans.clear();
    if (count > 0) {
      this.saveToDisk();
    }
    return count;
  }

  private releaseActiveMarkerForScan(scanId: string): boolean {
    if (!scanId || !this.data.activeMarkers) return false;
    let removed = false;
    for (const [mKey, marker] of Object.entries(this.data.activeMarkers)) {
      if (marker.scanId === scanId) {
        delete this.data.activeMarkers[mKey];
        removed = true;
      }
    }
    return removed;
  }

  public generateScanId(): string {
    return `scan_${crypto.randomBytes(16).toString('hex')}`;
  }

  /**
   * Unified per-IP hourly rate limiter for scan (20/h), chat (30/h), tts (20/h), transcribe (20/h), share (60/h).
   */
  public checkEndpointRateLimit(
    ip: string,
    bucket: RateLimitBucket,
    limitOverride?: number
  ): { allowed: boolean; remaining: number; limit: number; messageAr?: string } {
    const defaultLimits: Record<RateLimitBucket, number> = {
      scan: SCAN_LIMITS.MAX_SCAN_ATTEMPTS_PER_IP_PER_HOUR,
      chat: SCAN_LIMITS.MAX_CHAT_PER_IP_PER_HOUR,
      tts: SCAN_LIMITS.MAX_TTS_PER_IP_PER_HOUR,
      transcribe: SCAN_LIMITS.MAX_TRANSCRIBE_PER_IP_PER_HOUR,
      share: 60
    };
    const limit = limitOverride ?? defaultLimits[bucket];
    const key = `${bucket}:${ip || '127.0.0.1'}`;
    const now = Date.now();
    const hourAgo = now - 3600 * 1000;
    const recent = (this.ipBuckets.get(key) || []).filter(ts => ts > hourAgo);

    if (recent.length >= limit) {
      this.ipBuckets.set(key, recent);
      const labelAr =
        bucket === 'scan'
          ? 'محاولات الفحص'
          : bucket === 'chat'
            ? 'رسائل المحادثة'
            : bucket === 'tts'
              ? 'القراءة الصوتية'
              : bucket === 'transcribe'
                ? 'تسجيل الصوت'
                : 'فتح روابط المشاركة';
      return {
        allowed: false,
        remaining: 0,
        limit,
        messageAr: `وصلت للحد الأقصى لـ${labelAr} في الساعة (${limit} مرة). استنى شوية وجرب تاني.`
      };
    }

    const MAX_IP_BUCKETS = 2000;
    if (this.ipBuckets.size >= MAX_IP_BUCKETS) {
      for (const [k, timestamps] of this.ipBuckets.entries()) {
        const valid = timestamps.filter(ts => ts > hourAgo);
        if (valid.length === 0) {
          this.ipBuckets.delete(k);
        } else {
          this.ipBuckets.set(k, valid);
        }
      }
      if (this.ipBuckets.size >= MAX_IP_BUCKETS) {
        const excess = this.ipBuckets.size - Math.floor(MAX_IP_BUCKETS * 0.8);
        let removed = 0;
        for (const k of this.ipBuckets.keys()) {
          this.ipBuckets.delete(k);
          removed++;
          if (removed >= excess) break;
        }
      }
    }

    recent.push(now);
    this.ipBuckets.delete(key);
    this.ipBuckets.set(key, recent);
    return {
      allowed: true,
      remaining: Math.max(0, limit - recent.length),
      limit
    };
  }

  public checkIpRateLimit(ip: string): { allowed: boolean; messageAr?: string } {
    return this.checkEndpointRateLimit(ip, 'scan');
  }

  public acquireConcurrentScanSlot(
    scanId: string,
    ip: string,
    limitsOverride?: { maxGlobal?: number; maxPerIp?: number }
  ): { allowed: boolean; messageAr?: string } {
    const maxGlobal = limitsOverride?.maxGlobal ?? SCAN_LIMITS.MAX_CONCURRENT_SCANS_GLOBAL;
    const maxPerIp = limitsOverride?.maxPerIp ?? SCAN_LIMITS.MAX_CONCURRENT_SCANS_PER_IP;
    const cleanIp = ip || '127.0.0.1';

    if (this.activeConcurrentScans.size >= maxGlobal) {
      return {
        allowed: false,
        messageAr: 'السيرفر مشغول حالياً بالحد الأقصى للفحوصات المتزامنة. استنى ثواني وجرب تاني.'
      };
    }

    let ipActive = 0;
    for (const activeIp of this.activeConcurrentScans.values()) {
      if (activeIp === cleanIp) ipActive++;
    }
    if (ipActive >= maxPerIp) {
      return {
        allowed: false,
        messageAr: 'عندك فحص شغال بالفعل دلوقتي. استنى لما يخلص أو الغيه قبل ما تبدأ فحص جديد.'
      };
    }

    this.activeConcurrentScans.set(scanId, cleanIp);
    return { allowed: true };
  }

  public releaseConcurrentScanSlot(scanId: string): void {
    this.activeConcurrentScans.delete(scanId);
  }

  public cleanupExpired(now = Date.now()): void {
    let changed = false;
    for (const [key, q] of Object.entries(this.data.quotas)) {
      if (now >= q.expiresAtMs) {
        delete this.data.quotas[key];
        changed = true;
      }
    }
    for (const [sid, rep] of Object.entries(this.data.reports)) {
      if (now >= rep.expiresAtMs) {
        this.data.tombstones[sid] = {
          scanId: sid,
          visitorIdHash: rep.visitorIdHash,
          reason: 'expired',
          tombstonedAtMs: now
        };
        delete this.data.reports[sid];
        delete this.data.jobs[sid];
        changed = true;
      }
    }
    for (const [sid, job] of Object.entries(this.data.jobs)) {
      if (now >= job.expiresAtMs) {
        this.data.tombstones[sid] = {
          scanId: sid,
          visitorIdHash: job.visitorIdHash,
          reason: 'expired',
          tombstonedAtMs: now
        };
        delete this.data.jobs[sid];
        changed = true;
      }
    }
    for (const [tokenHash, share] of Object.entries(this.data.shares)) {
      if (now >= share.expiresAtMs + 14 * 24 * 3600 * 1000) {
        delete this.data.shares[tokenHash];
        changed = true;
      }
    }
    for (const [mKey, marker] of Object.entries(this.data.activeMarkers || {})) {
      const linkedJob = this.data.jobs[marker.scanId];
      const jobStillActive =
        linkedJob && (linkedJob.status === 'queued' || linkedJob.status === 'running');
      if (now >= marker.expiresAtMs || !jobStillActive) {
        delete this.data.activeMarkers[mKey];
        changed = true;
      }
    }
    for (const [idemKey, rec] of Object.entries(this.data.idempotencyKeys || {})) {
      if (now >= rec.expiresAtMs) {
        delete this.data.idempotencyKeys[idemKey];
        changed = true;
      }
    }
    if (changed) {
      this.saveToDisk();
    }
  }

  private getQuotaKey(
    visitorId: string,
    domainOrUrl: string
  ): { key: string; visitorHash: string; rootDomain: string } {
    const visitorHash = hashVisitorId(visitorId);
    const rootDomain = getRegistrableDomain(domainOrUrl);
    return {
      key: `${visitorHash}:${rootDomain}`,
      visitorHash,
      rootDomain
    };
  }

  /**
   * H3: Releases any uncommitted page reservation held by scanId.
   * Called from EVERY non-success path: failJob, cancelJob, interrupted, status-only, 0 pages, exception.
   */
  public releaseReservation(scanId: string): void {
    if (!scanId) return;
    let changed = this.releaseActiveMarkerForScan(scanId);
    for (const [key, entry] of Object.entries(this.data.quotas)) {
      let entryModified = false;
      if (entry.reservations && Object.prototype.hasOwnProperty.call(entry.reservations, scanId)) {
        delete entry.reservations[scanId];
        changed = true;
        entryModified = true;
      }
      if (
        entry.reviewReservations &&
        Object.prototype.hasOwnProperty.call(entry.reviewReservations, scanId)
      ) {
        delete entry.reviewReservations[scanId];
        changed = true;
        entryModified = true;
      }
      if (
        entryModified &&
        entry.pagesCommitted <= 0 &&
        (entry.reviewsCommitted || 0) <= 0 &&
        Object.keys(entry.reservations || {}).length === 0 &&
        Object.keys(entry.reviewReservations || {}).length === 0
      ) {
        delete this.data.quotas[key];
      }
    }
    if (changed) {
      this.saveToDisk();
    }
  }

  /**
   * H3 & B3.1: Commits pages and review count for a completed scan and clears its reservation.
   * If pages <= 0 and not same_pages rescan, releases the reservation without consuming quota.
   * In 'same_pages' mode, consumes 1 review and 0 page budget.
   */
  public commitScan(
    scanId: string,
    pages: number,
    inspectedUrls?: string[],
    options?: { rescanMode?: RescanMode; countReview?: boolean }
  ): void {
    if (!scanId) return;
    this.releaseActiveMarkerForScan(scanId);
    const existingJob = this.data.jobs[scanId];
    if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
      existingJob.status = 'completed';
      existingJob.updatedAtMs = Date.now();
      existingJob.finishedAtMs = Date.now();
    }
    const isSamePagesRescan = options?.rescanMode === 'same_pages';
    if ((!Number.isFinite(pages) || pages <= 0) && !isSamePagesRescan) {
      this.releaseReservation(scanId);
      return;
    }

    const now = Date.now();
    const maxPages = SCAN_LIMITS.MAX_PAGES_PER_SCAN || 10;
    const maxReviews = (SCAN_LIMITS as any).MAX_REVIEWS_PER_DOMAIN_PER_WINDOW || 3;
    let targetKey: string | null = null;
    let entry: VisitorDomainQuotaRecord | undefined;

    for (const [key, q] of Object.entries(this.data.quotas)) {
      if (
        (q.reservations && Object.prototype.hasOwnProperty.call(q.reservations, scanId)) ||
        (q.reviewReservations && Object.prototype.hasOwnProperty.call(q.reviewReservations, scanId))
      ) {
        targetKey = key;
        entry = q;
        break;
      }
    }

    if (!entry) {
      const job = this.data.jobs[scanId] || this.data.reports[scanId];
      if (!job || !job.registrableDomain || job.registrableDomain === 'localhost') {
        return;
      }
      targetKey = `${job.visitorIdHash}:${job.registrableDomain}`;
      entry = this.data.quotas[targetKey];
      if (!entry || now >= entry.expiresAtMs) {
        entry = {
          windowStartMs: now,
          expiresAtMs: now + SCAN_LIMITS.DOMAIN_LOCK_HOURS * 3600 * 1000,
          pagesCommitted: 0,
          reservations: {},
          committedUrls: [],
          reviewsCommitted: 0,
          reviewReservations: {},
          committedScanIds: []
        };
        this.data.quotas[targetKey] = entry;
      }
    }

    if (entry.reservations) delete entry.reservations[scanId];
    if (entry.reviewReservations) delete entry.reviewReservations[scanId];

    entry.committedScanIds = entry.committedScanIds || [];
    const alreadyCommitted = entry.committedScanIds.includes(scanId);
    if (!alreadyCommitted) {
      entry.committedScanIds.push(scanId);
      if (options?.countReview !== false) {
        entry.reviewsCommitted = Math.min(maxReviews, (entry.reviewsCommitted || 0) + 1);
      }
    }

    const rescanSameFree = SCAN_LIMITS.RESCAN_SAME_PAGES_FREE;
    let pagesToAdd = isSamePagesRescan ? 0 : Math.max(0, Math.round(pages));

    if (!isSamePagesRescan && Array.isArray(inspectedUrls) && inspectedUrls.length > 0) {
      entry.committedUrls = entry.committedUrls || [];
      const existingSet = new Set(entry.committedUrls);
      let newUniqueUrls = 0;
      for (const rawUrl of inspectedUrls) {
        if (!rawUrl) continue;
        const norm = rawUrl.trim().replace(/\/+$/, '');
        if (!existingSet.has(norm)) {
          existingSet.add(norm);
          entry.committedUrls.push(norm);
          newUniqueUrls++;
        }
      }
      if (rescanSameFree) {
        pagesToAdd = newUniqueUrls;
      }
    }

    entry.pagesCommitted = Math.min(maxPages, entry.pagesCommitted + pagesToAdd);
    if (
      targetKey &&
      entry.pagesCommitted <= 0 &&
      (entry.reviewsCommitted || 0) <= 0 &&
      Object.keys(entry.reservations || {}).length === 0 &&
      Object.keys(entry.reviewReservations || {}).length === 0
    ) {
      delete this.data.quotas[targetKey];
    }

    this.saveToDisk();
  }

  /**
   * H3 & B3.1: Returns the real quota status for THIS visitor and domain:
   * { domain, pagesUsed, pagesRemaining, maxPages, reviewsUsed, reviewsRemaining, maxReviews, resetAt, exhausted, remainingMinutes }
   */
  public getQuotaStatus(identity: VisitorIdentity, domainOrUrl?: string): QuotaStatus {
    const now = Date.now();
    this.cleanupExpired(now);
    const maxPages = SCAN_LIMITS.MAX_PAGES_PER_SCAN || 10;
    const maxReviews = (SCAN_LIMITS as any).MAX_REVIEWS_PER_DOMAIN_PER_WINDOW || 3;

    if (!domainOrUrl || !domainOrUrl.trim()) {
      return {
        domain: null,
        pagesUsed: 0,
        pagesRemaining: maxPages,
        maxPages,
        reviewsUsed: 0,
        reviewsRemaining: maxReviews,
        maxReviews,
        resetAt: null,
        exhausted: false,
        remainingMinutes: 0
      };
    }

    const { key, rootDomain } = this.getQuotaKey(identity.visitorId, domainOrUrl);
    if (!rootDomain || rootDomain === 'localhost') {
      return {
        domain: rootDomain || 'localhost',
        pagesUsed: 0,
        pagesRemaining: maxPages,
        maxPages,
        reviewsUsed: 0,
        reviewsRemaining: maxReviews,
        maxReviews,
        resetAt: null,
        exhausted: false,
        remainingMinutes: 0
      };
    }

    const entry = this.data.quotas[key];
    if (!entry || now >= entry.expiresAtMs) {
      return {
        domain: rootDomain,
        pagesUsed: 0,
        pagesRemaining: maxPages,
        maxPages,
        reviewsUsed: 0,
        reviewsRemaining: maxReviews,
        maxReviews,
        resetAt: null,
        exhausted: false,
        remainingMinutes: 0
      };
    }

    const reservedPages = Object.values(entry.reservations || {}).reduce(
      (sum, val) => sum + Math.max(0, Number(val) || 0),
      0
    );
    const reservedReviews = Object.values(entry.reviewReservations || {}).reduce(
      (sum, val) => sum + Math.max(0, Number(val) || 0),
      0
    );
    const pagesUsed = entry.pagesCommitted;
    const pagesRemaining = Math.max(0, maxPages - entry.pagesCommitted - reservedPages);
    const reviewsUsed = entry.reviewsCommitted || 0;
    const reviewsRemaining = Math.max(0, maxReviews - reviewsUsed - reservedReviews);
    const remainingMinutes = Math.max(1, Math.ceil((entry.expiresAtMs - now) / 60000));
    const hasActivity =
      entry.pagesCommitted > 0 ||
      reservedPages > 0 ||
      reviewsUsed > 0 ||
      reservedReviews > 0;

    return {
      domain: rootDomain,
      pagesUsed,
      pagesRemaining,
      maxPages,
      reviewsUsed,
      reviewsRemaining,
      maxReviews,
      resetAt: hasActivity ? new Date(entry.expiresAtMs).toISOString() : null,
      exhausted: pagesRemaining === 0 || reviewsRemaining === 0,
      remainingMinutes
    };
  }

  public formatRemainingArabic(remainingMinutes: number): string {
    const hours = Math.floor(remainingMinutes / 60);
    const mins = remainingMinutes % 60;
    if (hours > 0 && mins > 0) return `${hours} ساعة و${mins} دقيقة`;
    if (hours > 0) return `${hours} ساعة`;
    return `${mins} دقيقة`;
  }

  /**
   * Create and persist a scan job in 'queued' state.
   */
  public createJob(
    identity: VisitorIdentity,
    params: {
      scanId?: string;
      requestedUrl: string;
      normalizedUrl: string;
      registrableDomain: string;
      reserveLock?: boolean;
    }
  ): StoredJobRecord {
    const now = Date.now();
    this.cleanupExpired(now);
    const visitorIdHash = hashVisitorId(identity.visitorId);
    const scanId = params.scanId || this.generateScanId();
    const retentionMs = SCAN_LIMITS.REPORT_RETENTION_DAYS * 24 * 3600 * 1000;

    const job: StoredJobRecord = {
      scanId,
      visitorIdHash,
      requestedUrl: params.requestedUrl,
      normalizedUrl: params.normalizedUrl,
      registrableDomain: params.registrableDomain,
      status: 'queued',
      currentStage: 'url_check',
      stageStates: {
        url_check: 'pending',
        discovery: 'pending',
        interaction: 'pending',
        lighthouse: 'pending',
        report: 'pending'
      },
      stageDetail: 'في طابور الفحص...',
      inspectedPagesCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + retentionMs
    };

    this.data.jobs[scanId] = job;
    this.saveToDisk();
    return job;
  }

  /**
   * H3 & P2c.1: Synchronous check-and-set reserving min(10, remaining) pages for (visitor, rootDomain)
   * with Single-Flight Active Marker (`active_${visitorHash}_${domain}`):
   * - If an active ('queued' | 'running') job already exists for this (visitorHash, domain) and has not expired,
   *   returns the existing job with `reused: true` and consumes NO extra quota.
   * - Otherwise creates the job, stores the active marker with TTL = SCAN_TIMEOUT_S + 30s, and reserves quota.
   */
  public reserveScan(
    identity: VisitorIdentity,
    params: {
      scanId?: string;
      requestedUrl: string;
      normalizedUrl?: string;
      registrableDomain?: string;
      rescanMode?: RescanMode;
    }
  ): {
    allowed: boolean;
    reused: boolean;
    registrableDomain: string;
    maxPagesOverride: number;
    reasonAr?: string;
    quota: QuotaStatus;
    job?: StoredJobRecord;
  } {
    const now = Date.now();
    this.cleanupExpired(now);
    const normalizedUrl = params.normalizedUrl || params.requestedUrl;
    const registrableDomain =
      params.registrableDomain || getRegistrableDomain(normalizedUrl || params.requestedUrl);
    const maxPages = SCAN_LIMITS.MAX_PAGES_PER_SCAN || 10;
    const maxReviews = (SCAN_LIMITS as any).MAX_REVIEWS_PER_DOMAIN_PER_WINDOW || 3;
    const visitorHash = hashVisitorId(identity.visitorId);
    const cleanDomain = (registrableDomain || 'localhost').toLowerCase();
    const markerId = getActiveScanMarkerId(visitorHash, cleanDomain);
    const markerTtlMs = ((SCAN_LIMITS.SCAN_TIMEOUT_S || 90) + 30) * 1000;

    // P2c.1: Check deterministic active scan marker first
    const existingMarker = this.data.activeMarkers[markerId];
    if (existingMarker && now < existingMarker.expiresAtMs) {
      const existingJob = this.data.jobs[existingMarker.scanId];
      if (
        existingJob &&
        (existingJob.status === 'queued' || existingJob.status === 'running')
      ) {
        return {
          allowed: true,
          reused: true,
          registrableDomain: cleanDomain,
          maxPagesOverride: maxPages,
          quota: this.getQuotaStatus(identity, cleanDomain),
          job: existingJob
        };
      }
      delete this.data.activeMarkers[markerId];
    }

    if (!registrableDomain || registrableDomain === 'localhost') {
      const job = this.createJob(identity, {
        scanId: params.scanId,
        requestedUrl: params.requestedUrl,
        normalizedUrl,
        registrableDomain: registrableDomain || 'localhost'
      });
      this.data.activeMarkers[markerId] = {
        markerId,
        visitorIdHash: visitorHash,
        registrableDomain: cleanDomain,
        scanId: job.scanId,
        status: 'queued',
        createdAtMs: now,
        expiresAtMs: now + markerTtlMs
      };
      this.saveToDisk();
      return {
        allowed: true,
        reused: false,
        registrableDomain: registrableDomain || 'localhost',
        maxPagesOverride: maxPages,
        quota: this.getQuotaStatus(identity, registrableDomain || 'localhost'),
        job
      };
    }

    const { key } = this.getQuotaKey(identity.visitorId, registrableDomain);
    let entry = this.data.quotas[key];
    if (!entry || now >= entry.expiresAtMs) {
      entry = {
        windowStartMs: now,
        expiresAtMs: now + SCAN_LIMITS.DOMAIN_LOCK_HOURS * 3600 * 1000,
        pagesCommitted: 0,
        reservations: {},
        committedUrls: [],
        reviewsCommitted: 0,
        reviewReservations: {},
        committedScanIds: []
      };
      this.data.quotas[key] = entry;
    }
    entry.reviewReservations = entry.reviewReservations || {};

    const reservedPages = Object.values(entry.reservations || {}).reduce(
      (sum, val) => sum + Math.max(0, Number(val) || 0),
      0
    );
    const reservedReviews = Object.values(entry.reviewReservations || {}).reduce(
      (sum, val) => sum + Math.max(0, Number(val) || 0),
      0
    );
    const remaining = Math.max(0, maxPages - entry.pagesCommitted - reservedPages);
    const reviewsRemaining = Math.max(0, maxReviews - (entry.reviewsCommitted || 0) - reservedReviews);
    const rescanSameFree = SCAN_LIMITS.RESCAN_SAME_PAGES_FREE;
    const isSamePagesMode = params.rescanMode === 'same_pages';

    if (reviewsRemaining <= 0) {
      const remainingMinutes = Math.max(1, Math.ceil((entry.expiresAtMs - now) / 60000));
      const timeAr = this.formatRemainingArabic(remainingMinutes);
      return {
        allowed: false,
        reused: false,
        registrableDomain,
        maxPagesOverride: 0,
        reasonAr: `وصلت للحد الأقصى لمراجعات هذا الموقع (${maxReviews} مراجعات و${maxPages} صفحات كل ${SCAN_LIMITS.DOMAIN_LOCK_HOURS} ساعات). تقدر تراجع الموقع ده تاني بعد ${timeAr}، أو تفحص أي موقع تاني دلوقتي.`,
        quota: this.getQuotaStatus(identity, registrableDomain)
      };
    }

    if (
      !isSamePagesMode &&
      remaining <= 0 &&
      !(rescanSameFree && reservedPages === 0 && (entry.committedUrls?.length || 0) > 0)
    ) {
      const remainingMinutes = Math.max(1, Math.ceil((entry.expiresAtMs - now) / 60000));
      const timeAr = this.formatRemainingArabic(remainingMinutes);
      return {
        allowed: false,
        reused: false,
        registrableDomain,
        maxPagesOverride: 0,
        reasonAr: `لقد استنفدت الحد الأقصى لفحص هذا الموقع (${maxPages} صفحات) وبحد أقصى (${maxReviews} مراجعات). يمكنك فحص صفحات إضافية لنفس الموقع بعد ${timeAr}، أو يمكنك فحص أي موقع آخر بدومين مختلف الآن.`,
        quota: this.getQuotaStatus(identity, registrableDomain)
      };
    }

    const maxPagesOverride = isSamePagesMode
      ? maxPages
      : remaining > 0
        ? Math.min(maxPages, remaining)
        : maxPages;
    const job = this.createJob(identity, {
      scanId: params.scanId,
      requestedUrl: params.requestedUrl,
      normalizedUrl,
      registrableDomain
    });

    entry.reservations[job.scanId] = isSamePagesMode ? 0 : remaining > 0 ? maxPagesOverride : 0;
    entry.reviewReservations[job.scanId] = 1;
    this.data.activeMarkers[markerId] = {
      markerId,
      visitorIdHash: visitorHash,
      registrableDomain: cleanDomain,
      scanId: job.scanId,
      status: 'queued',
      createdAtMs: now,
      expiresAtMs: now + markerTtlMs
    };
    this.saveToDisk();

    return {
      allowed: true,
      reused: false,
      registrableDomain,
      maxPagesOverride,
      quota: this.getQuotaStatus(identity, registrableDomain),
      job
    };
  }

  /**
   * P2c.2: Looks up an existing scan job/report for a (visitor, Idempotency-Key) within the 10-minute window.
   */
  public getIdempotentScan(visitorId: string, idempotencyKey: string): StoredJobRecord | null {
    const cleanKey = (idempotencyKey || '').trim();
    if (!cleanKey) return null;
    const now = Date.now();
    this.cleanupExpired(now);
    const visitorIdHash = hashVisitorId(visitorId);
    const compositeKey = `${visitorIdHash}:${cleanKey}`;
    const rec = this.data.idempotencyKeys[compositeKey];
    if (!rec || now >= rec.expiresAtMs) {
      if (rec) delete this.data.idempotencyKeys[compositeKey];
      return null;
    }
    const statusLookup = this.getScanStatusForVisitor(rec.scanId, visitorId);
    if (statusLookup.httpStatus === 200 && statusLookup.scan) {
      return statusLookup.scan;
    }
    return null;
  }

  /**
   * P2c.2: Saves an Idempotency-Key mapping for 10 minutes for this visitor.
   */
  public saveIdempotencyRecord(visitorId: string, idempotencyKey: string, scanId: string): void {
    const cleanKey = (idempotencyKey || '').trim();
    if (!cleanKey || !scanId) return;
    const now = Date.now();
    const visitorIdHash = hashVisitorId(visitorId);
    const compositeKey = `${visitorIdHash}:${cleanKey}`;
    this.data.idempotencyKeys[compositeKey] = {
      key: cleanKey,
      visitorIdHash,
      scanId,
      createdAtMs: now,
      expiresAtMs: now + 10 * 60 * 1000
    };
    this.saveToDisk();
  }

  public updateJobProgress(
    scanId: string,
    patch: Partial<
      Pick<
        StoredJobRecord,
        | 'status'
        | 'currentStage'
        | 'stageStates'
        | 'stageDetail'
        | 'inspectedPagesCount'
        | 'errorMessage'
        | 'errorCode'
        | 'queuePosition'
        | 'result'
        | 'finishedAtMs'
      >
    >
  ): StoredJobRecord | null {
    const job = this.data.jobs[scanId];
    if (!job) return null;

    if (patch.status !== undefined) {
      job.status = patch.status;
      if (patch.status === 'running') {
        const mId = getActiveScanMarkerId(job.visitorIdHash, job.registrableDomain);
        if (this.data.activeMarkers[mId] && this.data.activeMarkers[mId].scanId === scanId) {
          this.data.activeMarkers[mId].status = 'running';
        }
      } else if (patch.status !== 'queued') {
        this.releaseActiveMarkerForScan(scanId);
      }
    }
    if (patch.currentStage !== undefined) job.currentStage = patch.currentStage;
    if (patch.stageStates !== undefined) {
      job.stageStates = { ...job.stageStates, ...patch.stageStates };
    }
    if (patch.stageDetail !== undefined) job.stageDetail = patch.stageDetail;
    if (patch.inspectedPagesCount !== undefined) {
      job.inspectedPagesCount = patch.inspectedPagesCount;
    }
    if (patch.errorMessage !== undefined) job.errorMessage = patch.errorMessage;
    if (patch.errorCode !== undefined) job.errorCode = patch.errorCode;
    if (patch.queuePosition !== undefined) job.queuePosition = patch.queuePosition;
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.finishedAtMs !== undefined) job.finishedAtMs = patch.finishedAtMs;
    job.updatedAtMs = Date.now();

    this.saveToDisk();
    return job;
  }

  public failJob(
    scanId: string,
    errorMessage: string,
    errorCode = 'internal'
  ): StoredJobRecord | null {
    const job = this.data.jobs[scanId];
    this.releaseConcurrentScanSlot(scanId);
    this.releaseReservation(scanId);
    if (!job) return null;

    const now = Date.now();
    job.status = 'failed';
    job.errorMessage = errorMessage;
    job.errorCode = errorCode;
    job.updatedAtMs = now;
    job.finishedAtMs = now;

    this.saveToDisk();
    return job;
  }

  public cancelJob(
    scanId: string,
    visitorId: string
  ): { ok: boolean; notFound?: boolean; gone?: boolean; status?: number; errorAr?: string; job?: StoredJobRecord } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);
    const tombstone = this.data.tombstones[scanId];
    if (tombstone && tombstone.visitorIdHash === visitorIdHash) {
      return {
        ok: false,
        gone: true,
        status: 410,
        errorAr:
          tombstone.reason === 'deleted'
            ? 'التقرير ده اتمسح خلاص.'
            : 'انتهت مدة الاحتفاظ بالتقرير ده.'
      };
    }
    const job = this.data.jobs[scanId];
    if (!job || job.visitorIdHash !== visitorIdHash) {
      return { ok: false, notFound: true, status: 404 };
    }

    this.releaseConcurrentScanSlot(scanId);
    this.releaseReservation(scanId);
    const now = Date.now();
    job.status = 'cancelled';
    job.errorMessage = 'تم إلغاء الفحص بناءً على طلبك.';
    job.updatedAtMs = now;
    job.finishedAtMs = now;

    this.saveToDisk();
    return { ok: true, job };
  }

  /**
   * Commits a completed scan report, commits or releases reservation based on status/pages,
   * updates the persisted job to completed/partial, and computes rescan comparison.
   */
  public saveScanReport(
    identity: VisitorIdentity,
    result: ScanResult,
    options?: { customExpiresAtMs?: number }
  ): ScanResult {
    const now = Date.now();
    this.cleanupExpired(now);
    this.releaseConcurrentScanSlot(result.scanId);

    const visitorIdHash = hashVisitorId(identity.visitorId);
    const domain = result.registrableDomain;
    const retentionMs = SCAN_LIMITS.REPORT_RETENTION_DAYS * 24 * 3600 * 1000;
    const expiresAtMs = options?.customExpiresAtMs ?? now + retentionMs;

    // B3.3: If deploymentFingerprint is unchanged and scan stopped early, release reservation and consume NO quota/review
    if (result.unchangedDeployment) {
      this.releaseReservation(result.scanId);
      const existingJob = this.data.jobs[result.scanId];
      this.data.jobs[result.scanId] = {
        scanId: result.scanId,
        visitorIdHash,
        requestedUrl: result.requestedUrl,
        normalizedUrl: result.finalUrl || result.requestedUrl,
        registrableDomain: domain,
        status: result.status || 'completed',
        currentStage: 'report',
        stageStates: {
          url_check: 'done',
          discovery: 'skipped',
          interaction: 'skipped',
          lighthouse: 'skipped',
          report: 'done'
        },
        inspectedPagesCount: 0,
        result,
        createdAtMs: existingJob?.createdAtMs ?? now,
        updatedAtMs: now,
        finishedAtMs: now,
        expiresAtMs
      };
      this.saveToDisk();
      return result;
    }

    const isStatusReportOnly = Boolean(result.siteStatus && result.siteStatus.state !== 'ok');

    const previousReport = this.getLatestReportForDomain(
      identity.visitorId,
      domain,
      result.scanId
    );
    const priorDomainReportsCount = Object.values(this.data.reports).filter(
      r => r.visitorIdHash === visitorIdHash && r.registrableDomain === domain && r.scanId !== result.scanId
    ).length;
    result.reviewNumber = result.reviewNumber || priorDomainReportsCount + 1;
    if (previousReport) {
      result.previousScanId = previousReport.scanId;
      if (!isStatusReportOnly) {
        result.rescanComparison = this.computeRescanDiff(previousReport.result, result);
      }
    }

    const pagesCount =
      result.uniquePagesInspected ??
      (Array.isArray(result.pages) ? result.pages.length : 0);

    const cappedResult = truncateReportEvidenceToCap(result);

    this.data.reports[result.scanId] = {
      scanId: result.scanId,
      visitorIdHash,
      registrableDomain: domain,
      createdAtMs: now,
      expiresAtMs,
      result: cappedResult
    };

    const existingJob = this.data.jobs[result.scanId];
    this.data.jobs[result.scanId] = {
      scanId: result.scanId,
      visitorIdHash,
      requestedUrl: result.requestedUrl,
      normalizedUrl: result.finalUrl || result.requestedUrl,
      registrableDomain: domain,
      status: result.status,
      currentStage: 'report',
      stageStates: {
        url_check: 'done',
        discovery: isStatusReportOnly ? 'skipped' : 'done',
        interaction: isStatusReportOnly ? 'skipped' : 'done',
        lighthouse: isStatusReportOnly ? 'skipped' : 'done',
        report: 'done'
      },
      inspectedPagesCount: pagesCount,
      result,
      createdAtMs: existingJob?.createdAtMs ?? now,
      updatedAtMs: now,
      finishedAtMs: now,
      expiresAtMs
    };

    if (isStatusReportOnly || (pagesCount <= 0 && result.rescanMode !== 'same_pages') || !domain || domain === 'localhost') {
      this.releaseReservation(result.scanId);
    } else {
      const inspectedUrls =
        Array.isArray(result.pages) && result.pages.length > 0
          ? result.pages.map(p => p.url).filter(Boolean)
          : [result.finalUrl || result.requestedUrl];
      this.commitScan(result.scanId, pagesCount, inspectedUrls, {
        rescanMode: result.rescanMode,
        countReview: true
      });
    }

    this.saveToDisk();
    return result;
  }

  public getLatestReportForVisitor(visitorId: string): StoredReportRecord | null {
    const visitorIdHash = hashVisitorId(visitorId);
    const candidates = Object.values(this.data.reports)
      .filter(r => r.visitorIdHash === visitorIdHash && (!r.result.siteStatus || r.result.siteStatus.state === 'ok'))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    return candidates[0] || null;
  }

  public getLatestReportForDomain(
    visitorId: string,
    domain: string,
    excludeScanId?: string
  ): StoredReportRecord | null {
    const visitorIdHash = hashVisitorId(visitorId);
    const candidates = Object.values(this.data.reports)
      .filter(
        r =>
          r.visitorIdHash === visitorIdHash &&
          r.registrableDomain === domain &&
          r.scanId !== excludeScanId &&
          (!r.result.siteStatus || r.result.siteStatus.state === 'ok')
      )
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    return candidates[0] || null;
  }

  public computeRescanDiff(prev: ScanResult, curr: ScanResult): RescanComparison {
    return computeRescanDiff(prev, curr);
  }

  public listVisitorReports(visitorId: string, limit = 20): VisitorReportSummary[] {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);

    const combinedMap = new Map<
      string,
      {
        scanId: string;
        registrableDomain: string;
        requestedUrl: string;
        status: ScanStatus;
        createdAtMs: number;
        updatedAtMs: number;
        finishedAtMs?: number;
        result?: ScanResult;
        inspectedPagesCount: number;
      }
    >();

    for (const job of Object.values(this.data.jobs)) {
      if (job.visitorIdHash !== visitorIdHash) continue;
      if (this.data.tombstones[job.scanId]) continue;
      combinedMap.set(job.scanId, {
        scanId: job.scanId,
        registrableDomain: job.registrableDomain || getRegistrableDomain(job.requestedUrl),
        requestedUrl: job.requestedUrl,
        status: job.status,
        createdAtMs: job.createdAtMs,
        updatedAtMs: job.updatedAtMs,
        finishedAtMs: job.finishedAtMs,
        result: job.result,
        inspectedPagesCount: job.inspectedPagesCount || 0
      });
    }

    for (const rep of Object.values(this.data.reports)) {
      if (rep.visitorIdHash !== visitorIdHash) continue;
      if (this.data.tombstones[rep.scanId]) continue;
      const existing = combinedMap.get(rep.scanId);
      combinedMap.set(rep.scanId, {
        scanId: rep.scanId,
        registrableDomain:
          rep.registrableDomain ||
          rep.result.registrableDomain ||
          getRegistrableDomain(rep.result.requestedUrl),
        requestedUrl: rep.result.requestedUrl,
        status: rep.result.status || existing?.status || 'completed',
        createdAtMs: existing?.createdAtMs ?? rep.createdAtMs,
        updatedAtMs: existing?.updatedAtMs ?? rep.createdAtMs,
        finishedAtMs: existing?.finishedAtMs ?? rep.createdAtMs,
        result: rep.result,
        inspectedPagesCount:
          rep.result.uniquePagesInspected ?? existing?.inspectedPagesCount ?? 0
      });
    }

    const byDomain = new Map<string, Array<typeof combinedMap extends Map<string, infer V> ? V : never>>();
    for (const entry of combinedMap.values()) {
      const dom = entry.registrableDomain || 'unknown';
      const arr = byDomain.get(dom) || [];
      arr.push(entry);
      byDomain.set(dom, arr);
    }

    const summaries: VisitorReportSummary[] = [];
    for (const [dom, entries] of byDomain.entries()) {
      entries.sort((a, b) => a.createdAtMs - b.createdAtMs || a.scanId.localeCompare(b.scanId));
      entries.forEach((entry, idx) => {
        const res = entry.result;
        const findings = Array.isArray(res?.findings) ? res!.findings : [];
        const confirmedCount = findings.filter(f => f.confidence === 'confirmed').length;
        const suspectedCount = findings.filter(f => f.confidence !== 'confirmed').length;
        const notMeasuredCount = Array.isArray(res?.notMeasured) ? res!.notMeasured.length : 0;
        const verdictAny = res?.verdict as any;
        summaries.push({
          scanId: entry.scanId,
          registrableDomain: dom,
          requestedUrl: entry.requestedUrl,
          status: entry.status,
          reviewNumber: res?.reviewNumber || idx + 1,
          createdAtMs: entry.createdAtMs,
          updatedAtMs: entry.updatedAtMs,
          finishedAtMs: entry.finishedAtMs,
          verdictLevel: verdictAny?.level,
          verdictLabelAr: verdictAny?.labelAr || verdictAny?.statusAr,
          verdictHeadlineAr: verdictAny?.headlineAr || verdictAny?.labelAr || verdictAny?.statusAr,
          confirmedCount,
          suspectedCount,
          notMeasuredCount,
          uniquePagesInspected: entry.inspectedPagesCount
        });
      });
    }

    summaries.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return summaries.slice(0, Math.max(1, Math.min(limit, 50)));
  }

  public getScanStatusForVisitor(
    scanId: string,
    visitorId: string
  ): {
    httpStatus: 200 | 404 | 410;
    scan?: StoredJobRecord;
    reason?: 'deleted' | 'expired' | 'not_found';
    errorAr?: string;
  } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);

    const tombstone = this.data.tombstones[scanId];
    if (tombstone) {
      if (tombstone.visitorIdHash !== visitorIdHash) {
        return {
          httpStatus: 404,
          reason: 'not_found',
          errorAr: 'لم يتم العثور على سجل الفحص المطلوب.'
        };
      }
      return {
        httpStatus: 410,
        reason: tombstone.reason,
        errorAr:
          tombstone.reason === 'deleted'
            ? 'التقرير ده اتمسح خلاص.'
            : 'انتهت مدة الاحتفاظ بالتقرير ده (30 يوم).'
      };
    }

    const job = this.data.jobs[scanId];
    if (job) {
      if (job.visitorIdHash !== visitorIdHash) {
        return {
          httpStatus: 404,
          reason: 'not_found',
          errorAr: 'لم يتم العثور على سجل الفحص المطلوب.'
        };
      }
      return {
        httpStatus: 200,
        scan: job
      };
    }

    const rep = this.data.reports[scanId];
    if (rep) {
      if (rep.visitorIdHash !== visitorIdHash) {
        return {
          httpStatus: 404,
          reason: 'not_found',
          errorAr: 'لم يتم العثور على سجل الفحص المطلوب.'
        };
      }
      return {
        httpStatus: 200,
        scan: {
          scanId,
          visitorIdHash,
          requestedUrl: rep.result.requestedUrl,
          normalizedUrl: rep.result.finalUrl || rep.result.requestedUrl,
          registrableDomain: rep.registrableDomain,
          status: rep.result.status,
          currentStage: 'report',
          stageStates: {
            url_check: 'done',
            discovery: 'done',
            interaction: 'done',
            lighthouse: 'done',
            report: 'done'
          },
          inspectedPagesCount: rep.result.uniquePagesInspected,
          result: rep.result,
          createdAtMs: rep.createdAtMs,
          updatedAtMs: rep.createdAtMs,
          finishedAtMs: rep.createdAtMs,
          expiresAtMs: rep.expiresAtMs
        }
      };
    }

    return {
      httpStatus: 404,
      reason: 'not_found',
      errorAr: 'لم يتم العثور على سجل الفحص المطلوب.'
    };
  }

  public getReportForVisitor(
    scanId: string,
    visitorId: string
  ): { found: boolean; forbidden?: boolean; gone?: boolean; result?: ScanResult } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);

    const tombstone = this.data.tombstones[scanId];
    if (tombstone && tombstone.visitorIdHash === visitorIdHash) {
      return { found: false, gone: true };
    }

    const record = this.data.reports[scanId];
    if (!record) {
      return { found: false };
    }
    if (record.visitorIdHash !== visitorIdHash) {
      return { found: false, forbidden: true };
    }
    return { found: true, result: record.result };
  }

  public deleteReportForVisitor(
    scanId: string,
    visitorId: string
  ): { deleted: boolean; forbidden?: boolean; gone?: boolean; status?: number; errorAr?: string } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);
    const tombstone = this.data.tombstones[scanId];
    if (tombstone && tombstone.visitorIdHash === visitorIdHash) {
      return {
        deleted: false,
        gone: true,
        status: 410,
        errorAr:
          tombstone.reason === 'deleted'
            ? 'التقرير ده اتمسح خلاص.'
            : 'انتهت مدة الاحتفاظ بالتقرير ده.'
      };
    }
    const rep = this.data.reports[scanId];
    const job = this.data.jobs[scanId];

    if (!rep && !job) return { deleted: false, status: 404 };
    const ownerHash = rep?.visitorIdHash || job?.visitorIdHash;
    if (ownerHash !== visitorIdHash) {
      return { deleted: false, forbidden: true, status: 404 };
    }

    this.releaseReservation(scanId);
    delete this.data.reports[scanId];
    delete this.data.jobs[scanId];
    this.data.tombstones[scanId] = {
      scanId,
      visitorIdHash,
      reason: 'deleted',
      tombstonedAtMs: Date.now()
    };
    this.saveToDisk();
    return { deleted: true };
  }

  /**
   * H4: Validated feedback recording:
   * - Scan must exist and belong to the visitor
   * - Finding must exist in that report
   * - Derives ruleId, rulesetVersion, and domain from the stored report
   * - Enforces one vote per (visitor, scan, finding)
   */
  public submitFeedback(params: {
    scanId: string;
    findingId: string;
    vote: 'up' | 'down';
    visitorId: string;
    fingerprint?: string;
  }): {
    ok: boolean;
    status: number;
    errorAr?: string;
    feedback?: FindingFeedbackRecord;
  } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(params.visitorId);
    const tombstone = this.data.tombstones[params.scanId];
    if (tombstone && tombstone.visitorIdHash === visitorIdHash) {
      return {
        ok: false,
        status: 410,
        errorAr:
          tombstone.reason === 'deleted'
            ? 'التقرير ده اتمسح خلاص.'
            : 'انتهت مدة الاحتفاظ بالتقرير ده.'
      };
    }
    const reportRecord = this.data.reports[params.scanId] || this.data.jobs[params.scanId];

    if (!reportRecord || reportRecord.visitorIdHash !== visitorIdHash || !reportRecord.result) {
      return {
        ok: false,
        status: 404,
        errorAr: 'لم يتم العثور على التقرير المطلوب لتسجيل التقييم.'
      };
    }

    const report = reportRecord.result;
    const matchedFinding = (report.findings || []).find(f => f.id === params.findingId);
    if (!matchedFinding) {
      return {
        ok: false,
        status: 400,
        errorAr: 'الملاحظة المطلوبة غير موجودة في هذا التقرير.'
      };
    }

    const derivedRuleId = matchedFinding.ruleId;
    const derivedRulesetVersion = report.rulesetVersion || SCAN_LIMITS.RULESET_VERSION;
    const derivedDomain = report.registrableDomain;
    const derivedPlatform = report.siteProfile?.platform;

    const rec: FindingFeedbackRecord = {
      id: `fb_${crypto.randomBytes(8).toString('hex')}`,
      scanId: params.scanId,
      findingId: params.findingId,
      ruleId: derivedRuleId,
      rulesetVersion: derivedRulesetVersion,
      vote: params.vote,
      reasons: Array.isArray((params as any).reasons) ? (params as any).reasons.slice(0, 10).map((r: string) => String(r).slice(0, 50)) : undefined,
      visitorIdHash,
      fingerprint: params.fingerprint || computeFindingFingerprint(matchedFinding),
      domain: derivedDomain,
      platform: derivedPlatform,
      createdAt: new Date().toISOString()
    };

    // Strictly one vote per (visitor, scan, finding)
    this.data.feedback = this.data.feedback.filter(
      f =>
        !(
          f.visitorIdHash === visitorIdHash &&
          f.scanId === params.scanId &&
          f.findingId === params.findingId
        )
    );
    this.data.feedback.push(rec);
    this.saveToDisk();

    return {
      ok: true,
      status: 200,
      feedback: rec
    };
  }

  public saveFindingFeedback(params: {
    scanId: string;
    findingId: string;
    vote: 'up' | 'down';
    reasons?: string[];
    visitorId: string;
    fingerprint?: string;
  }): {
    ok: boolean;
    status: number;
    errorAr?: string;
    feedback?: FindingFeedbackRecord;
  } {
    return this.submitFeedback(params as any);
  }

  public saveReportFeedback(params: {
    scanId: string;
    visitorId: string;
    stars: number;
    reasons?: string[];
    comment?: string;
  }): {
    ok: boolean;
    status: number;
    errorAr?: string;
    feedback?: ReportFeedbackRecord;
  } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(params.visitorId);

    const stars = Math.round(Number(params.stars));
    if (isNaN(stars) || stars < 1 || stars > 5) {
      return {
        ok: false,
        status: 400,
        errorAr: 'تقييم النجوم يجب أن يكون رقماً صحيحاً بين 1 و 5.'
      };
    }

    const reportRecord = this.data.reports[params.scanId] || this.data.jobs[params.scanId];
    if (!reportRecord || reportRecord.visitorIdHash !== visitorIdHash || !reportRecord.result) {
      return {
        ok: false,
        status: 404,
        errorAr: 'لم يتم العثور على التقرير المطلوب لتسجيل التقييم.'
      };
    }

    const rep = reportRecord.result;
    const sanitizedReasons = Array.isArray(params.reasons)
      ? params.reasons.slice(0, 10).map(r => String(r).trim().slice(0, 50)).filter(Boolean)
      : [];

    let commentRedacted: string | undefined = undefined;
    if (params.comment && typeof params.comment === 'string') {
      const cleanComment = params.comment.trim().slice(0, 300);
      if (cleanComment.length > 0) {
        commentRedacted = redactSharedText(cleanComment);
      }
    }

    const feedbackRecord: ReportFeedbackRecord = {
      id: `rfb_${crypto.randomBytes(8).toString('hex')}`,
      scanId: params.scanId,
      visitorIdHash,
      domain: reportRecord.registrableDomain || rep.registrableDomain || 'unknown',
      reviewNumber: rep.reviewNumber || 1,
      stars,
      reasons: sanitizedReasons,
      commentRedacted,
      platform: rep.siteProfile?.platform,
      builder: rep.siteProfile?.builder,
      verdict: rep.verdict?.labelAr || rep.summaryAr,
      appVersion: RELEASE_CONFIG.appVersion,
      rulesetVersion: rep.rulesetVersion || RELEASE_CONFIG.rulesetVersion,
      createdAt: new Date().toISOString()
    };

    if (!Array.isArray(this.data.reportFeedback)) {
      this.data.reportFeedback = [];
    }

    // Strictly one rating per (visitor, scan)
    this.data.reportFeedback = this.data.reportFeedback.filter(
      rf => !(rf.visitorIdHash === visitorIdHash && rf.scanId === params.scanId)
    );
    this.data.reportFeedback.push(feedbackRecord);
    this.saveToDisk();

    return {
      ok: true,
      status: 200,
      feedback: feedbackRecord
    };
  }

  public getAdminFeedbackOverview(): AdminFeedbackOverview {
    const reportList = this.data.reportFeedback || [];
    const totalReportRatings = reportList.length;
    const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let starsSum = 0;
    const reasonCounts: Record<string, number> = {};

    for (const rf of reportList) {
      if (rf.stars >= 1 && rf.stars <= 5) {
        ratingDistribution[rf.stars] = (ratingDistribution[rf.stars] || 0) + 1;
        starsSum += rf.stars;
      }
      if (Array.isArray(rf.reasons)) {
        for (const r of rf.reasons) {
          reasonCounts[r] = (reasonCounts[r] || 0) + 1;
        }
      }
    }

    const averageStars = totalReportRatings > 0 ? Number((starsSum / totalReportRatings).toFixed(2)) : 0;
    const topReasons = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const ruleMap: Record<
      string,
      {
        totalVotes: number;
        upVotes: number;
        downVotes: number;
        downVisitors: Set<string>;
      }
    > = {};

    for (const f of this.data.feedback) {
      if (!ruleMap[f.ruleId]) {
        ruleMap[f.ruleId] = {
          totalVotes: 0,
          upVotes: 0,
          downVotes: 0,
          downVisitors: new Set<string>()
        };
      }
      ruleMap[f.ruleId].totalVotes++;
      if (f.vote === 'up') {
        ruleMap[f.ruleId].upVotes++;
      } else {
        ruleMap[f.ruleId].downVotes++;
        ruleMap[f.ruleId].downVisitors.add(f.visitorIdHash);
      }
    }

    const ruleStats = Object.entries(ruleMap).map(([ruleId, stat]) => {
      const agreementRatio =
        stat.totalVotes >= 10
          ? Number((stat.upVotes / stat.totalVotes).toFixed(2))
          : 0;
      const flagged = stat.downVisitors.size >= 3;
      return {
        ruleId,
        totalVotes: stat.totalVotes,
        upVotes: stat.upVotes,
        downVotes: stat.downVotes,
        agreementRatio,
        flagged
      };
    });

    const recentComments = reportList
      .filter(rf => Boolean(rf.commentRedacted))
      .slice(-50)
      .reverse()
      .map(rf => ({
        scanId: rf.scanId,
        domain: rf.domain,
        stars: rf.stars,
        commentRedacted: rf.commentRedacted!,
        createdAt: rf.createdAt
      }));

    return {
      totalReportRatings,
      averageStars,
      ratingDistribution,
      topReasons,
      ruleStats,
      recentComments
    };
  }

  public recordFeedback(params: {
    scanId: string;
    findingId: string;
    ruleId?: string;
    rulesetVersion?: string;
    vote: 'up' | 'down';
    visitorId: string;
    fingerprint?: string;
    domain?: string;
  }): FindingFeedbackRecord | null {
    const res = this.submitFeedback({
      scanId: params.scanId,
      findingId: params.findingId,
      vote: params.vote,
      visitorId: params.visitorId,
      fingerprint: params.fingerprint
    });
    return res.feedback || null;
  }

  public getFeedbackStats(): Record<string, { up: number; down: number; precision: number }> {
    const stats: Record<string, { up: number; down: number; precision: number }> = {};
    for (const fb of this.data.feedback) {
      if (!stats[fb.ruleId]) {
        stats[fb.ruleId] = { up: 0, down: 0, precision: 1 };
      }
      if (fb.vote === 'up') stats[fb.ruleId].up++;
      else stats[fb.ruleId].down++;
      const total = stats[fb.ruleId].up + stats[fb.ruleId].down;
      stats[fb.ruleId].precision = Number((stats[fb.ruleId].up / total).toFixed(2));
    }
    return stats;
  }

  /**
   * H4: Generates a 128-bit share token, stores ONLY its SHA-256 hash on disk,
   * and assigns a dedicated shareId so the real scanId is never exposed.
   */
  public createShareToken(
    scanId: string,
    visitorId: string,
    customExpiresInMs?: number
  ): {
    ok: boolean;
    status: number;
    shareToken?: string;
    shareId?: string;
    shareUrl?: string;
    expiresAt?: string;
    expiresAtMs?: number;
    errorAr?: string;
  } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);

    const tombstone = this.data.tombstones[scanId];
    if (tombstone && tombstone.visitorIdHash === visitorIdHash) {
      return {
        ok: false,
        status: 410,
        errorAr:
          tombstone.reason === 'deleted'
            ? 'التقرير ده اتمسح خلاص.'
            : 'انتهت مدة الاحتفاظ بالتقرير ده.'
      };
    }

    const reportRecord = this.data.reports[scanId] || this.data.jobs[scanId];
    if (!reportRecord || reportRecord.visitorIdHash !== visitorIdHash) {
      return {
        ok: false,
        status: 404,
        errorAr: 'لم يتم العثور على سجل الفحص المطلوب.'
      };
    }

    if (!reportRecord.result) {
      return {
        ok: false,
        status: 400,
        errorAr: 'لا يمكن مشاركة فحص لم يكتمل بعد.'
      };
    }

    if (
      reportRecord.result.isHighProfileDomain ||
      isHighProfileDomain(
        reportRecord.result.registrableDomain || reportRecord.result.requestedUrl
      )
    ) {
      return {
        ok: false,
        status: 403,
        errorAr:
          reportRecord.result.highProfileNoticeAr ||
          HIGH_PROFILE_NOTICE_AR
      };
    }

    const rawToken = crypto.randomBytes(16).toString('hex');
    const tokenHash = hashShareToken(rawToken);
    const shareId = `share_${crypto.randomBytes(12).toString('hex')}`;
    const now = Date.now();
    const durationMs = customExpiresInMs ?? 7 * 24 * 3600 * 1000;
    const expiresAtMs = now + durationMs;

    this.data.shares[tokenHash] = {
      tokenHash,
      shareId,
      scanId,
      visitorIdHash,
      createdAtMs: now,
      expiresAtMs
    };
    this.saveToDisk();

    return {
      ok: true,
      status: 200,
      shareToken: rawToken,
      shareId,
      shareUrl: `/share/${rawToken}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs
    };
  }

  /**
   * H4: Revokes all share links for scanId if owned by visitorId.
   * Subsequent GET /api/share/:token returns 410 with code 'revoked'.
   */
  public revokeShareForScan(
    scanId: string,
    visitorId: string
  ): { ok: boolean; status: number; revokedCount?: number; errorAr?: string } {
    this.cleanupExpired();
    const visitorIdHash = hashVisitorId(visitorId);
    const tombstone = this.data.tombstones[scanId];
    if (tombstone && tombstone.visitorIdHash === visitorIdHash) {
      return {
        ok: false,
        status: 410,
        errorAr:
          tombstone.reason === 'deleted'
            ? 'التقرير ده اتمسح خلاص.'
            : 'انتهت مدة الاحتفاظ بالتقرير ده.'
      };
    }
    const reportRecord = this.data.reports[scanId] || this.data.jobs[scanId];

    if (!reportRecord || reportRecord.visitorIdHash !== visitorIdHash) {
      return {
        ok: false,
        status: 404,
        errorAr: 'لم يتم العثور على سجل الفحص المطلوب.'
      };
    }

    const now = Date.now();
    let revokedCount = 0;
    for (const share of Object.values(this.data.shares)) {
      if (share.scanId === scanId && !share.revokedAtMs) {
        share.revokedAtMs = now;
        revokedCount++;
      }
    }
    this.saveToDisk();

    return {
      ok: true,
      status: 200,
      revokedCount
    };
  }

  /**
   * H4: Retrieves a sanitized read-only allowlist DTO report for a valid share token.
   */
  public getSharedReport(rawToken: string): {
    ok: boolean;
    status: number;
    result?: ScanResult;
    expiresAtMs?: number;
    code?: string;
    errorAr?: string;
  } {
    this.cleanupExpired();
    if (!rawToken || typeof rawToken !== 'string') {
      return {
        ok: false,
        status: 404,
        errorAr: 'رابط المشاركة غير صالح أو غير موجود.'
      };
    }

    const tokenHash = hashShareToken(rawToken);
    const share = this.data.shares[tokenHash];
    if (!share) {
      return {
        ok: false,
        status: 404,
        errorAr: 'رابط المشاركة غير صالح أو غير موجود.'
      };
    }

    if (share.revokedAtMs) {
      return {
        ok: false,
        status: 410,
        code: 'revoked',
        errorAr: 'تم إلغاء رابط المشاركة لهذا التقرير من قبل صاحبه.'
      };
    }

    const now = Date.now();
    if (now >= share.expiresAtMs) {
      delete this.data.shares[tokenHash];
      this.saveToDisk();
      return {
        ok: false,
        status: 410,
        code: 'expired',
        errorAr: 'انتهت صلاحية رابط المشاركة (الروابط صالحة لمدة 7 أيام فقط).'
      };
    }

    const tombstone = this.data.tombstones[share.scanId];
    if (tombstone && tombstone.reason === 'deleted') {
      return {
        ok: false,
        status: 410,
        code: 'deleted',
        errorAr: 'تم مسح هذا التقرير من قبل صاحبه.'
      };
    }

    const record = this.data.reports[share.scanId] || this.data.jobs[share.scanId];
    if (!record || !record.result) {
      return {
        ok: false,
        status: 404,
        errorAr: 'التقرير المطلوب غير متاح حالياً.'
      };
    }

    const dto = buildSharedReportDto(record.result, share);

    return {
      ok: true,
      status: 200,
      result: dto,
      expiresAtMs: share.expiresAtMs
    };
  }

  public getRawStoreSnapshotForTest(): PersistentStoreData {
    return JSON.parse(JSON.stringify(this.data));
  }

  public resetForTesting(): void {
    this.data = {
      quotas: {},
      reports: {},
      jobs: {},
      tombstones: {},
      feedback: [],
      shares: {},
      activeMarkers: {},
      idempotencyKeys: {}
    };
    this.ipBuckets.clear();
    this.activeConcurrentScans.clear();
    this.saveToDisk();
  }
}

export const persistentStore = new PersistentStore();
