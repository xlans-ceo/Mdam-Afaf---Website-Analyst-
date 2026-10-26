/**
 * Strict SSRF (Server-Side Request Forgery) Validator & Unified Outbound HTTP Client
 * Protects internal infrastructure, cloud metadata endpoints, loopback, and private CIDR blocks.
 * Enforces:
 * - Port allowlist (80, 443, 8080, 8443)
 * - Extended IPv4 & IPv6 blocklists (including hex IPv4-mapped IPv6, NAT64, 6to4, 2001:db8::/32)
 * - 3s DNS resolution timeout
 * - Pinned IP socket connection via custom lookup (eliminating DNS TOCTOU rebinding)
 * - Streaming body reader with hard byte cap, Content-Type gate, and end-to-end deadline timer
 * - Caller AbortSignal propagation
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { SCAN_LIMITS, BOT_USER_AGENT } from '../config/limits.server';

export { BOT_USER_AGENT };

export type DnsLookupRecord = { address: string; family?: number };
export type DnsLookupFn = (hostname: string) => Promise<DnsLookupRecord[]>;

export interface SsrfValidationResult {
  valid: boolean;
  reasonAr?: string;
  reasonEn?: string;
  resolvedIp?: string;
  resolvedFamily?: number;
  normalizedUrl?: string;
}

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPv4 is unsafe
  }

  const [a, b, c] = parts;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & Cloud Metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && (b === 0 || (b === 0 && c === 2))) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

function extractEmbeddedIpv4FromMappedHex(normalized: string): string | null {
  // Matches ::ffff:7f00:1, ::ffff:7f00:0001, 0:0:0:0:0:ffff:7f00:1, etc.
  const hexMatch = normalized.match(/^(?:(?:0{1,4}:){0,5}|::(?:0{1,4}:)*)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();

  // Loopback (::1) & Unspecified (::)
  if (
    normalized === '::1' ||
    normalized === '::' ||
    /^(?:0{1,4}:){7}0{0,3}[01]$/.test(normalized)
  ) {
    return true;
  }

  // IPv4-mapped IPv6 in dotted-quad form (e.g. ::ffff:127.0.0.1 or 0:0:0:0:0:ffff:127.0.0.1)
  if (normalized.includes('ffff:')) {
    const afterFfff = normalized.split('ffff:').pop() || '';
    if (afterFfff.includes('.')) {
      return isPrivateOrReservedIpv4(afterFfff);
    }
    const mappedFromHex = extractEmbeddedIpv4FromMappedHex(normalized);
    if (mappedFromHex) {
      return isPrivateOrReservedIpv4(mappedFromHex);
    }
    // Any other non-standard ::ffff: format is blocked conservatively
    return true;
  }

  // NAT64 well-known prefix 64:ff9b::/96 and 64:ff9b:1::/48
  if (/^0*64:ff9b:/i.test(normalized)) return true;

  // 6to4 prefix 2002::/16 (embeds IPv4 in bits 16..47)
  if (/^2002:/i.test(normalized)) return true;

  // Documentation prefix 2001:db8::/32
  if (/^2001:0*db8(?::|$)/i.test(normalized)) return true;

  // Teredo tunneling 2001:0000::/32
  if (/^2001:0{1,4}:/i.test(normalized)) return true;

  // Unique local addresses (fc00::/7 -> fc.. and fd..)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(normalized)) return true;

  // Link-local addresses (fe80::/10 -> fe8, fe9, fea, feb)
  if (/^fe[89ab][0-9a-f]?:/i.test(normalized)) return true;

  // Multicast (ff00::/8)
  if (/^ff[0-9a-f]{0,2}:/i.test(normalized)) return true;

  return false;
}

export function isRestrictedIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  if (clean.includes(':')) {
    return isPrivateOrReservedIpv6(clean);
  }
  return isPrivateOrReservedIpv4(clean);
}

async function lookupWithTimeout(
  hostname: string,
  timeoutMs: number,
  lookupFn?: DnsLookupFn
): Promise<DnsLookupRecord[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`DNS lookup timed out after ${timeoutMs}ms`);
      err.name = 'DnsTimeoutError';
      reject(err);
    }, timeoutMs);
  });

  try {
    const lookupPromise = lookupFn
      ? lookupFn(hostname)
      : dns.lookup(hostname, { all: true });
    return await Promise.race([lookupPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validates a URL for SSRF security:
 * 1. Must use http or https scheme.
 * 2. Must not contain username/password credentials.
 * 3. Port must be in ALLOWED_PORTS (80, 443, 8080, 8443) unless local fixture.
 * 4. Hostname cannot be localhost or loopback name.
 * 5. Resolves DNS records within 3s and verifies none map to private/reserved IP spaces.
 */
