/**
 * PHASE K2.5 & K2.6: Structured JSON Logger with Multi-Layer Secret Redaction
 * and Fail-Safe Typed External Service Errors & Timeouts.
 */
import crypto from 'node:crypto';

export type ExternalServiceName = 'fetch' | 'psi' | 'gemini' | 'store';
export type ExternalErrorCode = 'timeout' | 'unavailable' | 'bad_response' | 'internal';

export class ExternalServiceError extends Error {
  public readonly service: ExternalServiceName;
  public readonly code: ExternalErrorCode;
  public readonly status: number;
  public readonly safeMessageAr: string;

  constructor(params: {
    service: ExternalServiceName;
    code: ExternalErrorCode;
    message?: string;
    safeMessageAr?: string;
    status?: number;
  }) {
    super(params.message || `${params.service} error (${params.code})`);
    this.name = 'ExternalServiceError';
    this.service = params.service;
    this.code = params.code;
    this.status = params.status ?? (params.service === 'store' ? 503 : 502);
    this.safeMessageAr =
      params.safeMessageAr ||
      (params.service === 'store'
        ? 'الخدمة غير متاحة مؤقتاً بسبب عطل في التخزين، جرب تاني بعد ثواني.'
        : params.code === 'timeout'
          ? 'انتهت مهلة الاتصال بالخدمة الخارجية، جرب تاني بعد شوية.'
          : 'حدث خطأ مؤقت أثناء معالجة الطلب، جرب تاني بعد ثواني.');
  }
}

