import type { Finding } from '../types/contract';

/**
 * Browser-safe deterministic 96-bit hex hash (3x 32-bit FNV-1a lanes with distinct seeds).
 * Keeps src/lib/fingerprint.ts 100% free of Node-only modules so client bundle guard passes.
 */
function hashStringHex24(input: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b];
  const primes = [0x01000193, 0x01000193, 0xc2b2ae35];
  const out: string[] = [];

  for (let lane = 0; lane < 3; lane++) {
    let h = seeds[lane] >>> 0;
    const prime = primes[lane] >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i) + lane * 31;
      h = Math.imul(h, prime) >>> 0;
    }
    out.push(h.toString(16).padStart(8, '0'));
  }

  return out.join('');
}

/**
 * Deterministic fingerprint for deduplicating findings across pages
 * and comparing findings across rescans without collapsing distinct checks that share a ruleId.
 */
export function computeFindingFingerprint(f: Finding): string {
  if (f.ruleId === 'R013_PERF') {
    return 'R013_PERF::Mobile Performance';
  }
  const loc =
    f.location ||
    (f.ruleId === 'R001' || f.id?.startsWith('f_r010_js_secret') ? f.url : '');
  return `${f.ruleId}::${(f.title || '').trim()}::${(loc || '').trim()}`;
}

export interface DeploymentFingerprintInput {
  url: string;
  html: string;
  headers?: Headers | Record<string, string> | null;
}

/**
 * Computes a deterministic deployment fingerprint for a scanned site (B1.3a & B3.2):
 * Hash of:
 * 1) Normalized root HTML shell (strip nonces, CSRF tokens, inline timestamps)
 * 2) Sorted set of same-origin script/style/image asset URLs (capturing bundle hashes)
 * 3) ETag / Last-Modified response headers when present
 */
export function computeDeploymentFingerprint(input: DeploymentFingerprintInput): string {
  const { url, html, headers } = input;
  let origin = '';
  try {
    origin = new URL(url).origin.toLowerCase();
  } catch {
    origin = '';
  }

  const lowerHeaders: Record<string, string> = {};
  if (headers) {
    if (typeof (headers as Headers).forEach === 'function') {
      (headers as Headers).forEach((val, key) => {
        if (typeof val === 'string') {
          lowerHeaders[key.toLowerCase()] = val.trim();
        }
      });
    } else {
      for (const [k, v] of Object.entries(headers as Record<string, string>)) {
        if (typeof v === 'string') {
          lowerHeaders[k.toLowerCase()] = v.trim();
        }
      }
    }
  }

  const etag = lowerHeaders['etag'] || '';
  const lastModified = lowerHeaders['last-modified'] || '';

  const assetUrls = new Set<string>();
  const assetRegex = /<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = assetRegex.exec(html || '')) !== null) {
    const rawRef = match[1].trim();
    if (!rawRef || rawRef.startsWith('data:') || rawRef.startsWith('javascript:')) continue;
    try {
      const resolved = origin ? new URL(rawRef, origin) : new URL(rawRef, 'https://example.com');
      if (!origin || resolved.origin.toLowerCase() === origin) {
        assetUrls.add(`${resolved.pathname}${resolved.search}`);
      }
    } catch {
      assetUrls.add(rawRef);
    }
  }
  const sortedAssets = Array.from(assetUrls).sort().join('|');

  const normalizedShell = (html || '')
    .replace(/\bnonce=["'][^"']*["']/gi, 'nonce=""')
    .replace(/\bdata-(?:nonce|csrf|timestamp|build-time)=["'][^"']*["']/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const payload = `v1|etag:${etag}|lm:${lastModified}|assets:${sortedAssets}|shell:${normalizedShell}`;
  return hashStringHex24(payload);
}