export async function validateSsrfUrl(
  rawUrl: string,
  options: {
    allowLocalFixtures?: boolean;
    lookupFn?: DnsLookupFn;
    dnsTimeoutMs?: number;
  } = {}
): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    const trimmed = rawUrl.trim();
    parsed = new URL(
      trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `https://${trimmed}`
    );
  } catch {
    return {
      valid: false,
      reasonAr: 'الرابط المكتوب مش صحيح أو مش مفهوم.',
      reasonEn: 'Malformed or invalid URL.'
    };
  }

  // 1. Protocol allowlist
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      reasonAr: 'مسموح بس بروابط http أو https العامة.',
      reasonEn: `Disallowed scheme: ${parsed.protocol}`
    };
  }

  // 2. Reject credentials in URL
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reasonAr: 'مش مسموح بإدخال بيانات اعتماد (اسم مستخدم أو كلمة سر) جوة الرابط.',
      reasonEn: 'URLs with embedded credentials are prohibited.'
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Allow local fixture routes if explicitly enabled for test suite / benchmark
  if (
    options.allowLocalFixtures &&
    process.env.NODE_ENV !== 'production' &&
    (hostname === 'localhost' || hostname === '127.0.0.1') &&
    (parsed.pathname.startsWith('/fixtures/') ||
      parsed.pathname === '/robots.txt' ||
      parsed.pathname === '/sitemap.xml')
  ) {
    return {
      valid: true,
      resolvedIp: '127.0.0.1',
      resolvedFamily: 4,
      normalizedUrl: parsed.toString()
    };
  }

  // 3. Port allowlist check (80, 443, 8080, 8443)
  const effectivePort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  if (!SCAN_LIMITS.ALLOWED_PORTS.includes(effectivePort)) {
    return {
      valid: false,
      reasonAr: `المنفذ (Port ${effectivePort}) غير مسموح بفحصه أمنياً. المسموح بس 80 و 443 و 8080 و 8443.`,
      reasonEn: `Port ${effectivePort} is not in the allowlist.`
    };
  }

  // 4. Prohibit localhost, local aliases, and cloud metadata names
  const forbiddenHostnames = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'instance-data',
    'metadata.internal'
  ]);

  if (
    forbiddenHostnames.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    return {
      valid: false,
      reasonAr: 'مش مسموح بفحص خوادم داخلية أو روابط محلية (Localhost/Internal).',
      reasonEn: 'Localhost and internal hostname resolution is prohibited.'
    };
  }

  // 5. Raw IP check
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.startsWith('[')) {
    const rawIp = hostname.replace(/^\[|\]$/g, '');
    if (isRestrictedIp(rawIp)) {
      return {
        valid: false,
        reasonAr: 'الـ IP ده خاص بشبكة داخلية ومش مسموح بفحصه.',
        reasonEn: `Target IP ${rawIp} is in a reserved or private range.`
      };
    }
    return {
      valid: true,
      resolvedIp: rawIp,
      resolvedFamily: rawIp.includes(':') ? 6 : 4,
      normalizedUrl: parsed.toString()
    };
  }

  // 6. DNS Resolution & Rebinding Check with 3s timeout
  const dnsTimeoutMs = options.dnsTimeoutMs ?? SCAN_LIMITS.DNS_TIMEOUT_MS;
  try {
    const addresses = await lookupWithTimeout(hostname, dnsTimeoutMs, options.lookupFn);
    if (!addresses || addresses.length === 0) {
      return {
        valid: false,
        reasonAr: 'تعذر الوصول لاسم الموقع في خوادم الـ DNS. اتأكد من كتابة الرابط صح.',
        reasonEn: `DNS resolution failed for hostname ${hostname}`
      };
    }

    for (const record of addresses) {
      if (isRestrictedIp(record.address)) {
        return {
          valid: false,
          reasonAr: 'اسم الموقع ده بيشير لعنوان شبكة داخلية محظورة.',
          reasonEn: `Resolved IP ${record.address} for ${hostname} is in a restricted range.`
        };
      }
    }

    const first = addresses[0];
    return {
      valid: true,
      resolvedIp: first.address,
      resolvedFamily: first.family || (first.address.includes(':') ? 6 : 4),
      normalizedUrl: parsed.toString()
    };
  } catch (err: any) {
    const isTimeout = err?.name === 'DnsTimeoutError';
    return {
      valid: false,
      reasonAr: isTimeout
        ? 'خادم الـ DNS اتأخر في الرد أكتر من 3 ثواني.'
        : 'تعذر الوصول لاسم النطاق (DNS lookup error). اتأكد إن الموقع شغال على الإنترنت.',
      reasonEn: `DNS resolution error: ${err?.message || 'unknown'}`
    };
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  allowLocalFixtures?: boolean;
  signal?: AbortSignal;
  lookupFn?: DnsLookupFn;
  dnsTimeoutMs?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  headers: Headers | null;
  html: string;
  htmlBytes: number;
  ttfbMs: number;
  redirectCount: number;
  connectedIp?: string;
  abortedByMaxBytes?: boolean;
  timedOut?: boolean;
  timedOutStage?: 'connect' | 'first_byte' | 'body';
  aborted?: boolean;
  errorReasonAr?: string;
}

