import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppConfig } from './src/lib/config';
import { validateAndNormalizeUrl, normalizeUserDomainOrUrl, evaluateChatGatekeeper } from './src/lib/url-gatekeeper';
import { getScannerProvider, ScannerProvider } from './src/lib/providers/index';
import { buildRepairPrompts } from './src/lib/repair-prompt-builder';
import { refineReportWithGemini } from './src/lib/explain-service';
import {
  askMadamAfaf,
  synthesizeMadamSpeechWithMime,
  transcribeUserAudio
} from './src/lib/ai-consultant';
import { detectCapabilities, getStartupPsiLogLine } from './src/lib/capabilities';
import {
  persistentStore,
  PersistentStore,
  validateVisitorIdSalt,
  ensureRuntimeVisitorIdSalt,
  hashVisitorId
} from './src/lib/storage';
import { SCAN_LIMITS } from './src/config/limits.server';
import { RELEASE_CONFIG, getReleaseInfo } from './src/config/release';
import { buildConfigCheckReport } from './src/lib/config-check';
import { validateChatReplyAgainstReport } from './src/lib/madam-persona';
import { buildContextFromScanResult } from './src/lib/chat-context';
import {
  emitStructuredLog,
  ExternalServiceError,
  formatVisitorHashPrefix,
  generateRequestId
} from './src/lib/logger';

const activeScanControllers = new Map<string, AbortController>();
const VALID_VISITOR_ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/;

export function hasValidVisitorHeader(req: express.Request): boolean {
  const headerVisitorId = req.headers['x-visitor-id'];
  return (
    typeof headerVisitorId === 'string' &&
    VALID_VISITOR_ID_REGEX.test(headerVisitorId.trim())
  );
}

export function getVisitorId(req: express.Request, res: express.Response): string {
  const headerVisitorId = req.headers['x-visitor-id'];
  if (
    typeof headerVisitorId === 'string' &&
    VALID_VISITOR_ID_REGEX.test(headerVisitorId.trim())
  ) {
    const cleanId = headerVisitorId.trim();
    const isSecure =
      req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('X-Visitor-Id', cleanId);
    res.setHeader(
      'Set-Cookie',
      `madam_visitor=${cleanId}; Path=/; HttpOnly; Max-Age=2592000; ${
        isSecure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'
      }`
    );
    (req as any)._resolvedVisitorId = cleanId;
    return cleanId;
  }

  // Cookie fallback is allowed ONLY on safe read-only methods (GET / HEAD)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/madam_visitor=([a-zA-Z0-9_-]{4,64})/);
    if (match && match[1]) {
      res.setHeader('X-Visitor-Id', match[1]);
      (req as any)._resolvedVisitorId = match[1];
      return match[1];
    }
  }

  const newId = `v_${crypto.randomBytes(16).toString('hex')}`;
  const isSecure =
    req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('X-Visitor-Id', newId);
  res.setHeader(
    'Set-Cookie',
    `madam_visitor=${newId}; Path=/; HttpOnly; Max-Age=2592000; ${
      isSecure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'
    }`
  );
  (req as any)._resolvedVisitorId = newId;
  return newId;
}

