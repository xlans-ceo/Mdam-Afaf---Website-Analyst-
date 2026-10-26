/**
 * Store Interface & Core Persistence Types (PHASE P1.4)
 * Provides a uniform contract for FileStore and FirestoreStore adapters.
 */
import {
  Evidence,
  Finding,
  ScanResult,
  ScanStatus,
  Stage
} from '../types/contract';
import type { VisitorIdentity, QuotaStatus } from './storage';

export type { VisitorIdentity, QuotaStatus };

export interface PersistenceStatus {
  adapter: 'file' | 'firestore' | 'memory';
  mode: 'durable' | 'non-durable';
  durable: boolean;
  lastWriteOk: boolean;
  reason?: string;
  sparkQuotaDegraded?: boolean;
}

export type RateLimitBucket = 'scan' | 'chat' | 'tts' | 'transcribe' | 'share';

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  messageAr?: string;
}

export interface StoredJobRecord {
  scanId: string;
  schemaVersion?: number;
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
  expiresAt?: string; // ISO string for TTL policy
}

export interface StoredReportRecord {
  scanId: string;
  schemaVersion: number;
  visitorIdHash: string;
  registrableDomain: string;
  createdAtMs: number;
  expiresAtMs: number;
  expiresAt?: string; // ISO string for TTL policy
  result: ScanResult;
}

export interface VisitorDomainQuotaRecord {
  schemaVersion?: number;
  windowStartMs: number;
  expiresAtMs: number;
  expiresAt?: string;
  pagesCommitted: number;
  reservations: Record<string, number>;
  committedUrls?: string[];
}

export interface ShareRecord {
  schemaVersion?: number;
  tokenHash: string;
  shareId: string;
  scanId: string;
  visitorIdHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  expiresAt?: string;
  revokedAtMs?: number;
}

export interface ReportFeedbackRecord {
  schemaVersion?: number;
  id: string;
  scanId: string;
  visitorIdHash: string;
  domain: string;
  reviewNumber: number;
  stars: number;
  reasons: string[];
  commentRedacted?: string;
  platform?: string;
  builder?: string;
  verdict?: string;
  appVersion: string;
  rulesetVersion: string;
  createdAt: string;
  expiresAt?: string;
}

export interface FindingFeedbackRecord {
  schemaVersion?: number;
  id: string;
  scanId: string;
  findingId: string;
  ruleId: string;
  rulesetVersion: string;
  vote: 'up' | 'down';
  reasons?: string[];
  visitorIdHash: string;
  fingerprint?: string;
  domain?: string;
  platform?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AdminFeedbackOverview {
  totalReportRatings: number;
  averageStars: number;
  ratingDistribution: Record<number, number>;
  topReasons: Array<{ reason: string; count: number }>;
  ruleStats: Array<{
    ruleId: string;
    totalVotes: number;
    upVotes: number;
    downVotes: number;
    agreementRatio: number;
    flagged: boolean;
  }>;
  recentComments: Array<{
    scanId: string;
    domain: string;
    stars: number;
    commentRedacted: string;
    createdAt: string;
  }>;
}

export interface TombstoneRecord {
  schemaVersion?: number;
  scanId: string;
  visitorIdHash: string;
  reason: 'deleted' | 'expired';
  tombstonedAtMs: number;
  expiresAt?: string;
}

export interface ActiveScanMarkerRecord {
  markerId: string;
  visitorIdHash: string;
  registrableDomain: string;
  scanId: string;
  status: 'queued' | 'running';
  createdAtMs: number;
  expiresAtMs: number;
  expiresAt?: string;
}

export interface IdempotencyRecord {
  key: string;
  visitorIdHash: string;
  scanId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ReserveScanParams {
  scanId: string;
  requestedUrl: string;
  normalizedUrl: string;
  registrableDomain: string;
}

export interface ReserveScanResult {
  allowed: boolean;
  reused?: boolean;
  reasonAr?: string;
  pagesReserved: number;
  quota?: QuotaStatus;
}

export interface Store {
  getPersistenceStatus(): PersistenceStatus;
  
  // Jobs
  getScanStatusForVisitor(
    scanId: string,
    visitorId: string
  ): {
    httpStatus: number;
    scan?: StoredJobRecord;
    result?: ScanResult;
    code?: string;
    errorAr?: string;
    reason?: 'deleted' | 'expired' | 'not_found';
  };
  createJob(
    identity: VisitorIdentity,
    params: {
      scanId?: string;
      requestedUrl: string;
      normalizedUrl: string;
      registrableDomain: string;
      reserveLock?: boolean;
    }
  ): StoredJobRecord;
  updateJobProgress(
    scanId: string,
    updates: Partial<StoredJobRecord>
  ): StoredJobRecord | null;
  cancelJob(
    scanId: string,
    visitorId: string
  ): { ok: boolean; notFound?: boolean; gone?: boolean; status?: number; errorAr?: string; job?: StoredJobRecord };
  failJob(scanId: string, errorMessage: string, errorCode?: string): StoredJobRecord | null;
  