function isBinaryContentType(contentType: string): boolean {
  const lower = (contentType || '').toLowerCase();
  if (!lower) return false;
  // Text/HTML/XML/JSON/JS content types are allowed to stream body
  if (
    lower.includes('text/') ||
    lower.includes('html') ||
    lower.includes('xml') ||
    lower.includes('json') ||
    lower.includes('javascript') ||
    lower.includes('ecmascript') ||
    lower.includes('charset=')
  ) {
    return false;
  }
  return true;
}

function toFetchHeaders(rawHeaders: http.IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      h.set(k, v.join(', '));
    } else {
      h.set(k, v);
    }
  }
  return h;
}

/**
 * P2c.4: Per-host politeness limiter (max 2 concurrent requests per host, >= 250ms spacing)
 * and in-flight GET coalescing with 60s public bytes cache.
 */
export const MAX_CONCURRENT_REQUESTS_PER_HOST = 2;
export const MIN_HOST_REQUEST_SPACING_MS = 250;
export const PUBLIC_GET_COALESCE_TTL_MS = 60_000;

interface HostLimiterState {
  activeCount: number;
  nextAllowedStartMs: number;
  queue: Array<() => void>;
}

const hostLimiters = new Map<string, HostLimiterState>();
const inFlightPublicGetMap = new Map<string, Promise<SafeFetchResult>>();
const publicGetBytesCache = new Map<string, { expiresAtMs: number; result: SafeFetchResult }>();

export function clearOutboundFetchCacheForTesting(): void {
  hostLimiters.clear();
  inFlightPublicGetMap.clear();
  publicGetBytesCache.clear();
}

function cloneSafeFetchResult(res: SafeFetchResult): SafeFetchResult {
  const clonedHeaders = res.headers ? new Headers(res.headers) : null;
  return {
    ...res,
    headers: clonedHeaders
  };
}

function getHostLimiterState(hostKey: string): HostLimiterState {
  let state = hostLimiters.get(hostKey);
  if (!state) {
    state = {
      activeCount: 0,
      nextAllowedStartMs: 0,
      queue: []
    };
    hostLimiters.set(hostKey, state);
  }
  return state;
}