function safeRoute(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown | Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function getClientIp(req: express.Request): string {
  return (req.ip || req.socket?.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
}

export interface CreateApiAppOptions {
  store?: PersistentStore;
  provider?: ScannerProvider;
  allowLocalFixtures?: boolean;
  concurrencyLimits?: { maxGlobal?: number; maxPerIp?: number };
}

export function createApiApp(options?: CreateApiAppOptions): express.Express {
  const store = options?.store ?? persistentStore;
  const app = express();

  interface QueuedScanItem {
    scanId: string;
    visitorId: string;
    clientIp: string;
    normalizedUrl: string;
    purpose?: string;
    keyJourney?: string;
    aiClaims?: string;
    scanOptions?: any;
    rescanMode?: 'same_pages' | 'remaining_pages';
    forceRescan?: boolean;
    reservation: any;
    provider: ScannerProvider;
  }

  const scanQueue: QueuedScanItem[] = [];

  const updateQueuePositions = () => {
    scanQueue.forEach((item, idx) => {
      const pos = idx + 1;
      store.updateJobProgress(item.scanId, {
        queuePosition: pos,
        stageDetail: `انت رقم ${pos} في الدور — هيبدأ الفحص تلقائياً أول ما يفضى مكان.`
      });
    });
  };

  const advanceQueue = () => {
    while (scanQueue.length > 0) {
      const nextCandidate = scanQueue[0];
      const slot = store.acquireConcurrentScanSlot(
        nextCandidate.scanId,
        nextCandidate.clientIp,
        options?.concurrencyLimits
      );
      if (!slot.allowed) {
        break;
      }
      scanQueue.shift();
      updateQueuePositions();
      executeScan(nextCandidate);
    }
  };

  const executeScan = (item: QueuedScanItem) => {
    const {
      scanId,
      visitorId,
      normalizedUrl,
      purpose,
      keyJourney,
      aiClaims,
      scanOptions,
      rescanMode,
      forceRescan,
      reservation,
      provider
    } = item;

    const abortCtrl = new AbortController();
    activeScanControllers.set(scanId, abortCtrl);

    store.updateJobProgress(scanId, {
      status: 'running',
      queuePosition: undefined,
      currentStage: 'url_check',
      stageStates: {
        url_check: 'started',
        discovery: 'pending',
        interaction: 'pending',
        lighthouse: 'pending',
        report: 'pending'
      },
      stageDetail: 'التحقق من أمان الرابط وصلاحية النطاق'
    });

    const finishScan = () => {
      activeScanControllers.delete(scanId);
      store.releaseConcurrentScanSlot(scanId);
      advanceQueue();
    };

    const previousReport = store.getLatestReportForDomain(
      visitorId,
      reservation.registrableDomain,
      scanId
    );
    const isRescanForDomain = Boolean(previousReport);
    const previousDeploymentFingerprint = previousReport?.result?.deploymentFingerprint;
    const effectiveRescanMode =
      rescanMode || (isRescanForDomain ? 'same_pages' : undefined);
    const targetUrls =
      effectiveRescanMode === 'remaining_pages'
        ? previousReport?.result?.discoveredNotScanned
        : effectiveRescanMode === 'same_pages'
          ? previousReport?.result?.pages?.map(p => p.url)
          : undefined;

    provider
      .runScan(
        scanId,
        {
          url: normalizedUrl,
          purpose,
          keyJourney,
          aiClaims: typeof aiClaims === 'string' ? aiClaims.slice(0, 500) : undefined,
          options: scanOptions,
          isRescan: isRescanForDomain,
          rescanMode: effectiveRescanMode,
          forceRescan: Boolean(forceRescan),
          previousDeploymentFingerprint,
          targetUrls,
          locale: 'ar-EG'
        },
        event => {
          if (abortCtrl.signal.aborted) return;
          const existing = store.getScanStatusForVisitor(scanId, visitorId);
          if (existing.httpStatus !== 200 || !existing.scan) return;
          if (existing.scan.status === 'cancelled') return;

          if (event.type === 'stage') {
            store.updateJobProgress(scanId, {
              currentStage: event.stage,
              stageStates: {
                ...existing.scan.stageStates,
                [event.stage]: event.state
              },
              stageDetail: event.detail ?? existing.scan.stageDetail
            });
          } else if (event.type === 'page') {
            store.updateJobProgress(scanId, {
              inspectedPagesCount: event.index
            });
          } else if (event.type === 'done') {
            const finalResult = event.result;
            try {
              finishScan();
              if (finalResult.unchangedDeployment) {
                store.saveScanReport({ visitorId }, finalResult);
                return;
              }
              const isStatusOnly = Boolean(
                finalResult.siteStatus && finalResult.siteStatus.state !== 'ok'
              );

              if (!isStatusOnly) {
                const prompts = buildRepairPrompts({
                  requestedUrl: finalResult.requestedUrl,
                  finalUrl: finalResult.finalUrl,
                  scanId: finalResult.scanId,
                  startedAt: finalResult.startedAt,
                  purpose,
                  keyJourney,
                  siteProfile: finalResult.siteProfile,
                  verdict: finalResult.verdict,
                  findings: finalResult.findings
                });
                finalResult.repairMode = prompts.repairMode;
                finalResult.masterRepairPrompt = prompts.masterPrompt;
                finalResult.confirmedOnlyMasterRepairPrompt = prompts.confirmedOnlyMasterPrompt;
                finalResult.developerMarkdownHandoff = prompts.developerMarkdownHandoff;
                finalResult.confirmedOnlyDeveloperMarkdownHandoff =
                  prompts.confirmedOnlyDeveloperMarkdownHandoff;
                finalResult.cmsChecklistItems = prompts.cmsChecklistItems;
                finalResult.individualRepairPrompts = prompts.individualPrompts;
              } else {
                finalResult.masterRepairPrompt = '';
                finalResult.confirmedOnlyMasterRepairPrompt = '';
                finalResult.developerMarkdownHandoff = '';
                finalResult.confirmedOnlyDeveloperMarkdownHandoff = '';
                finalResult.cmsChecklistItems = [];
                finalResult.individualRepairPrompts = {};
              }

              refineReportWithGemini(finalResult)
                .then(refined => {
                  try {
                    if (abortCtrl.signal.aborted) {
                      store.releaseReservation(scanId);
                      return;
                    }
                    if (isStatusOnly && finalResult.siteStatus) {
                      refined.summaryAr = `${finalResult.siteStatus.whatISawAr} ${finalResult.siteStatus.whatItMeansAr} ${finalResult.siteStatus.whatToDoAr}`;
                    }
                    store.saveScanReport({ visitorId }, refined);
                  } catch (saveErr) {
                    console.error('[Madam Afaf Server] Error saving refined report:', saveErr);
                    store.releaseReservation(scanId);
                  }
                })
                .catch(refineErr => {
                  try {
                    console.error('[Madam Afaf Server] refineReportWithGemini failed:', refineErr);
                    if (abortCtrl.signal.aborted) {
                      store.releaseReservation(scanId);
                      return;
                    }
                    store.saveScanReport({ visitorId }, finalResult);
                  } catch (saveErr) {
                    console.error('[Madam Afaf Server] Error saving unrefined report:', saveErr);
                    store.releaseReservation(scanId);
                  }
                });
            } catch (err) {
              console.error('[Madam Afaf Server] Unexpected error in done handler:', err);
              try {
                store.saveScanReport({ visitorId }, finalResult);
              } catch {
                store.releaseReservation(scanId);
              }
            }
          } else if (event.type === 'error') {
            finishScan();
            store.failJob(scanId, event.message, event.code);
          }
        },
        {
          signal: abortCtrl.signal,
          maxPagesOverride: reservation.maxPagesOverride
        }
      )
      .catch((err: any) => {
        finishScan();
        store.releaseReservation(scanId);
        if (abortCtrl.signal.aborted) {
          store.cancelJob(scanId, visitorId);
          return;
        }
        store.failJob(
          scanId,
          err?.message || 'حدث خطأ غير متوقع أثناء تشغيل محرك الفحص.'
        );
      });
  };

  // H2.3 & C2: Trust proxy configuration read strictly via SCAN_LIMITS.TRUST_PROXY_HOPS
  app.set('trust proxy', SCAN_LIMITS.TRUST_PROXY_HOPS);

  // K0.2: Security headers on every response
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self)');

    // HSTS on secure requests (direct HTTPS or forwarded HTTPS)
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (isSecure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CSP as Report-Only first
    res.setHeader(
      'Content-Security-Policy-Report-Only',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data: https:; object-src 'none'; base-uri 'self';"
    );

    // No frame-ancestors or X-Frame-Options unless ALLOW_FRAMING=false
    const allowFraming = process.env.ALLOW_FRAMING !== 'false';
    if (!allowFraming) {
      res.setHeader('X-Frame-Options', 'DENY');
    }

    next();
  });

  // H2.2: Block sensitive paths (/data, /server.ts, /scripts, /eval, /.env*) with 404
  app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (
      p === '/data' ||
      p.startsWith('/data/') ||
      p === '/server.ts' ||
      p.startsWith('/server.ts') ||
      p === '/scripts' ||
      p.startsWith('/scripts/') ||
      p === '/eval' ||
      p.startsWith('/eval/') ||
      p === '/.env' ||
      p.startsWith('/.env')
    ) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    next();
  });

  // H2.4: Body limits - 6mb on /api/transcribe, 100kb default on all other routes
  app.use('/api/transcribe', express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '100kb' }));

  // K2.5: Structured JSON request logging with multi-layer secret redaction
  app.use((req, res, next) => {
    const requestId = generateRequestId();
    const startMs = Date.now();
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      if (!req.path.startsWith('/api')) return;
      const durationMs = Date.now() - startMs;
      const rawVisitor =
        (req as any)._resolvedVisitorId ||
        (typeof req.headers['x-visitor-id'] === 'string' ? req.headers['x-visitor-id'].trim() : '');
      const visitorHashPrefix = rawVisitor
        ? formatVisitorHashPrefix(hashVisitorId(rawVisitor))
        : 'anon';

      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status === 429 || status === 403 ? 'warn' : 'info';
      const event =
        status === 429
          ? 'rate_limit_rejected'
          : status >= 500
            ? 'server_error'
            : status === 403
              ? 'security_event'
              : 'http_request';

      emitStructuredLog({
        level,
        event,
        requestId,
        method: req.method,
        route: req.originalUrl || req.url,
        status,
        durationMs,
        visitorHashPrefix
      });
    });

    next();
  });

  // K2.2: CSRF protection — every state-changing route (POST/DELETE/PUT/PATCH) requires custom header X-Visitor-Id
  app.use('/api', (req, res, next) => {
    const method = req.method.toUpperCase();
    if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
      if (!hasValidVisitorHeader(req)) {
        return res.status(403).json({
          ok: false,
          code: 'csrf_missing_header',
          error: 'مطلوب ترويسة X-Visitor-Id لتنفيذ هذا الطلب لحماية جلستك (CSRF).'
        });
      }
    }
    next();
  });

  // Share routes set noindex and Cache-Control: no-store headers
  app.use((req, res, next) => {
    if (req.path.startsWith('/share/') || req.path.startsWith('/api/share/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  // 1. Per-(Visitor, Domain) Quota & System Status (H3 & B3.1)
  app.get('/api/quota', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const domainParam =
      typeof req.query.domain === 'string' ? req.query.domain.trim() : undefined;
    const quota = store.getQuotaStatus({ visitorId }, domainParam);
    res.json({
      ok: true,
      scanMode: AppConfig.SCAN_MODE,
      hardDisabled: AppConfig.FREE_SCANS_HARD_DISABLED,
      domain: quota.domain,
      pagesUsed: quota.pagesUsed,
      pagesRemaining: quota.pagesRemaining,
      maxPages: quota.maxPages,
      reviewsUsed: quota.reviewsUsed ?? 0,
      reviewsRemaining: quota.reviewsRemaining ?? 3,
      maxReviews: quota.maxReviews ?? 3,
      resetAt: quota.resetAt,
      exhausted: quota.exhausted,
      remainingMinutes: quota.remainingMinutes,
      quota
    });
  }));

  // 1b. Honest Engine Capabilities Discovery (H2.1: capped strictly to booleans)
  app.get('/api/capabilities', async (_req, res) => {
    try {
      const caps = await detectCapabilities();
      const booleanCaps: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(caps)) {
        booleanCaps[k] = Boolean(v);
      }
      res.json({
        ok: true,
        capabilities: booleanCaps
      });
    } catch {
      res.status(500).json({ ok: false, error: 'تعذر فحص قدرات السيرفر' });
    }
  });

  // 1c. Health Check Endpoint (P1.6: persistence status and boolean config with zero secrets)
  app.get('/api/health', safeRoute((_req, res) => {
    let saltOk = false;
    try {
      validateVisitorIdSalt();
      saltOk = true;
    } catch {
      saltOk = false;
    }
    const adminEnabled = Boolean((process.env.ADMIN_TOKEN || '').trim());
    const rawPsiKey = (process.env.PSI_API_KEY || '').trim();
    const psiEnabled = Boolean(rawPsiKey && rawPsiKey !== 'YOUR_PSI_API_KEY');
    const rawGeminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const geminiEnabled = Boolean(rawGeminiKey && rawGeminiKey !== 'YOUR_GEMINI_API_KEY');

    res.json({
      ok: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      version: SCAN_LIMITS.RULESET_VERSION,
      scanMode: AppConfig.SCAN_MODE,
      release: {
        stage: RELEASE_CONFIG.stage,
        appVersion: RELEASE_CONFIG.appVersion,
        rulesetVersion: RELEASE_CONFIG.rulesetVersion,
        schemaVersion: RELEASE_CONFIG.schemaVersion,
        badgeTextAr: RELEASE_CONFIG.badgeTextAr
      },
      persistence: store.getPersistenceStatus(),
      config: {
        saltOk,
        adminEnabled,
        psi: psiEnabled,
        gemini: geminiEnabled
      }
    });
  }));

  // B2.5: Server-side reports list (last 20 summaries only, grouped by domain on client)
  app.get('/api/reports', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const reports = store.listVisitorReports(visitorId, 20);
    res.json({
      ok: true,
      reports
    });
  }));

  // 3. Start a Scan
  const scanOptionsSchema = z
    .object({
      checkPageSpeed: z.boolean().optional(),
      checkLinksAndErrors: z.boolean().optional(),
      checkSeo: z.boolean().optional(),
      checkSecurityAndMobile: z.boolean().optional()
    })
    .strip();

  const scanRequestBodySchema = z
    .object({
      url: z
        .string()
        .min(1, 'رابط الموقع مطلوب.')
        .max(2048, 'رابط الموقع يجب ألا يتجاوز 2048 حرف.'),
      purpose: z.string().max(300, 'الهدف من الموقع يجب ألا يتجاوز 300 حرف.').optional(),
      keyJourney: z.string().max(300, 'أهم مسار يجب ألا يتجاوز 300 حرف.').optional(),
      aiClaims: z.string().max(1000, 'وعود الـ AI يجب ألا تتجاوز 1000 حرف.').optional(),
      options: scanOptionsSchema.optional(),
      isAuthorized: z.boolean().optional(),
      rescanMode: z.enum(['same_pages', 'remaining_pages']).optional(),
      forceRescan: z.boolean().optional()
    })
    .passthrough();

  app.post('/api/scans', safeRoute(async (req, res) => {
    const visitorId = getVisitorId(req, res);
    const clientIp = getClientIp(req);

    const validation = scanRequestBodySchema.safeParse(req.body || {});
    if (!validation.success) {
      const issue = validation.error.issues[0];
      return res.status(400).json({
        ok: false,
        error: issue?.message || 'بيانات الفحص غير صالحة.'
      });
    }

    const { url, purpose, keyJourney, aiClaims, options: scanOptions, rescanMode, forceRescan } = validation.data;

    if (AppConfig.FREE_SCANS_HARD_DISABLED) {
      return res.status(503).json({
        ok: false,
        error: 'خدمة الفحص متوقفة مؤقتاً للصيانة. التقارير السابقة متاحة للمراجعة.'
      });
    }

    // P2c.2: Check Idempotency-Key header (10-minute window) before consuming rate limits or quota
    const rawIdemKey = (req.header('idempotency-key') || '').trim();
    const idempotencyKey = rawIdemKey.length > 0 && rawIdemKey.length <= 128 ? rawIdemKey : '';
    if (idempotencyKey) {
      const existingByIdem = store.getIdempotentScan(visitorId, idempotencyKey);
      if (existingByIdem) {
        return res.json({
          ok: true,
          scanId: existingByIdem.scanId,
          reused: true,
          status: existingByIdem.status,
          quota: store.getQuotaStatus({ visitorId }, existingByIdem.registrableDomain)
        });
      }
    }

    // IP Rate Limit check (MAX_SCAN_ATTEMPTS_PER_IP_PER_HOUR = 20)
    const ipCheck = store.checkEndpointRateLimit(clientIp, 'scan');
    if (!ipCheck.allowed) {
      return res.status(429).json({
        ok: false,
        error: ipCheck.messageAr
      });
    }

    // Gatekeeper validation (SSRF & URL format)
    let normalizedUrl = '';
    let registrableDomain = '';
    if (
      options?.allowLocalFixtures &&
      typeof url === 'string' &&
      (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:'))
    ) {
      normalizedUrl = url;
      registrableDomain = 'fixture.test';
    } else {
      const gateResult = validateAndNormalizeUrl(url || '');
      if (!gateResult.ok || !gateResult.normalizedUrl || !gateResult.registrableDomain) {
        return res.status(400).json({
          ok: false,
          error: gateResult.errorAr || 'الرابط غير صالح للفحص.'
        });
      }
      normalizedUrl = gateResult.normalizedUrl;
      registrableDomain = gateResult.registrableDomain;
    }

    const candidateScanId = store.generateScanId();

    // H3 & P2c.1: Synchronous check-and-set reserving min(10, remaining) pages for (visitor, domain)
    // or returning existing active ('queued' | 'running') job with reused: true
    const reservation = store.reserveScan(
      { visitorId },
      {
        scanId: candidateScanId,
        requestedUrl: url,
        normalizedUrl,
        registrableDomain,
        rescanMode
      }
    );
    if (!reservation.allowed) {
      return res.status(429).json({
        ok: false,
        error: reservation.reasonAr,
        quota: reservation.quota
      });
    }

    const scanId = reservation.job?.scanId || candidateScanId;
    if (idempotencyKey) {
      store.saveIdempotencyRecord(visitorId, idempotencyKey, scanId);
    }

    // P2c.1: If an active scan already exists for this (visitor, domain), attach to it without re-running
    if (reservation.reused && reservation.job) {
      return res.json({
        ok: true,
        scanId: reservation.job.scanId,
        reused: true,
        status: reservation.job.status,
        queuePosition: reservation.job.queuePosition,
        maxPagesOverride: reservation.maxPagesOverride,
        quota: reservation.quota
      });
    }

    const provider = options?.provider ?? getScannerProvider(AppConfig.SCAN_MODE);
    const maxQueueLength = SCAN_LIMITS.MAX_QUEUE_LENGTH || 10;

    // FIFO Queue logic: if already waiting items in queue, new scans must enqueue
    if (scanQueue.length > 0) {
      if (scanQueue.length >= maxQueueLength) {
        store.releaseReservation(scanId);
        store.failJob(scanId, 'السيرفر مشغول حالياً بالحد الأقصى لطابور الفحص', 'queue_full');
        return res.status(429).json({
          ok: false,
          error: `السيرفر مشغول حالياً بالحد الأقصى لطابور الانتظار (${maxQueueLength} في الانتظار). استنى شوية وجرب تاني.`
        });
      }

      const queuePosition = scanQueue.length + 1;
      const queueItem: QueuedScanItem = {
        scanId,
        visitorId,
        clientIp,
        normalizedUrl,
        purpose,
        keyJourney,
        aiClaims,
        scanOptions,
        rescanMode,
        forceRescan,
        reservation,
        provider
      };
      scanQueue.push(queueItem);
      store.updateJobProgress(scanId, {
        status: 'queued',
        queuePosition,
        stageDetail: `انت رقم ${queuePosition} في الدور — هيبدأ الفحص تلقائياً أول ما يفضى مكان.`
      });

      return res.json({
        ok: true,
        scanId,
        reused: false,
        status: 'queued',
        queuePosition,
        maxPagesOverride: reservation.maxPagesOverride,
        quota: reservation.quota
      });
    }

    // Try acquiring slot directly
    const slotCheck = store.acquireConcurrentScanSlot(
      scanId,
      clientIp,
      options?.concurrencyLimits
    );

    if (!slotCheck.allowed) {
      // Concurrency slot occupied: enqueue if space available
      if (scanQueue.length >= maxQueueLength) {
        store.releaseReservation(scanId);
        store.failJob(scanId, 'السيرفر مشغول حالياً بالحد الأقصى لطابور الفحص', 'queue_full');
        return res.status(429).json({
          ok: false,
          error: slotCheck.messageAr
        });
      }

      const queuePosition = scanQueue.length + 1;
      const queueItem: QueuedScanItem = {
        scanId,
        visitorId,
        clientIp,
        normalizedUrl,
        purpose,
        keyJourney,
        aiClaims,
        scanOptions,
        rescanMode,
        forceRescan,
        reservation,
        provider
      };
      scanQueue.push(queueItem);
      store.updateJobProgress(scanId, {
        status: 'queued',
        queuePosition,
        stageDetail: `انت رقم ${queuePosition} في الدور — هيبدأ الفحص تلقائياً أول ما يفضى مكان.`
      });

      return res.json({
        ok: true,
        scanId,
        reused: false,
        status: 'queued',
        queuePosition,
        maxPagesOverride: reservation.maxPagesOverride,
        quota: reservation.quota
      });
    }

    // Acquired slot immediately - run directly
    executeScan({
      scanId,
      visitorId,
      clientIp,
      normalizedUrl,
      purpose,
      keyJourney,
      aiClaims,
      scanOptions,
      rescanMode,
      forceRescan,
      reservation,
      provider
    });

    return res.json({
      ok: true,
      scanId,
      reused: false,
      maxPagesOverride: reservation.maxPagesOverride,
      quota: reservation.quota
    });
  }));

  // 3b. Missing Scan ID in GET /api/scans (prevents collision with SPA fallback)
  app.get('/api/scans', (_req, res) => {
    return res.status(400).json({
      ok: false,
      code: 'missing_id',
      error: 'معرّف الفحص مطلوب في الرابط (مثال: /api/scans/scan_xxx).'
    });
  });

  // 4. Poll Scan Status or Load Private Stored Report
  // G2.2: 200 with real error on failed/cancelled/interrupted jobs, 410 on tombstones, 404 on unknown/foreign
  app.get('/api/scans/:id', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const scanId = (req.params.id || '').trim();

    if (!scanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(scanId)) {
      return res.status(404).json({
        ok: false,
        code: 'not_found',
        error: 'معرّف الفحص غير صالح أو غير موجود.'
      });
    }

    const lookup = store.getScanStatusForVisitor(scanId, visitorId);
    if (lookup.httpStatus === 410) {
      return res.status(410).json({
        ok: false,
        code: 'gone',
        reason: lookup.reason,
        error: lookup.errorAr
      });
    }
    if (lookup.httpStatus === 404 || !lookup.scan) {
      return res.status(404).json({
        ok: false,
        code: 'not_found',
        error: lookup.errorAr || 'لم يتم العثور على سجل الفحص المطلوب.'
      });
    }

    if (lookup.scan.status === 'queued') {
      const qIndex = scanQueue.findIndex(q => q.scanId === scanId);
      if (qIndex !== -1) {
        const currentPos = qIndex + 1;
        lookup.scan.queuePosition = currentPos;
        lookup.scan.stageDetail = `انت رقم ${currentPos} في الدور — هيبدأ الفحص تلقائياً أول ما يفضى مكان.`;
      }
    }

    return res.status(200).json({
      ok: true,
      scan: lookup.scan
    });
  }));

  // 4a. Cancel In-Flight Scan (H2.5: validate id and check ownership BEFORE aborting controller)
  app.post('/api/scans/:id/cancel', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const scanId = (req.params.id || '').trim();

    if (!scanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(scanId)) {
      return res.status(404).json({
        ok: false,
        error: 'معرّف الفحص غير صالح.'
      });
    }

    const queuedIdx = scanQueue.findIndex(q => q.scanId === scanId);
    if (queuedIdx !== -1) {
      scanQueue.splice(queuedIdx, 1);
      updateQueuePositions();
      store.releaseReservation(scanId);
      const cancelled = store.cancelJob(scanId, visitorId);
      const quota = store.getQuotaStatus({ visitorId }, cancelled.job?.registrableDomain);
      return res.status(200).json({
        ok: true,
        scan: cancelled.job,
        quota
      });
    }

    const cancelled = store.cancelJob(scanId, visitorId);
    if (!cancelled.ok || cancelled.notFound || cancelled.gone) {
      return res.status(cancelled.status || 404).json({
        ok: false,
        code: cancelled.gone ? 'gone' : 'not_found',
        error: cancelled.errorAr || 'لم يتم العثور على الفحص المطلوب لإلغائه.'
      });
    }

    const ctrl = activeScanControllers.get(scanId);
    if (ctrl) {
      ctrl.abort();
      activeScanControllers.delete(scanId);
    }
    store.releaseConcurrentScanSlot(scanId);
    advanceQueue();

    const quota = store.getQuotaStatus({ visitorId }, cancelled.job?.registrableDomain);
    return res.status(200).json({
      ok: true,
      scan: cancelled.job,
      quota
    });
  }));

  // 4b. Delete Private Report (H2.5: validate id and check ownership BEFORE aborting controller)
  app.delete('/api/scans/:id', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const scanId = (req.params.id || '').trim();

    if (!scanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(scanId)) {
      return res.status(404).json({
        ok: false,
        error: 'معرّف الفحص غير صالح.'
      });
    }

    const del = store.deleteReportForVisitor(scanId, visitorId);
    if (del.forbidden || del.gone || !del.deleted) {
      return res.status(del.status || 404).json({
        ok: false,
        code: del.gone ? 'gone' : 'not_found',
        error: del.errorAr || 'لم يتم العثور على التقرير المطلوب.'
      });
    }

    const ctrl = activeScanControllers.get(scanId);
    if (ctrl) {
      ctrl.abort();
      activeScanControllers.delete(scanId);
    }

    return res.json({
      ok: true,
      deleted: del.deleted
    });
  }));

  // 4c. Finding Accuracy Feedback 👍/👎 (H4: Zod caps, visitor ownership, finding existence, server-derived ruleId/domain)
  const feedbackBodySchema = z
    .object({
      scanId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      findingId: z.string().min(1).max(128),
      vote: z.enum(['up', 'down']),
      fingerprint: z.string().max(256).optional(),
      ruleId: z.string().max(64).optional(),
      rulesetVersion: z.string().max(32).optional(),
      domain: z.string().max(256).optional()
    })
    .strip();

  app.post('/api/feedback', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const parsed = feedbackBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        ok: false,
        error: issue?.message || 'بيانات التقييم غير صالحة أو ناقصة.'
      });
    }

    const { scanId, findingId, vote, fingerprint } = parsed.data;
    const outcome = store.submitFeedback({
      scanId,
      findingId,
      vote,
      visitorId,
      fingerprint
    });

    if (!outcome.ok) {
      return res.status(outcome.status || 400).json({
        ok: false,
        error: outcome.errorAr
      });
    }

    return res.status(200).json({
      ok: true,
      feedback: outcome.feedback
    });
  }));

  // B4.2 & B4.3: In-report rating card feedback (1-5 stars, reason chips, optional redacted comment)
  const reportFeedbackBodySchema = z
    .object({
      scanId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      stars: z.number().int().min(1).max(5),
      reasons: z.array(z.string().max(50)).max(10).optional(),
      comment: z.string().max(300).optional()
    })
    .strip();

  app.post('/api/feedback/report', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const parsed = reportFeedbackBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        ok: false,
        error: issue?.message || 'بيانات التقييم غير صالحة أو ناقصة.'
      });
    }

    const { scanId, stars, reasons, comment } = parsed.data;
    const outcome = store.saveReportFeedback({
      scanId,
      visitorId,
      stars,
      reasons,
      comment
    });

    if (!outcome.ok) {
      return res.status(outcome.status || 400).json({
        ok: false,
        error: outcome.errorAr
      });
    }

    return res.status(200).json({
      ok: true,
      feedback: outcome.feedback
    });
  }));

  // B4.2 & B4.3: Finding feedback with optional reasons array
  const findingFeedbackBodySchema = z
    .object({
      scanId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
      findingId: z.string().min(1).max(128),
      vote: z.enum(['up', 'down']),
      reasons: z.array(z.string().max(50)).max(10).optional(),
      fingerprint: z.string().max(256).optional()
    })
    .strip();

  app.post('/api/feedback/finding', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const parsed = findingFeedbackBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        ok: false,
        error: issue?.message || 'بيانات التقييم غير صالحة أو ناقصة.'
      });
    }

    const { scanId, findingId, vote, reasons, fingerprint } = parsed.data;
    const outcome = store.saveFindingFeedback({
      scanId,
      findingId,
      vote,
      reasons,
      visitorId,
      fingerprint
    });

    if (!outcome.ok) {
      return res.status(outcome.status || 400).json({
        ok: false,
        error: outcome.errorAr
      });
    }

    return res.status(200).json({
      ok: true,
      feedback: outcome.feedback
    });
  }));

  // B4.4: Read-only admin verification helper (constant-time comparison, minimum 32 chars)
  function verifyAdminBearer(req: express.Request): boolean {
    const adminToken = (process.env.ADMIN_TOKEN || '').trim();
    if (!adminToken || adminToken.length < 32) {
      return false;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }
    const token = authHeader.slice(7).trim();
    const tokenBuf = Buffer.from(token);
    const adminBuf = Buffer.from(adminToken);
    if (tokenBuf.length !== adminBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(tokenBuf, adminBuf);
  }

  // B4.4: Admin JSON Feedback Overview
  app.get('/api/admin/feedback', safeRoute((req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store, private');

    const clientIp = getClientIp(req);
    const rl = store.checkEndpointRateLimit(clientIp, 'scan', 60);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: rl.messageAr });
    }

    if (!verifyAdminBearer(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized: valid Bearer ADMIN_TOKEN (>=32 chars) required'
      });
    }

    const overview = store.getAdminFeedbackOverview();
    return res.json({
      ok: true,
      overview
    });
  }));

  // B4.4: Admin CSV Feedback Export
  app.get('/api/admin/feedback/export.csv', safeRoute((req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store, private');

    if (!verifyAdminBearer(req)) {
      return res.status(401).send('Unauthorized');
    }

    const overview = store.getAdminFeedbackOverview();
    const rows = [
      ['scanId', 'domain', 'stars', 'commentRedacted', 'createdAt']
    ];
    for (const c of overview.recentComments) {
      rows.push([
        c.scanId,
        c.domain,
        String(c.stars),
        `"${(c.commentRedacted || '').replace(/"/g, '""')}"`,
        c.createdAt
      ]);
    }
    const csvContent = rows.map(r => r.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="madam-afaf-feedback.csv"');
    return res.send(csvContent);
  }));

  // B4.4: Admin Read-Only Dashboard HTML View
  app.get('/admin', safeRoute((req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store, private');

    if (!verifyAdminBearer(req)) {
      return res.status(401).send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex, nofollow">
  <title>لوحة الإدارة — غير مصرح</title>
  <style>body{font-family:sans-serif;background:#FAF5EC;color:#231C16;padding:40px;text-align:center;}</style>
</head>
<body>
  <h1>غير مصرح بالدخول</h1>
  <p>لوحة التحكم تتطلب Bearer ADMIN_TOKEN (32 حرف على الأقل).</p>
</body>
</html>`);
    }

    const overview = store.getAdminFeedbackOverview();
    return res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex, nofollow">
  <title>لوحة تحكم مدام عفاف — التقييمات والملاحظات</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #FAF5EC; color: #231C16; padding: 24px; max-width: 900px; margin: 0 auto; }
    .card { background: #FFFFFF; border: 1px solid #DDD2C0; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(35,28,22,.08); }
    h1, h2 { color: #0B5D5E; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #DDD2C0; padding: 8px 12px; text-align: start; }
    th { background: #F1E9DB; }
    .badge-flagged { background: #FDE8E6; color: #8E1B12; font-weight: bold; padding: 2px 6px; border-radius: 4px; }
    .btn { display: inline-block; background: #0B5D5E; color: #fff; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; }
  </style>
</head>
<body>
  <h1>لوحة تقييمات وملاحظات مدام عفاف (قراءة فقط)</h1>
  <div class="card">
    <h2>ملخص التقييمات</h2>
    <p>إجمالي التقييمات: <strong>${overview.totalReportRatings}</strong> | متوسط النجوم: <strong>${overview.averageStars} / 5</strong></p>
    <a href="/api/admin/feedback/export.csv" class="btn">تصدير CSV</a>
  </div>
  <div class="card">
    <h2>إحصائيات القواعد (الدقة ونسب التوافق)</h2>
    <table>
      <thead>
        <tr><th>القاعدة</th><th>إجمالي الأصوات</th><th>👍 مع</th><th>👎 ضد</th><th>نسبة التوافق</th><th>تنبيه</th></tr>
      </thead>
      <tbody>
        ${overview.ruleStats.map(r => `<tr>
          <td><code>${r.ruleId}</code></td>
          <td>${r.totalVotes}</td>
          <td>${r.upVotes}</td>
          <td>${r.downVotes}</td>
          <td>${r.totalVotes >= 10 ? `${(r.agreementRatio * 100).toFixed(0)}%` : '— (أقل من 10)'}</td>
          <td>${r.flagged ? '<span class="badge-flagged">ملاحظات سلبية متكررة (3+ زوار)</span>' : 'سليم'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`);
  }));

  // 4d. Create Share Token (H4: 128-bit token stored hashed with 7-day expiry)
  app.post('/api/scans/:id/share', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const scanId = (req.params.id || '').trim();

    if (!scanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(scanId)) {
      return res.status(404).json({
        ok: false,
        error: 'معرّف الفحص غير صالح.'
      });
    }

    const share = store.createShareToken(scanId, visitorId);
    if (!share.ok) {
      return res.status(share.status || 404).json({
        ok: false,
        error: share.errorAr
      });
    }

    return res.status(200).json({
      ok: true,
      shareToken: share.shareToken,
      shareId: share.shareId,
      shareUrl: share.shareUrl,
      expiresAt: share.expiresAt,
      expiresAtMs: share.expiresAtMs
    });
  }));

  // 4d-revoke. Revoke Share Token (H4: DELETE /api/scans/:id/share -> subsequent GET returns 410 'revoked')
  app.delete('/api/scans/:id/share', safeRoute((req, res) => {
    const visitorId = getVisitorId(req, res);
    const scanId = (req.params.id || '').trim();

    if (!scanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(scanId)) {
      return res.status(404).json({
        ok: false,
        error: 'معرّف الفحص غير صالح.'
      });
    }

    const revoked = store.revokeShareForScan(scanId, visitorId);
    if (!revoked.ok) {
      return res.status(revoked.status || 404).json({
        ok: false,
        error: revoked.errorAr
      });
    }

    return res.status(200).json({
      ok: true,
      revoked: true,
      revokedCount: revoked.revokedCount
    });
  }));

  // 4e. Missing Share Token in GET /api/share
  app.get('/api/share', (_req, res) => {
    return res.status(400).json({
      ok: false,
      code: 'missing_token',
      error: 'رمز المشاركة مطلوب في الرابط (مثال: /api/share/token_xxx).'
    });
  });

  // 4f. View Shared Report (H4: Allowlist DTO, Cache-Control: no-store, X-Robots-Tag, rate-limited)
  app.get('/api/share/:token', safeRoute((req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');

    const clientIp = getClientIp(req);
    const rl = store.checkEndpointRateLimit(clientIp, 'share');
    if (!rl.allowed) {
      return res.status(429).json({
        ok: false,
        error: rl.messageAr
      });
    }

    const token = (req.params.token || '').trim();
    if (!token || !/^[a-zA-Z0-9_-]{4,64}$/.test(token)) {
      return res.status(404).json({
        ok: false,
        code: 'not_found',
        error: 'رابط المشاركة غير صالح أو غير موجود.'
      });
    }

    const lookup = store.getSharedReport(token);
    if (!lookup.ok) {
      return res.status(lookup.status || 404).json({
        ok: false,
        code: lookup.code,
        error: lookup.errorAr
      });
    }

    return res.status(200).json({
      ok: true,
      report: lookup.result,
      expiresAtMs: lookup.expiresAtMs
    });
  }));

  // 5. Interactive Chat with Madam Afaf (H2.4: Zod validation for message, context, and history)
  const chatMessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
    timestamp: z.string().optional()
  });

  const chatFindingSummarySchema = z.object({
    ruleId: z.string().max(100),
    category: z.string().max(100),
    severity: z.string().max(50),
    titleAr: z.string().max(500),
    url: z.string().max(2048),
    recommendedFix: z.string().max(2000).optional()
  });

  const chatContextSchema = z.object({
    url: z.string().max(2048).optional(),
    domain: z.string().max(256).optional(),
    findingId: z.string().max(100).optional(),
    findingTitle: z.string().max(500).optional(),
    findingsSummary: z.string().max(5000).optional(),
    masterRepairPrompt: z.string().max(10000).optional(),
    verdictLabelAr: z.string().max(256).optional(),
    pagesCount: z.number().optional(),
    pagesUrls: z.array(z.string().max(2048)).max(50).optional(),
    topFindings: z.array(chatFindingSummarySchema).max(50).optional(),
    notMeasuredTitles: z.array(z.string().max(500)).max(50).optional()
  }).optional();

  const chatRequestBodySchema = z.object({
    scanId: z.string().max(64).optional(),
    message: z.string().min(1, 'اكتب سؤالك الأول لمدام عفاف.').max(2000, 'سؤالك طويل جداً (الحد الأقصى 2000 حرف).'),
    context: z.any().optional(),
    scanResult: z.any().optional(),
    history: z.array(chatMessageSchema).max(50).optional(),
    stream: z.boolean().optional()
  });

  app.post(['/api/chat', '/api/chat-afaf'], safeRoute(async (req, res) => {
    const clientIp = getClientIp(req);
    const rl = store.checkEndpointRateLimit(clientIp, 'chat');
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: rl.messageAr });
    }

    const chatValidation = chatRequestBodySchema.safeParse(req.body || {});
    if (!chatValidation.success) {
      const issue = chatValidation.error.issues[0];
      return res.status(400).json({
        ok: false,
        error: issue?.message || 'بيانات المحادثة غير صالحة.'
      });
    }

    const visitorId = getVisitorId(req, res);
    const { message, scanId, history, stream } = chatValidation.data;

    let serverContext: any = undefined;
    let targetReport: any = null;

    if (scanId) {
      const cleanScanId = scanId.trim();
      if (!/^[a-zA-Z0-9_-]{4,64}$/.test(cleanScanId)) {
        return res.status(404).json({
          ok: false,
          code: 'not_found',
          error: 'معرّف الفحص غير صالح أو غير موجود.'
        });
      }

      const lookup = store.getScanStatusForVisitor(cleanScanId, visitorId);
      if (lookup.httpStatus === 410) {
        return res.status(410).json({
          ok: false,
          code: 'gone',
          reason: lookup.reason,
          error: lookup.errorAr
        });
      }
      if (lookup.httpStatus === 404 || !lookup.scan) {
        return res.status(404).json({
          ok: false,
          code: 'not_found',
          error: 'لم يتم العثور على سجل الفحص المطلوب.'
        });
      }
      if (lookup.scan.result) {
        targetReport = lookup.scan.result;
        serverContext = buildContextFromScanResult(targetReport);
      } else if (chatValidation.data.scanResult) {
        targetReport = chatValidation.data.scanResult;
        serverContext = buildContextFromScanResult(targetReport);
      } else if (chatValidation.data.context) {
        serverContext = chatValidation.data.context;
      }
    } else if (chatValidation.data.scanResult) {
      targetReport = chatValidation.data.scanResult;
      serverContext = buildContextFromScanResult(targetReport);
    } else if (chatValidation.data.context) {
      serverContext = chatValidation.data.context;
    }

    const wantsSse =
      Boolean(stream) ||
      String(req.headers.accept || '')
        .toLowerCase()
        .includes('text/event-stream');

    const sendChatPayload = (payload: {
      ok: boolean;
      reply: string;
      action?: 'needs_url' | 'trigger_scan' | 'allow_chat';
      targetUrl?: string;
    }) => {
      if (!wantsSse) {
        return res.json(payload);
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const words = payload.reply.split(/(\s+)/);
      const chunkStep = Math.max(2, Math.ceil(words.length / 4));
      for (let i = 0; i < words.length; i += chunkStep) {
        const delta = words.slice(i, i + chunkStep).join('');
        if (delta) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', delta })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ type: 'done', ...payload })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    };

    try {
      const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
      const gateDecision = evaluateChatGatekeeper(message, serverContext, safeHistory);
      if (gateDecision.action === 'trigger_scan' && gateDecision.targetUrl) {
        return sendChatPayload({
          ok: true,
          reply: gateDecision.replyAr || `من عينيا، هراجع الموقع (${gateDecision.targetUrl}) فوراً بالدليل...`,
          action: 'trigger_scan',
          targetUrl: gateDecision.targetUrl
        });
      }
      if (gateDecision.action === 'needs_url') {
        return sendChatPayload({
          ok: true,
          reply:
            gateDecision.replyAr ||
            'أنت لسه ما ضفتش موقع عشان أفحصهولك، ابعتلي لينك الموقع هنا في الشات أو ضيفه في خانة الفحص وأنا أراجعهولك فوراً.',
          action: 'needs_url'
        });
      }

      const rawReply = await askMadamAfaf(message, serverContext, safeHistory);

      // Post-validation: reject or sanitize hallucinated findings or missing metrics
      const validated = validateChatReplyAgainstReport(rawReply, targetReport);

      return sendChatPayload({
        ok: true,
        reply: validated.reply,
        action: 'allow_chat'
      });
    } catch {
      res.status(500).json({
        ok: false,
        error: 'مدام عفاف مشغولة ثانية واحدة، جرب تبعت السؤال تاني.'
      });
    }
  }));

  // 5b. Voice Gemini Live Token Minter (K0.7: gated behind VOICE_LIVE_ENABLED)
  app.post('/api/voice/token', safeRoute((req, res) => {
    const clientIp = getClientIp(req);
    const rl = store.checkEndpointRateLimit(clientIp, 'tts');
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: rl.messageAr });
    }

    const liveEnabled = process.env.VOICE_LIVE_ENABLED === 'true';
    const liveModel = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

    if (!liveEnabled) {
      return res.status(200).json({
        ok: true,
        enabled: false,
        fallback: 'stt_tts',
        model: liveModel,
        messageAr: 'خدمة البث الصوتي المباشر Live API غير مفعّلة حالياً، بنستخدم التسجيل وتحويل الصوت العادي.'
      });
    }

    const ephemeralToken = `live_${crypto.randomBytes(24).toString('hex')}`;
    return res.status(200).json({
      ok: true,
      enabled: true,
      token: ephemeralToken,
      model: liveModel,
      maxSessionSeconds: 300,
      expiresAt: new Date(Date.now() + 300000).toISOString()
    });
  }));

  // 6. Madam Afaf Voice TTS Endpoint (G2.5: 20/h per IP rate limit)
  app.post('/api/tts', safeRoute(async (req, res) => {
    const clientIp = getClientIp(req);
    const rl = store.checkEndpointRateLimit(clientIp, 'tts');
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: rl.messageAr });
    }

    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'النص مطلوب لتحويله لصوت.' });
    }

    try {
      const speech = await synthesizeMadamSpeechWithMime(text);
      if (!speech) {
        return res.json({ ok: false, fallbackToBrowser: true });
      }
      return res.json({
        ok: true,
        audioBase64: speech.audioBase64,
        mimeType: speech.mimeType
      });
    } catch {
      return res.json({ ok: false, fallbackToBrowser: true });
    }
  }));

  // 7. Voice Audio Transcription Endpoint (H2.4: mime allowlist + decoded size cap)
  const AUDIO_MIME_ALLOWLIST = new Set([
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/ogg',
    'audio/ogg;codecs=opus',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac'
  ]);

  app.post('/api/transcribe', safeRoute(async (req, res) => {
    const clientIp = getClientIp(req);
    const rl = store.checkEndpointRateLimit(clientIp, 'transcribe');
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: rl.messageAr });
    }

    const { audioBase64, mimeType } = req.body || {};
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ ok: false, error: 'ملف الصوت غير موجود.' });
    }

    const cleanMime = (mimeType || 'audio/webm').toLowerCase().trim();
    const baseMime = cleanMime.split(';')[0].trim();
    if (!AUDIO_MIME_ALLOWLIST.has(cleanMime) && !AUDIO_MIME_ALLOWLIST.has(baseMime) && !baseMime.startsWith('audio/')) {
      return res.status(400).json({ ok: false, error: 'نوع الملف الصوتي غير مدعوم.' });
    }

    // Decoded size cap: maximum 4.0MB
    const byteLength = Buffer.byteLength(audioBase64, 'base64');
    if (byteLength > 4 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'حجم الملف الصوتي كبير جداً (الحد الأقصى 4 ميجابايت).' });
    }

    try {
      const text = await transcribeUserAudio(audioBase64, cleanMime);
      if (!text) {
        return res.json({ ok: false, error: 'مسمعتش الصوت بوضوح، جرب تتكلم تاني.' });
      }
      return res.json({ ok: true, text });
    } catch {
      return res.json({ ok: false, error: 'تعذر تحويل الصوت لنص حالياً.' });
    }
  }));

  // 8. Catch-all for any unhandled /api/* route: ALWAYS return JSON 404, never fall through to HTML/Vite
  app.all('/api/*', (req, res) => {
    return res.status(404).json({
      ok: false,
      code: 'endpoint_not_found',
      error: `نقطة الاتصال (${req.method} ${req.path}) غير موجودة في واجهة برمجة التطبيقات.`
    });
  });

  // H2.4 & K2.6: Fail-safe error handling middleware (never leaks stack traces or internal errors; returns 503 on store/system failure)
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      res.setHeader('Connection', 'close');
      req.resume();
      return res.status(413).json({
        ok: false,
        code: 'payload_too_large',
        error: 'حجم البيانات المرسلة كبير جداً.'
      });
    }

    if (err instanceof SyntaxError && (err as any).status === 400) {
      return res.status(400).json({
        ok: false,
        code: 'bad_json',
        error: 'صيغة البيانات المرسلة غير صالحة.'
      });
    }

    const status = err instanceof ExternalServiceError ? err.status : 503;
    const safeErrorAr =
      err instanceof ExternalServiceError
        ? err.safeMessageAr
        : 'الخدمة غير متاحة مؤقتاً بسبب عطل في التخزين أو النظام، جرب تاني بعد ثواني.';

    return res.status(status).json({
      ok: false,
      code: 'service_unavailable',
      error: safeErrorAr
    });
  });

  return app;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // C3: Ensure runtime VISITOR_ID_SALT in Cloud Run production if unset, then validate (>= 32 chars)
  const { provisionedEphemeral } = ensureRuntimeVisitorIdSalt();
  if (provisionedEphemeral) {
    console.warn(
      '[Madam Afaf Server] VISITOR_ID_SALT was not set (>=32 chars) in production environment; generated ephemeral runtime salt for this instance.'
    );
  }
  validateVisitorIdSalt();

  const app = createApiApp();

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        fs: {
          deny: ['**/data/**', '**/.env*']
        }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(AppConfig.PORT, '0.0.0.0', () => {
    console.log(`Madam Afaf Server running on http://localhost:${AppConfig.PORT} [mode=${AppConfig.SCAN_MODE}]`);
    console.log(getStartupPsiLogLine());
    const configReport = buildConfigCheckReport();
    console.log(configReport.formattedText);
  });
}

// H2.6: Crash safety handlers for unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Madam Afaf Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', err => {
  console.error('[Madam Afaf Server] Uncaught Exception:', err);
});

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  startServer();
}