export async function withServiceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  service: ExternalServiceName,
  safeMessageAr?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ExternalServiceError({
          service,
          code: 'timeout',
          message: `${service} timed out after ${timeoutMs}ms`,
          safeMessageAr
        })
      );
    }, timeoutMs);
    if (timer && typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StructuredLogEntry {
  timestamp?: string;
  level: 'info' | 'warn' | 'error';
  event: 'http_request' | 'rate_limit_rejected' | 'server_error' | 'security_event';
  requestId: string;
  method?: string;
  route: string;
  status: number;
  durationMs?: number;
  visitorHashPrefix: string;
  message?: string;
  meta?: Record<string, unknown>;
}

const SENSITIVE_KEY_NAME_REGEX =
  /(?:api[_-]?key|secret|token|password|passwd|cookie|set-cookie|authorization|visitor[_-]?id[_-]?salt|share[_-]?token)/i;

/**
 * Redacts API keys, bearer tokens, share tokens, cookies, env secrets,
 * and raw URL query strings from any string before it reaches logs.
 */
export function redactLogString(input: string): string {
  if (!input || typeof input !== 'string') return '';
  let out = input;

  // 0. Redact active runtime environment secrets if set (>= 8 chars)
  if (typeof process !== 'undefined' && process.env) {
    const envSecretNames = ['GEMINI_API_KEY', 'PSI_API_KEY', 'GLM_API_KEY', 'VISITOR_ID_SALT'];
    for (const envName of envSecretNames) {
      const rawVal = (process.env[envName] || '').trim();
      if (
        rawVal &&
        rawVal.length >= 8 &&
        rawVal !== 'MY_GEMINI_API_KEY' &&
        rawVal !== 'YOUR_PSI_API_KEY' &&
        rawVal !== 'madam-afaf-default-visitor-salt-v2'
      ) {
        out = out.split(rawVal).join('[REDACTED_ENV_SECRET]');
      }
    }
  }

  // 1. Redact share tokens in URL paths (/api/share/<token>, /api/shared/<token>, /share/<token>, /shared/<token>)
  out = out.replace(
    /(\/(?:api\/)?shared?\/)[a-zA-Z0-9_-]{8,128}/gi,
    '$1[REDACTED_SHARE_TOKEN]'
  );

  // 2. Redact raw URLs' query strings (https://example.com/path?secret=123 -> https://example.com/path?[REDACTED_QUERY])
  out = out.replace(
    /(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>#]+/gi,
    '$1?[REDACTED_QUERY]'
  );
  // Also redact relative path query strings (/api/quota?domain=x&token=y -> /api/quota?[REDACTED_QUERY])
  out = out.replace(
    /(\/[a-zA-Z0-9_./[\]-]+)\?[^\s"'<>#]+/g,
    '$1?[REDACTED_QUERY]'
  );

  // 3. Redact cookies (madam_visitor=..., Cookie: ..., Set-Cookie: ...)
  out = out.replace(/madam_visitor=[^;\s"'<>]+/gi, 'madam_visitor=[REDACTED_COOKIE]');
  out = out.replace(
    /((?:set-)?cookie\s*:\s*)[^\r\n"'<>]+/gi,
    '$1[REDACTED_COOKIE]'
  );

  // 4. Redact Bearer / Authorization headers
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED_TOKEN]');

  // 5. Redact common API keys and ephemeral tokens (Google AIza, OpenAI sk-, AWS AKIA, GitHub ghp_, Stripe, live_)
  out = out.replace(
    /\b(?:sk-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{16,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|rk_live_[A-Za-z0-9]{10,}|sk_live_[A-Za-z0-9]{10,}|live_[0-9a-f]{16,})\b/g,
    '[REDACTED_KEY]'
  );

  // 6. Redact key=value secret assignments
  out = out.replace(
    /((?:api[_-]?key|secret|token|shareToken|password|passwd|visitor_id_salt|key)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{6,}(["']?)/gi,
    '$1[REDACTED_SECRET]$2'
  );

  return out;
}

export function redactLogData(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactLogString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map(item => redactLogData(item, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogString(value.message)
    };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_NAME_REGEX.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactLogData(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

let customLogSink: ((jsonLine: string, parsed: StructuredLogEntry) => void) | null = null;
const recentLogBuffer: string[] = [];
const MAX_RECENT_LOGS = 200;

export function setLogSinkForTesting(
  sink: ((jsonLine: string, parsed: StructuredLogEntry) => void) | null
): void {
  customLogSink = sink;
}

export function getRecentLogsForTesting(): string[] {
  return [...recentLogBuffer];
}

export function clearRecentLogsForTesting(): void {
  recentLogBuffer.length = 0;
}

export function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

export function formatVisitorHashPrefix(visitorHash?: string | null): string {
  if (!visitorHash || typeof visitorHash !== 'string') return 'anon';
  const clean = visitorHash.trim();
  if (!clean) return 'anon';
  return clean.slice(0, 11);
}

export function formatStructuredLog(entry: StructuredLogEntry): string {
  const sanitizedRoute = redactLogString(entry.route || '/');
  const sanitizedMessage = entry.message ? redactLogString(entry.message) : undefined;
  const sanitizedMeta = entry.meta
    ? (redactLogData(entry.meta) as Record<string, unknown>)
    : undefined;

  const payload: StructuredLogEntry = {
    timestamp: entry.timestamp || new Date().toISOString(),
    level: entry.level,
    event: entry.event,
    requestId: entry.requestId || generateRequestId(),
    ...(entry.method ? { method: entry.method } : {}),
    route: sanitizedRoute,
    status: entry.status,
    ...(entry.durationMs !== undefined ? { durationMs: Math.round(entry.durationMs) } : {}),
    visitorHashPrefix: formatVisitorHashPrefix(entry.visitorHashPrefix),
    ...(sanitizedMessage ? { message: sanitizedMessage } : {}),
    ...(sanitizedMeta ? { meta: sanitizedMeta } : {})
  };

  return JSON.stringify(payload);
}

export function emitStructuredLog(entry: StructuredLogEntry): string {
  const jsonLine = formatStructuredLog(entry);
  if (recentLogBuffer.length >= MAX_RECENT_LOGS) {
    recentLogBuffer.shift();
  }
  recentLogBuffer.push(jsonLine);

  if (customLogSink) {
    try {
      customLogSink(jsonLine, JSON.parse(jsonLine));
    } catch {
      // ignore sink errors in tests
    }
    return jsonLine;
  }

  const isTest =
    process.env.NODE_ENV === 'test' ||
    process.argv.some(arg => arg === '--test' || arg.endsWith('.test.ts')) ||
    process.execArgv.some(arg => arg === '--test') ||
    process.env.npm_lifecycle_event === 'test';

  if (!isTest) {
    if (entry.level === 'error') {
      console.error(jsonLine);
    } else if (entry.level === 'warn') {
      console.warn(jsonLine);
    } else {
      console.log(jsonLine);
    }
  }

  return jsonLine;
}