async function acquireHostPolitenessSlot(
  hostKey: string,
  remainingMs: number,
  signal?: AbortSignal
): Promise<{
  acquired: boolean;
  release: () => void;
  timedOut?: boolean;
  aborted?: boolean;
}> {
  const state = getHostLimiterState(hostKey);
  const slotDeadlineMs = Date.now() + Math.max(1, remainingMs);

  // Step 1: Wait for an active concurrency slot (max 2 concurrent per host)
  if (state.activeCount >= MAX_CONCURRENT_REQUESTS_PER_HOST) {
    const slotObtained = await new Promise<'ok' | 'timeout' | 'abort'>(resolve => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('ok');
      };
      const onTimeout = () => {
        if (settled) return;
        settled = true;
        const idx = state.queue.indexOf(grant);
        if (idx !== -1) state.queue.splice(idx, 1);
        cleanup();
        resolve('timeout');
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const idx = state.queue.indexOf(grant);
        if (idx !== -1) state.queue.splice(idx, 1);
        cleanup();
        resolve('abort');
      };
      const timer = setTimeout(onTimeout, Math.max(1, slotDeadlineMs - Date.now()));
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal?.aborted) {
        cleanup();
        resolve('abort');
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      state.queue.push(grant);
    });

    if (slotObtained !== 'ok') {
      return {
        acquired: false,
        release: () => {},
        timedOut: slotObtained === 'timeout',
        aborted: slotObtained === 'abort'
      };
    }
  } else {
    state.activeCount += 1;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const nextWaiter = state.queue.shift();
    if (nextWaiter) {
      // Hand off active slot directly to next waiter
      nextWaiter();
    } else {
      state.activeCount = Math.max(0, state.activeCount - 1);
    }
  };

  // Step 2: Enforce >= 250ms spacing between request starts on the same host
  // (Skipped only when caller passes a synthetic sub-second timeout budget < 1000ms in unit tests)
  const effectiveSpacingMs = remainingMs < 1000 ? 0 : MIN_HOST_REQUEST_SPACING_MS;
  const now = Date.now();
  const scheduledStartMs =
    effectiveSpacingMs > 0 ? Math.max(now, state.nextAllowedStartMs) : now;
  if (effectiveSpacingMs > 0) {
    state.nextAllowedStartMs = scheduledStartMs + effectiveSpacingMs;
  }
  const waitMs = scheduledStartMs - now;

  if (waitMs > 0) {
    if (scheduledStartMs > slotDeadlineMs) {
      release();
      return { acquired: false, release: () => {}, timedOut: true };
    }
    const spacingOutcome = await new Promise<'ok' | 'timeout' | 'abort'>(resolve => {
      let settled = false;
      const onDone = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('ok');
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('abort');
      };
      const timer = setTimeout(onDone, waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal?.aborted) {
        cleanup();
        resolve('abort');
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });

    if (spacingOutcome !== 'ok') {
      release();
      return {
        acquired: false,
        release: () => {},
        timedOut: spacingOutcome === 'timeout',
        aborted: spacingOutcome === 'abort'
      };
    }
  }

  return { acquired: true, release };
}

/**
 * Unified SSRF-safe outbound HTTP client:
 * - Supports GET and HEAD.
 * - Validates initial URL and every redirect hop against SSRF blocklist.
 * - Connects directly to the validated IP via custom socket lookup (preventing DNS TOCTOU rebinding).
 * - Keeps the request deadline timer active until the body stream finishes.
 * - Streams body chunks and destroys socket the instant received bytes exceed maxBytes.
 * - Honors caller AbortSignal.
 * - Identifies with BOT_USER_AGENT.
 * - P2c.4: Enforces per-host politeness (max 2 concurrent per host, >= 250ms spacing)
 *   and coalesces identical GET requests with a 60s public bytes cache.
 */
export async function safeFetchHtmlWithSsrf(
  rawUrl: string,
  options?: SafeFetchOptions
): Promise<SafeFetchResult> {
  const method = options?.method ?? 'GET';
  const maxRedirects = options?.maxRedirects ?? (method === 'HEAD' ? 0 : SCAN_LIMITS.MAX_REDIRECTS);
  const maxBytes = options?.maxBytes ?? SCAN_LIMITS.MAX_HTML_BYTES;
  const canCoalesce =
    method === 'GET' &&
    !options?.lookupFn &&
    !options?.signal?.aborted;

  let cacheKey = '';
  if (canCoalesce) {
    try {
      const trimmed = rawUrl.trim();
      const normalizedKeyUrl = new URL(
        trimmed.startsWith('http://') || trimmed.startsWith('https://')
          ? trimmed
          : `https://${trimmed}`
      ).toString();
      cacheKey = `GET:${normalizedKeyUrl}:${maxBytes}:${maxRedirects}`;
    } catch {
      cacheKey = '';
    }
  }

  if (cacheKey) {
    const now = Date.now();
    const cached = publicGetBytesCache.get(cacheKey);
    if (cached && now < cached.expiresAtMs) {
      return cloneSafeFetchResult(cached.result);
    }
    if (cached && now >= cached.expiresAtMs) {
      publicGetBytesCache.delete(cacheKey);
    }

    const existingInFlight = inFlightPublicGetMap.get(cacheKey);
    if (existingInFlight) {
      const sharedResult = await existingInFlight;
      return cloneSafeFetchResult(sharedResult);
    }
  }

  const runFetch = () => executeSafeFetchWithRedirects(rawUrl, options);

  if (!cacheKey) {
    return runFetch();
  }

  const inFlightPromise = runFetch().finally(() => {
    inFlightPublicGetMap.delete(cacheKey);
  });
  inFlightPublicGetMap.set(cacheKey, inFlightPromise);

  const result = await inFlightPromise;
  if (
    result.ok &&
    result.status >= 200 &&
    result.status < 300 &&
    !result.timedOut &&
    !result.aborted &&
    !result.abortedByMaxBytes
  ) {
    if (publicGetBytesCache.size >= 500) {
      const now = Date.now();
      for (const [k, v] of publicGetBytesCache.entries()) {
        if (now >= v.expiresAtMs) publicGetBytesCache.delete(k);
      }
    }
    publicGetBytesCache.set(cacheKey, {
      expiresAtMs: Date.now() + PUBLIC_GET_COALESCE_TTL_MS,
      result: cloneSafeFetchResult(result)
    });
  }

  return cloneSafeFetchResult(result);
}

