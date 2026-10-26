/**
 * PSI Result Cache (BATCH B1.3a)
 * Caches third-party PageSpeed Insights API measurements keyed by
 * url + strategy + deploymentFingerprint for up to 6 hours.
 * Re-scans bypass the cache; results are labeled "قياس جديد" or "من الكاش (منذ N دقيقة)".
 */
import { PsiMeasurement } from './honest-checks';

export interface CachedPsiEntry {
  url: string;
  strategy: 'mobile' | 'desktop';
  deploymentFingerprint: string;
  data: PsiMeasurement | null;
  cachedAtMs: number;
  expiresAtMs: number;
}

export const PSI_CACHE_TTL_MS = 6 * 3600 * 1000; // 6 hours

export class PsiCache {
  private cache = new Map<string, CachedPsiEntry>();

  public buildKey(
    url: string,
    strategy: 'mobile' | 'desktop' = 'mobile',
    deploymentFingerprint = ''
  ): string {
    const cleanUrl = url.trim().toLowerCase().replace(/\/+$/, '');
    const cleanFp = (deploymentFingerprint || '').trim();
    return `${strategy}:${cleanUrl}:${cleanFp}`;
  }

  public get(
    url: string,
    strategy: 'mobile' | 'desktop' = 'mobile',
    nowOrFingerprint: number | string = Date.now(),
    deploymentFingerprint = ''
  ): PsiMeasurement | null | undefined {
    const now = typeof nowOrFingerprint === 'number' ? nowOrFingerprint : Date.now();
    const fp =
      typeof nowOrFingerprint === 'string' ? nowOrFingerprint : deploymentFingerprint;
    const key = this.buildKey(url, strategy, fp);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (now >= entry.expiresAtMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data;
  }

  public getWithMeta(
    url: string,
    strategy: 'mobile' | 'desktop' = 'mobile',
    deploymentFingerprint = '',
    now = Date.now()
  ): { data: PsiMeasurement | null; ageMinutes: number; labelAr: string } | undefined {
    const key = this.buildKey(url, strategy, deploymentFingerprint);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (now >= entry.expiresAtMs) {
      this.cache.delete(key);
      return undefined;
    }

    const ageMinutes = Math.max(0, Math.floor((now - entry.cachedAtMs) / 60000));
    const labelAr = `من الكاش (منذ ${ageMinutes} دقيقة)`;
    return {
      data: entry.data
        ? {
            ...entry.data,
            fromCache: true,
            cacheAgeMinutes: ageMinutes,
            cacheLabelAr: labelAr,
          }
        : null,
      ageMinutes,
      labelAr,
    };
  }

  public set(
    url: string,
    data: PsiMeasurement | null,
    strategy: 'mobile' | 'desktop' = 'mobile',
    customTtlMsOrFingerprint: number | string = PSI_CACHE_TTL_MS,
    now = Date.now(),
    deploymentFingerprint = ''
  ): void {
    const customTtlMs =
      typeof customTtlMsOrFingerprint === 'number'
        ? customTtlMsOrFingerprint
        : PSI_CACHE_TTL_MS;
    const fp =
      typeof customTtlMsOrFingerprint === 'string'
        ? customTtlMsOrFingerprint
        : deploymentFingerprint;
    const key = this.buildKey(url, strategy, fp);
    this.cache.set(key, {
      url,
      strategy,
      deploymentFingerprint: fp,
      data,
      cachedAtMs: now,
      expiresAtMs: now + customTtlMs,
    });
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}

export const globalPsiCache = new PsiCache();

