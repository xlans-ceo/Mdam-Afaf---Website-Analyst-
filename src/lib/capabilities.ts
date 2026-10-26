/**
 * Capability Discovery (Step 1 of Honest Engine v1.1)
 * Probes runtime capabilities with short timeouts and returns a typed CapabilitiesReport.
 * Never fabricates capabilities: browserRendering is false unless explicitly proven,
 * and psi is true only when PSI_API_KEY is present in the server environment.
 */
import { z } from 'zod';
import { CapabilitiesReport, Capability } from '../types/contract';

export const CAPABILITY_LABELS_AR: Record<Capability, string> = {
  serverFetch: 'جلب صفحات الموقع (HTTP Fetch)',
  responseHeaders: 'قراءة هيدرز السيرفر (Response Headers)',
  timing: 'قياس سرعة استجابة السيرفر (TTFB)',
  htmlParser: 'تحليل كود الصفحة (HTML Parser)',
  headRequests: 'فحص أحجام الصور والملفات (HEAD Requests)',
  psi: 'قياسات Google PageSpeed Insights الحقيقية',
  geminiStructuredOutput: 'تحليل سياقي مهيكل (Zod + Gemini)',
  browserRendering: 'تشغيل متصفح حقيقي وتنفيذ الجافاسكريبت (Real Browser)'
};

let cachedCapabilities: CapabilitiesReport | null = null;
let cachedAtMs = 0;

export function hasPsiKeyConfigured(
  env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {}
): boolean {
  const psiKey = (env.PSI_API_KEY || '').trim();
  return Boolean(psiKey && psiKey !== 'YOUR_PSI_API_KEY');
}

export function getStartupPsiLogLine(
  env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {}
): 'PSI: enabled' | 'PSI: disabled (no key)' {
  return hasPsiKeyConfigured(env) ? 'PSI: enabled' : 'PSI: disabled (no key)';
}

export async function detectCapabilities(options?: {
  forceRefresh?: boolean;
  skipNetworkProbe?: boolean;
}): Promise<CapabilitiesReport> {
  const now = Date.now();
  if (!options?.forceRefresh && cachedCapabilities && now - cachedAtMs < 60_000) {
    return cachedCapabilities;
  }

  let serverFetch = typeof fetch === 'function';
  let responseHeaders = typeof Headers !== 'undefined';
  const timing = typeof performance !== 'undefined' && typeof performance.now === 'function';
  const htmlParser = true; // Built-in deterministic HTML analyzer is always available
  let headRequests = typeof fetch === 'function';

  const psi = hasPsiKeyConfigured();

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const zodWorks = z.object({ ok: z.boolean() }).safeParse({ ok: true }).success;
  const geminiStructuredOutput = Boolean(
    zodWorks && geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'
  );

  // In the scanner runtime, we do not launch a headless browser per user scan
  const browserRendering = false;

  if (!options?.skipNetworkProbe && typeof fetch === 'function') {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res = await fetch('https://example.com', {
        method: 'HEAD',
        signal: ctrl.signal,
        redirect: 'manual'
      });
      clearTimeout(timer);
      serverFetch = res.status > 0;
      responseHeaders = typeof res.headers?.get === 'function';
      headRequests = res.status > 0;
    } catch {
      // Keep function-level availability if external probe times out in offline test runs
    }
  }

  cachedCapabilities = {
    serverFetch,
    responseHeaders,
    timing,
    htmlParser,
    headRequests,
    psi,
    geminiStructuredOutput,
    browserRendering
  };
  cachedAtMs = now;

  return cachedCapabilities;
}