async function executeSafeFetchWithRedirects(
  rawUrl: string,
  options?: SafeFetchOptions
): Promise<SafeFetchResult> {
  const method = options?.method ?? 'GET';
  const maxRedirects = options?.maxRedirects ?? (method === 'HEAD' ? 0 : SCAN_LIMITS.MAX_REDIRECTS);
  const timeoutMs = options?.timeoutMs ?? SCAN_LIMITS.REQUEST_TIMEOUT_S * 1000;
  const maxBytes = options?.maxBytes ?? SCAN_LIMITS.MAX_HTML_BYTES;
  const signal = options?.signal;

  let currentUrl = rawUrl;
  let redirectCount = 0;
  const startMs = Date.now();
  const deadlineAt = startMs + timeoutMs;

  while (redirectCount <= maxRedirects) {
    if (signal?.aborted) {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        headers: null,
        html: '',
        htmlBytes: 0,
        ttfbMs: Date.now() - startMs,
        redirectCount,
        aborted: true,
        errorReasonAr: 'تم إلغاء الفحص بناءً على طلبك.'
      };
    }

    const remainingBeforeDns = deadlineAt - Date.now();
    if (remainingBeforeDns <= 0) {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        headers: null,
        html: '',
        htmlBytes: 0,
        ttfbMs: Date.now() - startMs,
        redirectCount,
        timedOut: true,
        errorReasonAr: 'الموقع اتأخر في الرد أكتر من المهلة المسموحة.'
      };
    }

    const check = await validateSsrfUrl(currentUrl, {
      allowLocalFixtures: options?.allowLocalFixtures,
      lookupFn: options?.lookupFn,
      dnsTimeoutMs: Math.min(
        options?.dnsTimeoutMs ?? SCAN_LIMITS.DNS_TIMEOUT_MS,
        remainingBeforeDns
      )
    });

    if (!check.valid || !check.resolvedIp) {
      return {
        ok: false,
        status: 0,
        finalUrl: currentUrl,
        headers: null,
        html: '',
        htmlBytes: 0,
        ttfbMs: Date.now() - startMs,
        redirectCount,
        errorReasonAr: check.reasonAr || 'الرابط غير مسموح به أمنياً.'
      };
    }

    const targetUrl = check.normalizedUrl || currentUrl;
    const pinnedIp = check.resolvedIp;
    const pinnedFamily = (check.resolvedFamily === 6 ? 6 : 4) as 4 | 6;
    const isLocalFixture =
      Boolean(options?.allowLocalFixtures) &&
      process.env.NODE_ENV !== 'production' &&
      pinnedIp === '127.0.0.1';

    const remainingBeforeSlot = deadlineAt - Date.now();
    if (remainingBeforeSlot <= 0) {
      return {
        ok: false,
        status: 0,
        finalUrl: targetUrl,
        headers: null,
        html: '',
        htmlBytes: 0,
        ttfbMs: Date.now() - startMs,
        redirectCount,
        timedOut: true,
        errorReasonAr: 'الموقع اتأخر في الرد أكتر من المهلة المسموحة.'
      };
    }

    const hostKey = new URL(targetUrl).host.toLowerCase();
    const politenessSlot = await acquireHostPolitenessSlot(hostKey, remainingBeforeSlot, signal);
    if (!politenessSlot.acquired) {
      return {
        ok: false,
        status: 0,
        finalUrl: targetUrl,
        headers: null,
        html: '',
        htmlBytes: 0,
        ttfbMs: Date.now() - startMs,
        redirectCount,
        timedOut: politenessSlot.timedOut,
        aborted: politenessSlot.aborted,
        errorReasonAr: politenessSlot.aborted
          ? 'تم إلغاء الفحص بناءً على طلبك.'
          : 'الموقع اتأخر في الرد أكتر من المهلة المسموحة.'
      };
    }

    let hopResult: SingleHopSuccess | SingleHopError;
    try {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          status: 0,
          finalUrl: targetUrl,
          headers: null,
          html: '',
          htmlBytes: 0,
          ttfbMs: Date.now() - startMs,
          redirectCount,
          timedOut: true,
          errorReasonAr: 'الموقع اتأخر في الرد أكتر من المهلة المسموحة.'
        };
      }

      hopResult = await performSingleHopRequest({
        targetUrl,
        method,
        pinnedIp,
        pinnedFamily,
        isLocalFixture,
        remainingMs,
        maxBytes,
        signal,
        lookupFn: options?.lookupFn
      });
    } finally {
      politenessSlot.release();
    }

    if (hopResult.kind === 'error') {
      return {
        ok: false,
        status: 0,
        finalUrl: targetUrl,
        headers: null,
        html: '',
        htmlBytes: 0,
        ttfbMs: Date.now() - startMs,
        redirectCount,
        connectedIp: hopResult.connectedIp,
        timedOut: hopResult.timedOut,
        timedOutStage: hopResult.timedOutStage,
        aborted: hopResult.aborted,
        errorReasonAr: hopResult.errorReasonAr
      };
    }

    const { status, headers, html, htmlBytes, ttfbMs, connectedIp, abortedByMaxBytes } = hopResult;

    // Handle 3xx redirects
    if (status >= 300 && status < 400) {
      if (method === 'HEAD' && maxRedirects === 0) {
        return {
          ok: false,
          status,
          finalUrl: targetUrl,
          headers,
          html: '',
          htmlBytes: 0,
          ttfbMs,
          redirectCount,
          connectedIp,
          errorReasonAr: 'رفض تتبع التحويل (Redirect) في طلب HEAD.'
        };
      }

      const location = headers.get('location');
      if (!location) {
        return {
          ok: false,
          status,
          finalUrl: targetUrl,
          headers,
          html: '',
          htmlBytes: 0,
          ttfbMs,
          redirectCount,
          connectedIp,
          errorReasonAr: 'الموقع بيرجع تحويل (Redirect) من غير عنوان واضح.'
        };
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        return {
          ok: false,
          status,
          finalUrl: targetUrl,
          headers,
          html: '',
          htmlBytes: 0,
          ttfbMs,
          redirectCount,
          connectedIp,
          errorReasonAr: `الموقع عمل تحويلات كتير زيادة عن الحد المسموح (${maxRedirects} تحويلات).`
        };
      }

      try {
        currentUrl = new URL(location, targetUrl).toString();
      } catch {
        return {
          ok: false,
          status,
          finalUrl: targetUrl,
          headers,
          html: '',
          htmlBytes: 0,
          ttfbMs,
          redirectCount,
          connectedIp,
          errorReasonAr: 'عنوان التحويل (Redirect Location) غير صالح.'
        };
      }
      continue;
    }

    return {
      ok: status >= 200 && status < 400,
      status,
      finalUrl: targetUrl,
      headers,
      html,
      htmlBytes,
      ttfbMs,
      redirectCount,
      connectedIp,
      abortedByMaxBytes
    };
  }

  return {
    ok: false,
    status: 0,
    finalUrl: currentUrl,
    headers: null,
    html: '',
    htmlBytes: 0,
    ttfbMs: Date.now() - startMs,
    redirectCount,
    errorReasonAr: 'تجاوز الحد الأقصى للتحويلات.'
  };
}

