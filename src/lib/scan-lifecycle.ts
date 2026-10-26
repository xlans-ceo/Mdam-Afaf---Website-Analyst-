import { ScanResult, VerdictInfo } from '../types/contract';

export const ACTIVE_SCAN_SESSION_KEY = 'madam_afaf_active_scan';
export const RECENT_SCANS_STORAGE_KEY = 'madam_afaf_recent_scans';
export const MAX_RECENT_SCANS = 10;
export const MAX_CLIENT_POLL_DURATION_MS = 95_000;

export const ATTACHED_RUNNING_SCAN_MESSAGE_AR = 'الفحص شغال بالفعل، وصّلتك بيه';
export const ACTIVE_SCAN_ANNOUNCE_CHANNEL = 'madam_afaf_active_scan';

export function getScanBroadcastChannelName(scanId: string): string {
  return `madam_afaf_scan_${(scanId || '').trim()}`;
}

export function generateClientIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `idem_${crypto.randomUUID()}`;
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ActiveScanSession {
  scanId: string;
  requestedUrl: string;
  startedAt: string;
}

export interface RecentScanSummary {
  scanId: string;
  registrableDomain: string;
  requestedUrl: string;
  finalUrl?: string;
  startedAt: string;
  finishedAt?: string;
  uniquePagesInspected: number;
  findingsCount: number;
  verdict?: {
    level: VerdictInfo['level'];
    labelAr: string;
  };
}

/**
 * G5.3: Saves the active scan session so page refreshes or navigation restore polling.
 */
export function saveActiveScanSession(
  session: ActiveScanSession,
  storage?: StorageLike | null
): void {
  const target =
    storage !== undefined
      ? storage
      : typeof sessionStorage !== 'undefined'
      ? sessionStorage
      : null;
  if (!target) return;
  try {
    target.setItem(ACTIVE_SCAN_SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore storage errors
  }
}

/**
 * G5.3: Restores an active scan session if present and valid.
 */
export function loadActiveScanSession(
  storage?: StorageLike | null
): ActiveScanSession | null {
  const target =
    storage !== undefined
      ? storage
      : typeof sessionStorage !== 'undefined'
      ? sessionStorage
      : null;
  if (!target) return null;
  try {
    const raw = target.getItem(ACTIVE_SCAN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.scanId === 'string' &&
      parsed.scanId.length >= 12 &&
      typeof parsed.requestedUrl === 'string'
    ) {
      return {
        scanId: parsed.scanId,
        requestedUrl: parsed.requestedUrl,
        startedAt:
          typeof parsed.startedAt === 'string'
            ? parsed.startedAt
            : new Date().toISOString()
      };
    }
  } catch {
    // ignore corrupted session data
  }
  return null;
}

/**
 * G5.3: Clears the active scan session when a scan completes, fails, or is cancelled.
 */
export function clearActiveScanSession(storage?: StorageLike | null): void {
  const target =
    storage !== undefined
      ? storage
      : typeof sessionStorage !== 'undefined'
      ? sessionStorage
      : null;
  if (!target) return;
  try {
    target.removeItem(ACTIVE_SCAN_SESSION_KEY);
  } catch {
    // ignore
  }
}

/**
 * G5.4: Computes exponential backoff delay (ms) between client status polls.
 * Starts at baseMs (default 1000ms), grows by factor (1.35x) per poll attempt, capped at maxMs (4000ms).
 */
export function computePollBackoffMs(
  attempt: number,
  baseMs = 1000,
  factor = 1.35,
  maxMs = 4000
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const computed = Math.round(baseMs * Math.pow(factor, safeAttempt));
  return Math.min(maxMs, Math.max(baseMs, computed));
}

/**
 * G5.5: Converts a full ScanResult into a lightweight summary for localStorage,
 * stripping heavy arrays (findings, pages, evidence, repair prompts, etc.).
 */
export function toRecentScanSummary(result: ScanResult): RecentScanSummary {
  const findingsCount = Array.isArray(result.findings) ? result.findings.length : 0;
  const pagesCount =
    typeof result.uniquePagesInspected === 'number'
      ? result.uniquePagesInspected
      : Array.isArray(result.pages)
      ? result.pages.length
      : 1;

  return {
    scanId: result.scanId,
    registrableDomain: result.registrableDomain || result.finalUrl || result.requestedUrl,
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    startedAt: result.startedAt || new Date().toISOString(),
    finishedAt: result.finishedAt,
    uniquePagesInspected: pagesCount,
    findingsCount,
    verdict: result.verdict
      ? {
          level: result.verdict.level,
          labelAr: result.verdict.labelAr
        }
      : undefined
  };
}

/**
 * G5.5: Sanitizes stored entries in localStorage (migrating any legacy full ScanResult objects
 * to slim RecentScanSummary items).
 */
export function sanitizeStoredRecentScans(rawList: unknown): RecentScanSummary[] {
  if (!Array.isArray(rawList)) return [];
  const summaries: RecentScanSummary[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || typeof (item as any).scanId !== 'string') {
      continue;
    }
    const obj = item as any;
    const findingsCount =
      typeof obj.findingsCount === 'number'
        ? obj.findingsCount
        : Array.isArray(obj.findings)
        ? obj.findings.length
        : 0;
    const uniquePagesInspected =
      typeof obj.uniquePagesInspected === 'number'
        ? obj.uniquePagesInspected
        : Array.isArray(obj.pages)
        ? obj.pages.length
        : 1;

    summaries.push({
      scanId: obj.scanId,
      registrableDomain: obj.registrableDomain || obj.finalUrl || obj.requestedUrl || '',
      requestedUrl: obj.requestedUrl || obj.finalUrl || obj.registrableDomain || '',
      finalUrl: typeof obj.finalUrl === 'string' ? obj.finalUrl : undefined,
      startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : new Date().toISOString(),
      finishedAt: typeof obj.finishedAt === 'string' ? obj.finishedAt : undefined,
      uniquePagesInspected,
      findingsCount,
      verdict:
        obj.verdict && typeof obj.verdict.level === 'string'
          ? {
              level: obj.verdict.level,
              labelAr: String(obj.verdict.labelAr || '')
            }
          : undefined
    });
    if (summaries.length >= MAX_RECENT_SCANS) break;
  }
  return summaries;
}