  // Reports
  saveScanReport(
    identity: VisitorIdentity,
    result: ScanResult,
    options?: { customExpiresAtMs?: number }
  ): ScanResult;
  listVisitorReports(visitorId: string, limit?: number): import('../types/contract').VisitorReportSummary[];
  deleteReportForVisitor(
    scanId: string,
    visitorId: string
  ): { deleted: boolean; forbidden?: boolean; gone?: boolean; status?: number; errorAr?: string };
  
  // Quotas & Reservations (with P2c.1 single-flight active marker)
  getQuotaStatus(identity: VisitorIdentity, domainOrUrl?: string): QuotaStatus;
  reserveScan(
    identity: VisitorIdentity,
    params: {
      scanId?: string;
      requestedUrl: string;
      normalizedUrl?: string;
      registrableDomain?: string;
      rescanMode?: import('../types/contract').RescanMode;
    }
  ): {
    allowed: boolean;
    reused: boolean;
    registrableDomain: string;
    maxPagesOverride: number;
    reasonAr?: string;
    quota: QuotaStatus;
    job?: StoredJobRecord;
  };
  commitScan(
    scanId: string,
    pages: number,
    inspectedUrls?: string[],
    options?: { rescanMode?: import('../types/contract').RescanMode; countReview?: boolean }
  ): void;
  releaseReservation(scanId: string): void;
  getIdempotentScan(visitorId: string, idempotencyKey: string): StoredJobRecord | null;
  saveIdempotencyRecord(visitorId: string, idempotencyKey: string, scanId: string): void;
  
  // Share links
  createShareToken(
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
  };
  revokeShareForScan(
    scanId: string,
    visitorId: string
  ): { ok: boolean; status: number; revokedCount?: number; errorAr?: string };
  getSharedReport(rawToken: string): {
    ok: boolean;
    status: number;
    result?: ScanResult;
    expiresAtMs?: number;
    code?: string;
    errorAr?: string;
  };
  
  // Feedback
  saveReportFeedback(params: {
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
  };
  saveFindingFeedback(params: {
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
  };
  getAdminFeedbackOverview(): AdminFeedbackOverview;
  submitFeedback(params: {
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
  };
  recordFeedback(params: {
    scanId: string;
    findingId: string;
    ruleId?: string;
    rulesetVersion?: string;
    vote: 'up' | 'down';
    visitorId: string;
    fingerprint?: string;
    domain?: string;
  }): FindingFeedbackRecord | null;
  
  // Concurrency & Rate Limiting
  acquireConcurrentScanSlot(
    scanId: string,
    ip: string,
    limitsOverride?: { maxGlobal?: number; maxPerIp?: number }
  ): { allowed: boolean; messageAr?: string };
  releaseConcurrentScanSlot(scanId: string): void;
  checkEndpointRateLimit(
    ip: string,
    bucket: RateLimitBucket,
    limitOverride?: number
  ): RateLimitCheckResult;
  
  generateScanId(): string;
  cleanupExpired(now?: number): void;
}

/**
 * P1.4: Caps serialized report size below 1 MiB (1,048,576 bytes).
 * Truncates evidence string values or trims excess evidence items if needed,
 * but NEVER removes or drops findings.
 */
export function truncateReportEvidenceToCap(result: ScanResult, maxBytes = 1024 * 1024): ScanResult {
  const jsonStr = JSON.stringify(result);
  if (jsonStr.length <= maxBytes) {
    return result;
  }

  // Clone so we don't mutate input
  const copy: ScanResult = JSON.parse(jsonStr);

  // Pass 1: truncate evidence values > 500 characters
  if (Array.isArray(copy.findings)) {
    for (const f of copy.findings) {
      if (Array.isArray(f.evidence)) {
        for (const ev of f.evidence) {
          if (ev.value && typeof ev.value === 'string' && ev.value.length > 500) {
            ev.value = `${ev.value.slice(0, 500)}... [مختصر لحجم التقرير]`;
          }
          if (ev.ref && typeof ev.ref === 'string' && ev.ref.length > 500) {
            ev.ref = `${ev.ref.slice(0, 500)}... [مختصر لحجم التقرير]`;
          }
        }
      }
    }
  }

  if (JSON.stringify(copy).length <= maxBytes) {
    return copy;
  }

  // Pass 2: limit evidence items to at most 3 per finding
  if (Array.isArray(copy.findings)) {
    for (const f of copy.findings) {
      if (Array.isArray(f.evidence) && f.evidence.length > 3) {
        f.evidence = f.evidence.slice(0, 3);
      }
    }
  }

  return copy;
}