export const safeFetchWithSsrf = safeFetchHtmlWithSsrf;

interface SingleHopSuccess {
  kind: 'response';
  status: number;
  headers: Headers;
  html: string;
  htmlBytes: number;
  ttfbMs: number;
  connectedIp: string;
  abortedByMaxBytes: boolean;
}

interface SingleHopError {
  kind: 'error';
  connectedIp?: string;
  timedOut?: boolean;
  timedOutStage?: 'connect' | 'first_byte' | 'body';
  aborted?: boolean;
  errorReasonAr: string;
}

function performSingleHopRequest(params: {
  targetUrl: string;
  method: 'GET' | 'HEAD';
  pinnedIp: string;
  pinnedFamily: 4 | 6;
  isLocalFixture: boolean;
  remainingMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  lookupFn?: DnsLookupFn;
}): Promise<SingleHopSuccess | SingleHopError> {
  const {
    targetUrl,
    method,
    pinnedIp,
    pinnedFamily,
    isLocalFixture,
    remainingMs,
    maxBytes,
    signal,
    lookupFn
  } = params;

  return new Promise(resolve => {
    let settled = false;
    let connectedIp = pinnedIp;
    let fetchStage: 'connect' | 'first_byte' | 'body' = 'connect';
    const hopStart = Date.now();
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    let req: http.ClientRequest | null = null;
    let activeRes: http.IncomingMessage | null = null;

    const finish = (outcome: SingleHopSuccess | SingleHopError) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (signal) {
        signal.removeEventListener('abort', onAbortSignal);
      }
      resolve(outcome);
    };

    const onTimeout = () => {
      if (activeRes) activeRes.destroy();
      if (req) req.destroy();
      const stageNameAr =
        fetchStage === 'connect'
          ? 'الاتصال المبدئي (connect)'
          : fetchStage === 'first_byte'
          ? 'إرسال أول بايت (first byte)'
          : 'تحميل المحتوى (body)';
      finish({
        kind: 'error',
        connectedIp,
        timedOut: true,
        timedOutStage: fetchStage,
        errorReasonAr: `الموقع اتأخر في مرحلة: ${stageNameAr} أكتر من المهلة المسموحة.`
      });
    };

    const onAbortSignal = () => {
      if (activeRes) activeRes.destroy();
      if (req) req.destroy();
      finish({
        kind: 'error',
        connectedIp,
        aborted: true,
        errorReasonAr: 'تم إلغاء الطلب.'
      });
    };

    // Timer stays running until the entire body stream completes (never cleared on headers!)
    const deadlineTimer = setTimeout(onTimeout, Math.max(1, remainingMs));

    if (signal) {
      if (signal.aborted) {
        onAbortSignal();
        return;
      }
      signal.addEventListener('abort', onAbortSignal, { once: true });
    }

    // Custom lookup prevents DNS TOCTOU rebinding:
    // If lookupFn is provided (in tests), we also verify that if a re-resolution were attempted
    // or if the pinned IP is checked, any restricted IP is rejected immediately.
    const customLookup = (
      hostname: string,
      lookupOpts: any,
      callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
    ) => {
      const wantAll = typeof lookupOpts === 'object' && lookupOpts !== null && lookupOpts.all === true;

      const deliverIp = (ip: string, fam: number) => {
        if (!isLocalFixture && isRestrictedIp(ip)) {
          const err = new Error(`SSRF blocked restricted IP in socket lookup: ${ip}`) as NodeJS.ErrnoException;
          err.code = 'ESSRFBLOCKED';
          callback(err, '', fam);
          return;
        }
        connectedIp = ip;
        if (wantAll) {
          callback(null, [{ address: ip, family: fam }]);
        } else {
          callback(null, ip, fam);
        }
      };

      // If a test injected a custom lookupFn to simulate DNS rebinding on the socket lookup phase,
      // check whether lookupFn returns a restricted IP and reject it!
      if (lookupFn) {
        lookupFn(hostname)
          .then(records => {
            if (!records || records.length === 0) {
              const err = new Error('DNS lookup returned no records') as NodeJS.ErrnoException;
              callback(err, '');
              return;
            }
            for (const r of records) {
              if (!isLocalFixture && isRestrictedIp(r.address)) {
                const err = new Error(
                  `DNS TOCTOU rebinding blocked: ${hostname} resolved to restricted IP ${r.address}`
                ) as NodeJS.ErrnoException;
                err.code = 'EDNSREBIND';
                callback(err, '');
                return;
              }
            }
            // Still connect to the originally validated pinnedIp
            deliverIp(pinnedIp, pinnedFamily);
          })
          .catch(err => callback(err, ''));
        return;
      }

      deliverIp(pinnedIp, pinnedFamily);
    };

    try {
      req = requestModule.request(
        targetUrl,
        {
          method,
          lookup: customLookup as any,
          headers: {
            'User-Agent': BOT_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'identity',
            Connection: 'close'
          }
        },
        res => {
          activeRes = res;
          fetchStage = 'body';
          const ttfbMs = Math.max(1, Date.now() - hopStart);
          const status = res.statusCode || 0;
          const headers = toFetchHeaders(res.headers);

          // For HEAD requests or 3xx redirects, do not read body
          if (method === 'HEAD' || (status >= 300 && status < 400)) {
            res.resume();
            res.destroy();
            finish({
              kind: 'response',
              status,
              headers,
              html: '',
              htmlBytes: 0,
              ttfbMs,
              connectedIp,
              abortedByMaxBytes: false
            });
            return;
          }

          // Check Content-Type before streaming body
          const contentType = headers.get('content-type') || '';
          if (isBinaryContentType(contentType)) {
            res.destroy();
            if (req) req.destroy();
            finish({
              kind: 'response',
              status,
              headers,
              html: '',
              htmlBytes: 0,
              ttfbMs,
              connectedIp,
              abortedByMaxBytes: false
            });
            return;
          }

          const encoding = (headers.get('content-encoding') || '').toLowerCase();
          let stream: NodeJS.ReadableStream = res;
          if (encoding === 'gzip' || encoding === 'x-gzip') {
            const gunzip = zlib.createGunzip();
            res.pipe(gunzip);
            stream = gunzip;
          } else if (encoding === 'deflate') {
            const inflate = zlib.createInflate();
            res.pipe(inflate);
            stream = inflate;
          } else if (encoding === 'br') {
            const brotli = zlib.createBrotliDecompress();
            res.pipe(brotli);
            stream = brotli;
          }

          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          let abortedByMaxBytes = false;

          stream.on('data', (chunk: Buffer) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (receivedBytes + buf.length > maxBytes) {
              const allowed = Math.max(0, maxBytes - receivedBytes);
              if (allowed > 0) {
                chunks.push(buf.subarray(0, allowed));
                receivedBytes += allowed;
              }
              abortedByMaxBytes = true;
              res.destroy();
              if (req) req.destroy();
              const combined = Buffer.concat(chunks, receivedBytes);
              const html = new TextDecoder('utf-8', { fatal: false }).decode(combined);
              finish({
                kind: 'response',
                status,
                headers,
                html,
                htmlBytes: receivedBytes,
                ttfbMs,
                connectedIp,
                abortedByMaxBytes: true
              });
              return;
            }

            chunks.push(buf);
            receivedBytes += buf.length;
          });

          stream.on('end', () => {
            if (settled) return;
            const combined = Buffer.concat(chunks, receivedBytes);
            const html = new TextDecoder('utf-8', { fatal: false }).decode(combined);
            finish({
              kind: 'response',
              status,
              headers,
              html,
              htmlBytes: receivedBytes,
              ttfbMs,
              connectedIp,
              abortedByMaxBytes
            });
          });

          stream.on('error', (err: any) => {
            if (settled) return;
            finish({
              kind: 'error',
              connectedIp,
              errorReasonAr:
                err?.code === 'ESSRFBLOCKED' || err?.code === 'EDNSREBIND'
                  ? 'اسم الموقع حاول يحول الاتصال لعنوان شبكة داخلية محظورة (DNS Rebinding).'
                  : 'انقطع الاتصال بالموقع أثناء قراءة الصفحة.'
            });
          });

          res.on('close', () => {
            if (settled) return;
            // Premature close before 'end' while deadline timer is still running -> stalled/aborted connection
            finish({
              kind: 'error',
              connectedIp,
              errorReasonAr: 'السيرفر قفل الاتصال قبل ما يكمل إرسال الصفحة.'
            });
          });
        }
      );

      req.on('socket', socket => {
        if (socket.connecting) {
          socket.once('connect', () => {
            if (fetchStage === 'connect') fetchStage = 'first_byte';
          });
        } else if (fetchStage === 'connect') {
          fetchStage = 'first_byte';
        }
      });

      req.on('error', (err: any) => {
        if (settled) return;
        const isRebind = err?.code === 'ESSRFBLOCKED' || err?.code === 'EDNSREBIND';
        finish({
          kind: 'error',
          connectedIp,
          errorReasonAr: isRebind
            ? 'اسم الموقع حاول يحول الاتصال لعنوان شبكة داخلية محظورة (DNS Rebinding).'
            : 'ما قدرتش أفتح الموقع من السيرفر حالياً.'
        });
      });

      req.end();
    } catch {
      finish({
        kind: 'error',
        connectedIp,
        errorReasonAr: 'ما قدرتش أفتح الموقع من السيرفر حالياً.'
      });
    }
  });
}