export const FULL_SCANS_STORAGE_KEY = 'madam_afaf_full_scans';
export const MAX_FULL_SCANS = 5;

export function saveFullScanToStorage(
  result: ScanResult,
  storage?: StorageLike | null
): void {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
      ? localStorage
      : null;
  if (!target || !result || !result.scanId) return;
  try {
    const raw = target.getItem(FULL_SCANS_STORAGE_KEY);
    const list: ScanResult[] = raw ? JSON.parse(raw) : [];
    const validList = Array.isArray(list) ? list.filter(r => r && r.scanId && r.scanId !== result.scanId) : [];
    const updated = [result, ...validList].slice(0, MAX_FULL_SCANS);
    target.setItem(FULL_SCANS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage quota errors
  }
}

export function loadFullScanFromStorage(
  scanId: string,
  storage?: StorageLike | null
): ScanResult | null {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
      ? localStorage
      : null;
  if (!target || !scanId) return null;
  try {
    const raw = target.getItem(FULL_SCANS_STORAGE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    const found = list.find((r: any) => r && r.scanId === scanId);
    return found || null;
  } catch {
    return null;
  }
}

export function removeFullScanFromStorage(
  scanId: string,
  storage?: StorageLike | null
): void {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
      ? localStorage
      : null;
  if (!target || !scanId) return;
  try {
    const raw = target.getItem(FULL_SCANS_STORAGE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    const filtered = list.filter((r: any) => r && r.scanId !== scanId);
    target.setItem(FULL_SCANS_STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // ignore
  }
}

export function saveRecentScanSummaryToStorage(
  result: ScanResult,
  storage?: StorageLike | null
): RecentScanSummary[] {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
      ? localStorage
      : null;
  const summary = toRecentScanSummary(result);
  const existing = loadRecentScanSummariesFromStorage(target);
  const filtered = existing.filter(s => s.scanId !== summary.scanId);
  const updated = [summary, ...filtered].slice(0, MAX_RECENT_SCANS);
  if (target) {
    try {
      target.setItem(RECENT_SCANS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // ignore quota errors
    }
    saveFullScanToStorage(result, target);
  }
  return updated;
}

export function loadRecentScanSummariesFromStorage(
  storage?: StorageLike | null
): RecentScanSummary[] {
  const target =
    storage !== undefined
      ? storage
      : typeof localStorage !== 'undefined'
      ? localStorage
      : null;
  if (!target) return [];
  try {
    const raw = target.getItem(RECENT_SCANS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return sanitizeStoredRecentScans(parsed);
  } catch {
    return [];
  }
}

