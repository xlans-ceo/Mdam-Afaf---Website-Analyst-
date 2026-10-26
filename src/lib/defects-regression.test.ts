import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAN_LIMITS, BOT_USER_AGENT } from '../config/limits.server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
import {
  isRestrictedIp,
  validateSsrfUrl,
  safeFetchHtmlWithSsrf
} from './ssrf-validator';
import { detectSiteStatus } from './site-status';
import {
  LiveProvider,
  ScannerProvider,
  mergeMultiPageFindings,
  classifySubpageHttpStatus,
  scanPublicSpaJsForSecrets,
  computeFindingFingerprint
} from './providers';
import { runHonestChecks, evaluateAiClaims, computeVerdict } from './honest-checks';
import { discoverSitePages, parseRobotsTxt, isDisallowedByRobots } from './page-discovery';
import { buildSiteProfile } from './site-profiler';
import { getRegistrableDomain, isSameRegistrableDomain } from './domain-parser';
import { PersistentStore, hashVisitorId } from './storage';
import { createApiApp } from '../../server';
import { Finding } from '../types/contract';
import {
  extractUrlFromMessage,
  normalizeUserDomainOrUrl,
  validateAndNormalizeUrl
} from './url-gatekeeper';
import {
  StorageLike,
  saveActiveScanSession,
  loadActiveScanSession,
  clearActiveScanSession,
  computePollBackoffMs,
  toRecentScanSummary,
  saveRecentScanSummaryToStorage,
  loadRecentScanSummariesFromStorage
} from './scan-lifecycle';

async function withLocalServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

// ============================================================================
// PHASE G1: NETWORK LAYER (security and time)
// ============================================================================
test('G1.1: image HEAD uses safe outbound function and does not bypass SSRF protection', async () => {
  const headHits: string[] = [];
  await withLocalServer(
    (req, res) => {
      const url = req.url || '/';
      if (req.method === 'HEAD') {
        headHits.push(url);
        if (url === '/fixtures/redirect-img.jpg') {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '650000' });
        res.end();
        return;
      }
      if (url === '/fixtures/home') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>اختبار</title></head><body>
          <h1>صفحة اختبار الصور</h1>
          <p>${'محتوى تجريبي لفحص الصور بأمان '.repeat(20)}</p>
          <img src="http://169.254.169.254/latest/meta-data/iam" alt="ssrf1" />
          <img src="http://127.0.0.1:22/non-fixture.jpg" alt="ssrf2" />
          <img src="/fixtures/valid-img.jpg" alt="صورة سليمة" />
          <img src="/fixtures/redirect-img.jpg" alt="صورة بتحويل" />
        </body></html>`);
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const result = await provider.runScan(
        'test_g1_1_img_ssrf',
        { url: `${baseUrl}/fixtures/home`, locale: 'ar-EG' },
        () => {}
      );
      assert.equal(result.siteStatus?.state, 'ok');
      assert.ok(headHits.includes('/fixtures/valid-img.jpg'));
      assert.ok(!headHits.some(u => u.includes('non-fixture')));
    }
  );
});

test('G1.1: custom lookup rejects DNS TOCTOU rebinding from public to private IP', async () => {
  let callCount = 0;
  const res = await safeFetchHtmlWithSsrf('http://rebind.example.com/', {
    timeoutMs: 2000,
    lookupFn: async () => {
      callCount++;
      if (callCount === 1) {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    }
  });
  assert.equal(res.ok, false);
  assert.equal(callCount, 2);
  assert.match(res.errorReasonAr || '', /DNS Rebinding|محظورة/);
});

test('G1.1: non-standard ports 22 and 6379 are blocked by port allowlist', async () => {
  const sshCheck = await validateSsrfUrl('http://93.184.216.34:22/');
  const redisCheck = await validateSsrfUrl('http://93.184.216.34:6379/');
  const http8080Check = await validateSsrfUrl('http://93.184.216.34:8080/');
  const https8443Check = await validateSsrfUrl('https://93.184.216.34:8443/');

  assert.equal(sshCheck.valid, false);
  assert.equal(redisCheck.valid, false);
  assert.equal(http8080Check.valid, true);
  assert.equal(https8443Check.valid, true);
});

test('G1.1: extended IP checks block IPv4-mapped IPv6 in hex, NAT64, 6to4, and 2001:db8::/32', () => {
  // IPv4-mapped IPv6 in hex
  assert.equal(isRestrictedIp('::ffff:7f00:1'), true);
  assert.equal(isRestrictedIp('::ffff:7f00:0001'), true);
  assert.equal(isRestrictedIp('0:0:0:0:0:ffff:a9fe:a9fe'), true);
  assert.equal(isRestrictedIp('::ffff:a00:1'), true);
  assert.equal(isRestrictedIp('::ffff:c0a8:1'), true);
  // Public IPv4-mapped IPv6 in hex (93.184.216.34 = 5db8:d822)
  assert.equal(isRestrictedIp('::ffff:5db8:d822'), false);
  // NAT64 64:ff9b::/96
  assert.equal(isRestrictedIp('64:ff9b::127.0.0.1'), true);
  assert.equal(isRestrictedIp('64:ff9b::7f00:1'), true);
  // 6to4 2002::/16
  assert.equal(isRestrictedIp('2002:7f00:0001::1'), true);
  // Documentation 2001:db8::/32
  assert.equal(isRestrictedIp('2001:db8::1'), true);
  assert.equal(isRestrictedIp('2001:0db8:85a3::8a2e:370:7334'), true);
  // Public IPv6
  assert.equal(isRestrictedIp('2606:4700:4700::1111'), false);
});

test('G1.1: DNS resolution enforces 3s timeout', async () => {
  assert.equal(SCAN_LIMITS.DNS_TIMEOUT_MS, 3000);
  const start = Date.now();
  const check = await validateSsrfUrl('https://hanging-dns.example.com/', {
    dnsTimeoutMs: 120,
    lookupFn: () => new Promise(() => {})
  });
  const elapsed = Date.now() - start;
  assert.equal(check.valid, false);
  assert.ok(elapsed < 600, `Expected DNS timeout under 600ms, got ${elapsed}ms`);
  assert.match(check.reasonAr || '', /DNS/);
});

test('G1.2: response stream enforces hard byte cap and aborts socket exceeding maxBytes', async () => {
  let bytesSentByServer = 0;
  await withLocalServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const chunk = Buffer.alloc(32 * 1024, 'A');
      const interval = setInterval(() => {
        if (res.destroyed || req.destroyed) {
          clearInterval(interval);
          return;
        }
        bytesSentByServer += chunk.length;
        res.write(chunk);
        if (bytesSentByServer >= 10 * 1024 * 1024) {
          clearInterval(interval);
          res.end();
        }
      }, 2);
      res.on('close', () => clearInterval(interval));
    },
    async baseUrl => {
      const cap = 128 * 1024;
      const res = await safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/huge`, {
        maxBytes: cap,
        timeoutMs: 3000,
        allowLocalFixtures: true
      });
      assert.equal(res.abortedByMaxBytes, true);
      assert.equal(res.htmlBytes, cap);
      assert.ok(
        bytesSentByServer < 2 * 1024 * 1024,
        `Server should abort early instead of streaming 10MB (sent ${bytesSentByServer})`
      );
    }
  );
});

test('G1.2: stalled body stream aborts on request deadline without clearing timer on headers', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write('<!DOCTYPE html><html><body>partial content...');
      // Never ends body
    },
    async baseUrl => {
      const start = Date.now();
      const res = await safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/stalled`, {
        timeoutMs: 200,
        allowLocalFixtures: true
      });
      const elapsed = Date.now() - start;
      assert.equal(res.ok, false);
      assert.equal(res.timedOut, true);
      assert.ok(elapsed < 700, `Expected stalled body to abort in ~200ms, got ${elapsed}ms`);
    }
  );
});

test('G1.2: outbound fetch accepts and honors AbortSignal', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write('<html><body>waiting...');
    },
    async baseUrl => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 80);
      const start = Date.now();
      const res = await safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/abort`, {
        timeoutMs: 5000,
        allowLocalFixtures: true,
        signal: ctrl.signal
      });
      const elapsed = Date.now() - start;
      assert.equal(res.ok, false);
      assert.equal(res.aborted, true);
      assert.ok(elapsed < 500, `Expected abort in ~80ms, got ${elapsed}ms`);
    }
  );
});

test('G1.3: BOT_USER_AGENT constant MadamAfafBot/2.0 (+<APP_URL>) used consistently', async () => {
  assert.match(BOT_USER_AGENT, /^MadamAfafBot\/2\.0 \(\+https?:\/\//);
  let seenUserAgent = '';
  await withLocalServer(
    (req, res) => {
      seenUserAgent = String(req.headers['user-agent'] || '');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    },
    async baseUrl => {
      await safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/ua`, { allowLocalFixtures: true });
    }
  );
  assert.equal(seenUserAgent, BOT_USER_AGENT);

  const wafStatus = detectSiteStatus({
    requestedUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    status: 403,
    headers: { 'content-type': 'text/html', server: 'cloudflare' },
    html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'
  });
  assert.ok(wafStatus.whatToDoAr.includes(BOT_USER_AGENT));
});

test('G1.4: ScanContext enforces SCAN_TIMEOUT_S=90 deadline across entire scan', async () => {
  assert.equal(SCAN_LIMITS.SCAN_TIMEOUT_S, 90);
  await withLocalServer(
    (req, res) => {
      const url = req.url || '/';
      if (url === '/fixtures/home') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="ar"><head><title>الرئيسية</title></head><body>
          <nav><a href="/fixtures/slow1">صفحة 1</a><a href="/fixtures/slow2">صفحة 2</a></nav>
          <h1>الرئيسية</h1><p>${'نص طويل '.repeat(30)}</p>
        </body></html>`);
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>slow</body></html>');
      }, 2000);
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const start = Date.now();
      const result = await provider.runScan(
        'test_g1_4_deadline',
        { url: `${baseUrl}/fixtures/home`, locale: 'ar-EG' },
        () => {},
        { scanTimeoutMs: 300 }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 900, `Expected scan to respect 300ms budget, took ${elapsed}ms`);
      assert.equal(result.status, 'partial');
    }
  );
});

test('G1.4: discovered subpages are fetched with max concurrency of 3', async () => {
  let activeSubRequests = 0;
  let maxObservedConcurrency = 0;

  await withLocalServer(
    (req, res) => {
      const url = req.url || '/';
      if (url === '/fixtures/home') {
        const links = Array.from(
          { length: 6 },
          (_, i) => `<a href="/fixtures/sub-${i + 1}">صفحة ${i + 1}</a>`
        ).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="ar"><head><title>الرئيسية</title></head><body>
          <nav>${links}</nav><h1>الرئيسية</h1><p>${'محتوى كافي للفحص '.repeat(25)}</p>
        </body></html>`);
        return;
      }
      if (url.startsWith('/fixtures/sub-')) {
        activeSubRequests++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeSubRequests);
        setTimeout(() => {
          activeSubRequests--;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html lang="ar"><head><title>${url}</title></head><body><h1>${url}</h1><p>${'محتوى '.repeat(20)}</p></body></html>`);
        }, 320);
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const result = await provider.runScan(
        'test_g1_4_concurrency',
        { url: `${baseUrl}/fixtures/home`, locale: 'ar-EG' },
        () => {}
      );
      assert.equal(result.pages.length, 7);
      assert.ok(
        maxObservedConcurrency <= SCAN_LIMITS.PAGE_CONCURRENCY,
        `Expected max concurrency <= 3, got ${maxObservedConcurrency}`
      );
      assert.ok(
        maxObservedConcurrency >= 2,
        `Expected concurrent subpage fetching (>=2), got ${maxObservedConcurrency}`
      );
    }
  );
});

test('G1.4: PSI is started in parallel early with PSI_TIMEOUT_S=25 and never delays report past budget', async () => {
  assert.equal(SCAN_LIMITS.PSI_TIMEOUT_S, 25);
  await withLocalServer(
    (req, res) => {
      const url = req.url || '/';
      if (url === '/fixtures/home') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="ar"><head><title>الرئيسية</title></head><body>
          <h1>الرئيسية</h1><p>${'محتوى كافي للفحص '.repeat(25)}</p>
        </body></html>`);
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const start = Date.now();
      const result = await provider.runScan(
        'test_g1_4_psi',
        { url: `${baseUrl}/fixtures/home`, locale: 'ar-EG' },
        () => {},
        {
          psiTimeoutMs: 120,
          psiFetcher: () => new Promise(resolve => setTimeout(() => resolve(null), 3000))
        }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 700, `Expected PSI timeout not to delay scan, took ${elapsed}ms`);
      assert.ok(
        result.notMeasured?.some(nm => nm.reasonAr === 'قياس السرعة ما خلصش في الوقت'),
        'Expected NOT_MEASURED entry for PSI timeout'
      );
    }
  );
});

test('G1.5: scan deadline returns partial result with unfinished pages marked NOT_MEASURED', async () => {
  await withLocalServer(
    (req, res) => {
      const url = req.url || '/';
      if (url === '/fixtures/home') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="ar"><head><title>الرئيسية</title></head><body>
          <nav>
            <a href="/fixtures/p1">1</a>
            <a href="/fixtures/p2">2</a>
            <a href="/fixtures/p3">3</a>
            <a href="/fixtures/p4">4</a>
          </nav>
          <h1>الرئيسية</h1><p>${'محتوى كافي للفحص '.repeat(25)}</p>
        </body></html>`);
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>slow page</body></html>');
      }, 400);
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const result = await provider.runScan(
        'test_g1_5_partial',
        { url: `${baseUrl}/fixtures/home`, locale: 'ar-EG' },
        () => {},
        { scanTimeoutMs: 200 }
      );
      assert.equal(result.status, 'partial');
      assert.ok(
        result.notMeasured?.some(nm => nm.reasonAr === 'ميزانية الوقت خلصت'),
        'Expected unfinished pages marked NOT_MEASURED with reason ميزانية الوقت خلصت'
      );
    }
  );
});


// ============================================================================
// PHASE G2: SCAN JOB LIFECYCLE AND SERVER SURFACE
// ============================================================================
function createTempStorePath(prefix: string): string {
  return path.join(os.tmpdir(), `madam_afaf_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

async function withApiServer(
  options: Parameters<typeof createApiApp>[0],
  fn: (apiBaseUrl: string) => Promise<void>
): Promise<void> {
  const app = createApiApp(options);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const apiBaseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(apiBaseUrl);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('G2.1: persisted job model tracks queued, running, completed, partial, failed, cancelled, interrupted', () => {
  const tmpFile = createTempStorePath('g2_1');
  try {
    const store = new PersistentStore(tmpFile);
    const visitor = { visitorId: 'v_test_visitor_1' };

    // 1. queued
    const job1 = store.createJob(visitor, {
      scanId: 'scan_lifecycle_1',
      requestedUrl: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      registrableDomain: 'example.com'
    });
    assert.equal(job1.status, 'queued');

    // 2. running
    store.updateJobProgress('scan_lifecycle_1', {
      status: 'running',
      currentStage: 'discovery',
      inspectedPagesCount: 3
    });
    assert.equal(store.getScanStatusForVisitor('scan_lifecycle_1', visitor.visitorId).scan?.status, 'running');

    // 3. completed & partial via saveScanReport
    store.saveScanReport(visitor, {
      schemaVersion: '2.0',
      scanId: 'scan_lifecycle_1',
      requestedUrl: 'https://example.com',
      registrableDomain: 'example.com',
      status: 'completed',
      startedAt: new Date().toISOString(),
      limits: { maxPages: 10, maxLighthousePages: 3 },
      pages: [],
      uniquePagesInspected: 3,
      interactionStatesTested: 3,
      findings: [],
      lighthouse: [],
      limitations: []
    });
    assert.equal(store.getScanStatusForVisitor('scan_lifecycle_1', visitor.visitorId).scan?.status, 'completed');

    store.saveScanReport(visitor, {
      schemaVersion: '2.0',
      scanId: 'scan_lifecycle_partial',
      requestedUrl: 'https://example.com',
      registrableDomain: 'example.com',
      status: 'partial',
      startedAt: new Date().toISOString(),
      limits: { maxPages: 10, maxLighthousePages: 3 },
      pages: [],
      uniquePagesInspected: 2,
      interactionStatesTested: 2,
      findings: [],
      lighthouse: [],
      limitations: []
    });
    assert.equal(store.getScanStatusForVisitor('scan_lifecycle_partial', visitor.visitorId).scan?.status, 'partial');

    // 4. failed
    store.createJob(visitor, {
      scanId: 'scan_lifecycle_failed',
      requestedUrl: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      registrableDomain: 'example.com'
    });
    store.failJob('scan_lifecycle_failed', 'خطأ تجريبي في الفحص', 'internal');
    assert.equal(store.getScanStatusForVisitor('scan_lifecycle_failed', visitor.visitorId).scan?.status, 'failed');

    // 5. cancelled
    store.createJob(visitor, {
      scanId: 'scan_lifecycle_cancelled',
      requestedUrl: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      registrableDomain: 'example.com'
    });
    store.cancelJob('scan_lifecycle_cancelled', visitor.visitorId);
    assert.equal(store.getScanStatusForVisitor('scan_lifecycle_cancelled', visitor.visitorId).scan?.status, 'cancelled');

    // 6. interrupted (persisted reload while running)
    store.createJob(visitor, {
      scanId: 'scan_lifecycle_interrupted',
      requestedUrl: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      registrableDomain: 'example.com'
    });
    store.updateJobProgress('scan_lifecycle_interrupted', { status: 'running' });

    const reloadedStore = new PersistentStore(tmpFile);
    assert.equal(
      reloadedStore.getScanStatusForVisitor('scan_lifecycle_interrupted', visitor.visitorId).scan?.status,
      'interrupted'
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.2: GET /api/scans/:id returns 200 with real error on failed jobs instead of 404', async () => {
  const tmpFile = createTempStorePath('g2_2_failed');
  try {
    const store = new PersistentStore(tmpFile);
    const failingProvider: ScannerProvider = {
      async runScan(scanId, _req, onEvent) {
        onEvent({
          type: 'error',
          code: 'internal',
          message: 'فشل تجريبي متعمد لاختبار ظهور الخطأ الحقيقي'
        });
        throw new Error('فشل تجريبي متعمد لاختبار ظهور الخطأ الحقيقي');
      }
    };

    await withApiServer({ store, provider: failingProvider, allowLocalFixtures: true }, async apiBase => {
      const cookie = 'madam_visitor=v_fail_owner_123';
      const postRes = await fetch(`${apiBase}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Visitor-Id': 'v_fail_owner_123' },
        body: JSON.stringify({ url: 'http://127.0.0.1:3000/fixtures/fail' })
      });
      const postData: any = await postRes.json();
      assert.equal(postRes.status, 200);
      assert.equal(postData.ok, true);

      await new Promise(r => setTimeout(r, 50));

      const getRes = await fetch(`${apiBase}/api/scans/${postData.scanId}`, {
        headers: { Cookie: cookie }
      });
      const getData: any = await getRes.json();
      assert.equal(getRes.status, 200, 'Failed job must return HTTP 200 instead of 404');
      assert.equal(getData.ok, true);
      assert.equal(getData.scan.status, 'failed');
      assert.match(getData.scan.errorMessage || '', /فشل تجريبي متعمد/);
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.2: GET /api/scans/:id returns 410 for expired/deleted tombstones and 404 for unknown/foreign', async () => {
  const tmpFile = createTempStorePath('g2_2_tombstone');
  try {
    const store = new PersistentStore(tmpFile);
    const ownerId = 'v_owner_abc';
    const foreignId = 'v_foreign_xyz';

    // Save 1 report to be deleted and 1 report that is already expired
    store.saveScanReport(
      { visitorId: ownerId },
      {
        schemaVersion: '2.0',
        scanId: 'scan_to_delete',
        requestedUrl: 'https://example.com',
        registrableDomain: 'example.com',
        status: 'completed',
        startedAt: new Date().toISOString(),
        limits: { maxPages: 10, maxLighthousePages: 3 },
        pages: [],
        uniquePagesInspected: 1,
        interactionStatesTested: 1,
        findings: [],
        lighthouse: [],
        limitations: []
      }
    );

    store.saveScanReport(
      { visitorId: ownerId },
      {
        schemaVersion: '2.0',
        scanId: 'scan_already_expired',
        requestedUrl: 'https://example.com',
        registrableDomain: 'example.com',
        status: 'completed',
        startedAt: new Date().toISOString(),
        limits: { maxPages: 10, maxLighthousePages: 3 },
        pages: [],
        uniquePagesInspected: 1,
        interactionStatesTested: 1,
        findings: [],
        lighthouse: [],
        limitations: []
      },
      { customExpiresAtMs: Date.now() - 1000 }
    );

    await withApiServer({ store }, async apiBase => {
      // 1. Foreign visitor trying to access owner's report -> 404
      const foreignRes = await fetch(`${apiBase}/api/scans/scan_to_delete`, {
        headers: { Cookie: `madam_visitor=${foreignId}` }
      });
      assert.equal(foreignRes.status, 404);

      // 2. Unknown scanId -> 404
      const unknownRes = await fetch(`${apiBase}/api/scans/scan_does_not_exist`, {
        headers: { Cookie: `madam_visitor=${ownerId}` }
      });
      assert.equal(unknownRes.status, 404);

      // 3. Owner deletes report -> subsequent GET returns 410 Gone
      const delRes = await fetch(`${apiBase}/api/scans/scan_to_delete`, {
        method: 'DELETE',
        headers: { Cookie: `madam_visitor=${ownerId}`, 'X-Visitor-Id': ownerId }
      });
      assert.equal(delRes.status, 200);

      const getDeletedRes = await fetch(`${apiBase}/api/scans/scan_to_delete`, {
        headers: { Cookie: `madam_visitor=${ownerId}` }
      });
      const deletedBody: any = await getDeletedRes.json();
      assert.equal(getDeletedRes.status, 410);
      assert.equal(deletedBody.reason, 'deleted');

      // 4. Expired report -> GET returns 410 Gone
      const getExpiredRes = await fetch(`${apiBase}/api/scans/scan_already_expired`, {
        headers: { Cookie: `madam_visitor=${ownerId}` }
      });
      const expiredBody: any = await getExpiredRes.json();
      assert.equal(getExpiredRes.status, 410);
      assert.equal(expiredBody.reason, 'expired');
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.3: POST /api/scans/:id/cancel immediately stops scan, marks cancelled, and releases lock', async () => {
  const tmpFile = createTempStorePath('g2_3_cancel');
  try {
    const store = new PersistentStore(tmpFile);
    let signalWasAborted = false;

    const slowProvider: ScannerProvider = {
      async runScan(scanId, req, _onEvent, options) {
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 5000);
          options?.signal?.addEventListener(
            'abort',
            () => {
              signalWasAborted = true;
              clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        });
        return {
          schemaVersion: '2.0',
          scanId,
          requestedUrl: req.url,
          registrableDomain: 'fixture.test',
          status: 'cancelled',
          startedAt: new Date().toISOString(),
          limits: { maxPages: 10, maxLighthousePages: 3 },
          pages: [],
          uniquePagesInspected: 0,
          interactionStatesTested: 0,
          findings: [],
          lighthouse: [],
          limitations: []
        };
      }
    };

    await withApiServer({ store, provider: slowProvider, allowLocalFixtures: true }, async apiBase => {
      const cookie = 'madam_visitor=v_cancel_user_1';
      const postRes = await fetch(`${apiBase}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Visitor-Id': 'v_cancel_user_1' },
        body: JSON.stringify({ url: 'http://127.0.0.1:3000/fixtures/slow' })
      });
      const postData: any = await postRes.json();
      assert.equal(postRes.status, 200);
      assert.ok(postData.quota, 'POST /api/scans must return quota');

      // Cancel in-flight scan
      const cancelRes = await fetch(`${apiBase}/api/scans/${postData.scanId}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie, 'X-Visitor-Id': 'v_cancel_user_1' }
      });
      const cancelData: any = await cancelRes.json();
      assert.equal(cancelRes.status, 200);
      assert.equal(cancelData.ok, true);
      assert.equal(cancelData.scan.status, 'cancelled');
      assert.equal(cancelData.quota.pagesRemaining, 10, 'Domain quota reservation must be released on cancel');
      assert.equal(signalWasAborted, true, 'AbortSignal must be triggered immediately on cancel');
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.4: server restart marks unfinished queued/running jobs as interrupted', () => {
  const tmpFile = createTempStorePath('g2_4_restart');
  try {
    const store1 = new PersistentStore(tmpFile);
    const visitor = { visitorId: 'v_restart_user' };

    store1.createJob(visitor, {
      scanId: 'scan_q_1',
      requestedUrl: 'https://alpha.eg',
      normalizedUrl: 'https://alpha.eg/',
      registrableDomain: 'alpha.eg',
      reserveLock: true
    });
    store1.createJob(visitor, {
      scanId: 'scan_r_2',
      requestedUrl: 'https://alpha.eg/about',
      normalizedUrl: 'https://alpha.eg/about',
      registrableDomain: 'alpha.eg',
      reserveLock: true
    });
    store1.updateJobProgress('scan_r_2', { status: 'running' });

    // Simulate server restart by instantiating a new PersistentStore on the same file
    const store2 = new PersistentStore(tmpFile);
    const q1 = store2.getScanStatusForVisitor('scan_q_1', visitor.visitorId);
    const r2 = store2.getScanStatusForVisitor('scan_r_2', visitor.visitorId);

    assert.equal(q1.scan?.status, 'interrupted');
    assert.equal(r2.scan?.status, 'interrupted');
    assert.equal(
      store2.getQuotaStatus(visitor, 'alpha.eg').pagesRemaining,
      10,
      'Unfinished interrupted scans should release domain quota reservation'
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.5: rate limits on chat (30/h), tts (20/h), transcribe (20/h) and global concurrent scan limits', () => {
  const tmpFile = createTempStorePath('g2_5_limits');
  try {
    const store = new PersistentStore(tmpFile);
    const ip = '203.0.114.55';

    // 1. Chat: 30 allowed, 31st blocked
    for (let i = 0; i < 30; i++) {
      assert.equal(store.checkEndpointRateLimit(ip, 'chat').allowed, true);
    }
    assert.equal(store.checkEndpointRateLimit(ip, 'chat').allowed, false);

    // 2. TTS: 20 allowed, 21st blocked
    for (let i = 0; i < 20; i++) {
      assert.equal(store.checkEndpointRateLimit(ip, 'tts').allowed, true);
    }
    assert.equal(store.checkEndpointRateLimit(ip, 'tts').allowed, false);

    // 3. Transcribe: 20 allowed, 21st blocked
    for (let i = 0; i < 20; i++) {
      assert.equal(store.checkEndpointRateLimit(ip, 'transcribe').allowed, true);
    }
    assert.equal(store.checkEndpointRateLimit(ip, 'transcribe').allowed, false);

    // 4. Global & Per-IP concurrent scan limits
    const c1 = store.acquireConcurrentScanSlot('s1', '1.1.1.1', { maxGlobal: 3, maxPerIp: 2 });
    const c2 = store.acquireConcurrentScanSlot('s2', '1.1.1.1', { maxGlobal: 3, maxPerIp: 2 });
    const c3SameIp = store.acquireConcurrentScanSlot('s3', '1.1.1.1', { maxGlobal: 3, maxPerIp: 2 });
    assert.equal(c1.allowed, true);
    assert.equal(c2.allowed, true);
    assert.equal(c3SameIp.allowed, false, 'Per-IP concurrency limit of 2 should block 3rd scan from same IP');

    const c3OtherIp = store.acquireConcurrentScanSlot('s3', '2.2.2.2', { maxGlobal: 3, maxPerIp: 2 });
    const c4GlobalFull = store.acquireConcurrentScanSlot('s4', '3.3.3.3', { maxGlobal: 3, maxPerIp: 2 });
    assert.equal(c3OtherIp.allowed, true);
    assert.equal(c4GlobalFull.allowed, false, 'Global concurrency limit of 3 should block 4th concurrent scan');

    store.releaseConcurrentScanSlot('s1');
    assert.equal(
      store.acquireConcurrentScanSlot('s4', '3.3.3.3', { maxGlobal: 3, maxPerIp: 2 }).allowed,
      true
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.6: visitor ids are hashed with HMAC-SHA256 at rest using VISITOR_ID_SALT', () => {
  const tmpFile = createTempStorePath('g2_6_hmac');
  try {
    const store = new PersistentStore(tmpFile);
    const rawVisitorId = 'v_secret_cookie_token_998877';
    const expectedHash = hashVisitorId(rawVisitorId);

    assert.match(expectedHash, /^vh_[0-9a-f]{64}$/);
    assert.notEqual(expectedHash, rawVisitorId);

    store.createJob(
      { visitorId: rawVisitorId },
      {
        scanId: 'scan_hmac_test',
        requestedUrl: 'https://example.com',
        normalizedUrl: 'https://example.com/',
        registrableDomain: 'example.com',
        reserveLock: true
      }
    );
    store.recordFeedback({
      scanId: 'scan_hmac_test',
      findingId: 'f1',
      ruleId: 'R001',
      rulesetVersion: '2.0.0',
      vote: 'up',
      visitorId: rawVisitorId
    });

    const diskJson = fs.readFileSync(tmpFile, 'utf-8');
    assert.ok(!diskJson.includes(rawVisitorId), 'Raw visitorId must NEVER appear at rest on disk');
    assert.ok(diskJson.includes(expectedHash), 'HMAC-SHA256 visitorIdHash must be stored at rest');
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G2.7: AdminModal and non-existent admin API endpoints are completely removed', () => {
  const adminModalPath = path.resolve(PROJECT_ROOT, 'src/components/AdminModal.tsx');
  assert.equal(fs.existsSync(adminModalPath), false, 'AdminModal.tsx must be deleted');

  const appSource = fs.readFileSync(path.resolve(PROJECT_ROOT, 'src/App.tsx'), 'utf-8');
  assert.ok(!appSource.includes('AdminModal'), 'App.tsx must not reference AdminModal');
  assert.ok(!appSource.includes('/api/admin'), 'App.tsx must not reference /api/admin');
});

// ============================================================================
// PHASE G3: ENGINE CORRECTNESS
// ============================================================================
test('G3.1: mergeMultiPageFindings merges by fingerprint, preserving distinct findings of the same ruleId', () => {
  const fHeadersPage1: Finding = {
    id: 'f_r010_sec_headers',
    ruleId: 'R010',
    category: 'security',
    title: 'Missing Baseline Security Headers',
    titleAr: 'بعض إعدادات الحماية الأساسية للرد مش مفعلة',
    kind: 'confirmed_defect',
    severity: 'medium',
    confidence: 'confirmed',
    method: 'http',
    source: 'rule',
    url: 'https://example.com/',
    occurrences: 1,
    observed: 'Missing CSP on homepage',
    steps: [],
    evidence: [{ type: 'header', value: 'Missing CSP on /', ref: 'Missing CSP on /' }],
    recommendedFix: 'Add headers'
  };
  const fHeadersPage2: Finding = {
    ...fHeadersPage1,
    url: 'https://example.com/about',
    observed: 'Missing CSP on about',
    evidence: [{ type: 'header', value: 'Missing CSP on /about', ref: 'Missing CSP on /about' }]
  };
  const fWpUsers: Finding = {
    id: 'f_r010_wp_user_enum',
    ruleId: 'R010',
    category: 'security',
    title: 'Publicly Exposed WordPress User Enumeration (/wp-json/wp/v2/users)',
    titleAr: 'قائمة حسابات الإدارة في ووردبريس مكشوفة للجمهور',
    kind: 'confirmed_defect',
    severity: 'medium',
    confidence: 'confirmed',
    method: 'http',
    source: 'rule',
    url: 'https://example.com/wp-json/wp/v2/users?per_page=3',
    occurrences: 2,
    observed: '2 users exposed',
    steps: [],
    evidence: [{ type: 'snippet', value: 'slug: admin', ref: 'slug: admin' }],
    recommendedFix: 'Restrict REST API'
  };
  const fBroken1: Finding = {
    id: 'f_r001_sub_1',
    ruleId: 'R001',
    category: 'links',
    title: 'Broken Internal Navigation Link',
    kind: 'confirmed_defect',
    severity: 'high',
    confidence: 'confirmed',
    method: 'http',
    source: 'rule',
    url: 'https://example.com/broken-1',
    location: 'https://example.com/broken-1',
    occurrences: 1,
    observed: '404',
    steps: [],
    evidence: [{ type: 'header', value: 'GET /broken-1 -> 404', ref: 'GET /broken-1 -> 404' }],
    recommendedFix: 'Fix link'
  };
  const fBroken2: Finding = {
    ...fBroken1,
    id: 'f_r001_sub_2',
    url: 'https://example.com/broken-2',
    location: 'https://example.com/broken-2',
    evidence: [{ type: 'header', value: 'GET /broken-2 -> 404', ref: 'GET /broken-2 -> 404' }]
  };

  const merged = mergeMultiPageFindings([
    fHeadersPage1,
    fHeadersPage2,
    fWpUsers,
    fBroken1,
    fBroken2
  ]);

  assert.equal(merged.length, 4, 'Distinct R010 and R001 findings must not collapse into 2');
  const mergedHeaders = merged.find(f => f.title === 'Missing Baseline Security Headers');
  assert.ok(mergedHeaders);
  assert.equal(mergedHeaders.occurrences, 2);
  assert.deepEqual(mergedHeaders.affectedUrls, [
    'https://example.com/',
    'https://example.com/about'
  ]);
  assert.ok(
    merged.some(
      f => f.title === 'Publicly Exposed WordPress User Enumeration (/wp-json/wp/v2/users)'
    )
  );
  assert.equal(merged.filter(f => f.ruleId === 'R001').length, 2);
});

test('G3.2: secret finding uses high severity, titleAr نمط يشبه مفتاح سري, and needsHumanDecision', async () => {
  await withLocalServer(
    (req, res) => {
      if (req.url === '/fixtures/bundle.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('const stripeKey = "sk_live_1234567890abcdef12345678";');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><div id="root"></div><script src="/fixtures/bundle.js"></script></body></html>');
    },
    async baseUrl => {
      const ctrl = new AbortController();
      const findings = await scanPublicSpaJsForSecrets(
        `<script src="/fixtures/bundle.js"></script>`,
        `${baseUrl}/fixtures/home`,
        {
          deadlineMs: Date.now() + 10000,
          signal: ctrl.signal,
          canMakeRequest: () => true,
          remainingMs: () => 10000,
          isDeadlineExpired: () => false,
          isCancelled: () => false
        },
        true
      );
      assert.equal(findings.length, 1);
      assert.equal(findings[0].severity, 'high');
      assert.equal(findings[0].confidence, 'confirmed');
      assert.equal(findings[0].needsHumanDecision, true);
      assert.match(findings[0].titleAr || '', /^نمط يشبه مفتاح سري/);
    }
  );
});

test('G3.3: R012 treats alt="" as valid decorative image and does not flag missing alt', () => {
  const htmlWithDecorativeAndContentAlt = `<!doctype html>
<html lang="ar" dir="rtl">
<head><title>اختبار الصور التجميلية</title></head>
<body>
  <h1>صفحة اختبار الصور</h1>
  <img src="/hero.jpg" alt="صورة البانر الرئيسي">
  <img src="/divider.svg" alt="">
  <img src="/bg-shape.png" role="presentation">
</body>
</html>`;

  const res = runHonestChecks({
    url: 'https://example.com/',
    html: htmlWithDecorativeAndContentAlt,
    status: 200
  });
  assert.equal(
    res.findings.some(f => f.ruleId === 'R012'),
    false,
    'Explicit alt="" and role="presentation" must not be flagged as missing alt'
  );
  assert.equal(
    res.passes.some(p => p.ruleId === 'R012'),
    true,
    'R012 should pass when all images have valid alt or decorative alt=""'
  );

  const htmlWithTrulyMissingAlt = `<!doctype html>
<html lang="ar" dir="rtl">
<head><title>اختبار صورة بدون alt</title></head>
<body>
  <h1>صفحة اختبار</h1>
  <img src="/product.jpg">
</body>
</html>`;
  const resMissing = runHonestChecks({
    url: 'https://example.com/',
    html: htmlWithTrulyMissingAlt,
    status: 200
  });
  assert.equal(
    resMissing.findings.some(f => f.ruleId === 'R012'),
    true,
    '<img> with no alt attribute at all must still be flagged by R012'
  );
});

test('G3.3: R003 href="#" excludes anchors with role=button or aria-controls', () => {
  const htmlInteractiveAnchors = `<!doctype html>
<html lang="ar" dir="rtl">
<head><title>اختبار الأزرار التفاعلية</title></head>
<body>
  <h1>صفحة اختبار</h1>
  <a href="#" role="button">افتح القائمة</a>
  <a href="#" aria-controls="mobile-drawer" aria-expanded="false">القائمة الجانبية</a>
  <a href="#" data-bs-toggle="modal">اطلب الآن</a>
</body>
</html>`;

  const res = runHonestChecks({
    url: 'https://example.com/',
    html: htmlInteractiveAnchors,
    status: 200
  });
  assert.equal(
    res.findings.some(f => f.ruleId === 'R003'),
    false,
    'Interactive trigger anchors with role="button" or aria-controls must not be flagged as dead links'
  );
});

test('G3.4: HTTP 404 from sitemap/wp_api is medium confirmed, 5xx is medium likely, 401/403/429 is NOT_MEASURED', () => {
  const nav404 = classifySubpageHttpStatus({
    candidate: { url: 'https://example.com/missing-nav', source: 'nav', priority: 1, pageType: 'content' },
    status: 404,
    rootUrl: 'https://example.com/',
    index: 0
  });
  assert.equal(nav404.finding?.severity, 'high');
  assert.equal(nav404.finding?.confidence, 'confirmed');

  const sitemap404 = classifySubpageHttpStatus({
    candidate: { url: 'https://example.com/old-sitemap-url', source: 'sitemap', priority: 5, pageType: 'content' },
    status: 404,
    rootUrl: 'https://example.com/',
    index: 1
  });
  assert.equal(sitemap404.finding?.severity, 'medium');
  assert.equal(sitemap404.finding?.confidence, 'confirmed');

  const sub500 = classifySubpageHttpStatus({
    candidate: { url: 'https://example.com/err500', source: 'nav', priority: 2, pageType: 'content' },
    status: 502,
    rootUrl: 'https://example.com/',
    index: 2
  });
  assert.equal(sub500.finding?.severity, 'medium');
  assert.equal(sub500.finding?.confidence, 'likely');
  assert.equal(sub500.finding?.kind, 'suspected_issue');

  for (const protectedCode of [401, 403, 429]) {
    const prot = classifySubpageHttpStatus({
      candidate: { url: `https://example.com/prot-${protectedCode}`, source: 'nav', priority: 3, pageType: 'content' },
      status: protectedCode,
      rootUrl: 'https://example.com/',
      index: 3
    });
    assert.equal(prot.finding, undefined, `HTTP ${protectedCode} on subpage must not emit a broken link finding`);
    assert.ok(prot.notMeasured, `HTTP ${protectedCode} on subpage must be recorded in NOT_MEASURED`);
  }
});

test('G3.5: detectSiteStatus does not mark HTTP >= 400 as ok, and rejects empty body as empty_response', () => {
  for (const code of [400, 403, 404, 410, 429, 500, 503]) {
    const st = detectSiteStatus({
      requestedUrl: 'https://example.com',
      finalUrl: 'https://example.com/',
      status: code,
      headers: { 'content-type': 'text/html' },
      html: '<html><body>Error page</body></html>'
    });
    assert.notEqual(st.state, 'ok', `HTTP ${code} must never be marked state === "ok"`);
  }

  const emptySt = detectSiteStatus({
    requestedUrl: 'https://example.com',
    finalUrl: 'https://example.com/',
    status: 200,
    headers: { 'content-type': 'text/html' },
    html: '   '
  });
  assert.equal(emptySt.state, 'empty_response');
});

test('G3.6: LiveProvider does not fall back to MOCK data on empty HTML', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('   ');
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const result = await provider.runScan(
        'scan_g3_6_empty',
        { url: `${baseUrl}/fixtures/empty`, locale: 'ar-EG' },
        () => {}
      );
      assert.equal(result.isMockFallback, false, 'LiveProvider must never fall back to MOCK data');
      assert.equal(result.siteStatus?.state, 'empty_response');
      assert.equal(result.verdict?.level, 'status_only');
      assert.equal(result.findings.length, 0);
    }
  );
});

test('G3.7: PageInfo.viewportsChecked does not claim unexecuted mobile rendering', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="ar" dir="rtl"><head><title>موقع تجريبي</title></head><body><h1>أهلاً بكم في موقعنا</h1><p>محتوى كافي للفحص.</p></body></html>');
    },
    async baseUrl => {
      const provider = new LiveProvider();
      const result = await provider.runScan(
        'scan_g3_7_viewports',
        { url: `${baseUrl}/fixtures/home`, locale: 'ar-EG' },
        () => {}
      );
      assert.ok(result.pages.length >= 1);
      for (const page of result.pages) {
        assert.deepEqual(
          page.viewportsChecked,
          [],
          'Static HTML scan without browserRendering must not claim desktop/mobile viewportsChecked'
        );
      }
    }
  );
});

test('G3.8: ecommerce detector runs in live engine and filter/sort/variant query params do not consume page slots', async () => {
  const storeHtml = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <title>متجر النيل للإلكترونيات</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"سماعة"}</script>
</head>
<body>
  <header>
    <nav>
      <a href="/products">المنتجات</a>
      <a href="/products?sort=price_asc">ترتيب بالسعر</a>
      <a href="/products?color=black&size=xl">مقاس ولون</a>
      <a href="/products?page=2">الصفحة ٢</a>
      <a href="/products?filter=featured">المميزة</a>
      <a href="/about">من نحن</a>
      <a href="/contact">تواصل معنا</a>
      <a href="/cart">سلة التسوق</a>
    </nav>
  </header>
  <main>
    <h1>متجر النيل</h1>
    <div class="product-card"><span>450 ج.م</span><button class="add_to_cart_button">أضف إلى السلة</button></div>
    <div class="product-card"><span>800 ج.م</span><button class="add_to_cart_button">أضف إلى السلة</button></div>
    <div class="product-card"><span>1200 ج.م</span><button class="add_to_cart_button">أضف إلى السلة</button></div>
  </main>
</body>
</html>`;

  const profile = buildSiteProfile({
    url: 'https://nile-shop.eg/',
    html: storeHtml
  });
  assert.equal(profile.siteType, 'ecommerce');
  assert.equal(profile.type, 'ecommerce');

  const discovery = await discoverSitePages({
    rootUrl: 'https://nile-shop.eg/',
    rootHtml: storeHtml,
    profile,
    maxPages: SCAN_LIMITS.ECOMMERCE_MAX_PAGES,
    onRequestMade: () => false // skip network robots/sitemap
  });

  const discoveredUrls = discovery.selectedUrls.map(u => u.url);
  assert.ok(discoveredUrls.includes('https://nile-shop.eg/products'));
  assert.ok(discoveredUrls.includes('https://nile-shop.eg/about'));
  assert.ok(discoveredUrls.includes('https://nile-shop.eg/contact'));
  assert.ok(
    !discoveredUrls.some(u => u.includes('sort=') || u.includes('color=') || u.includes('page=') || u.includes('filter=')),
    'Filter, sort, variant, and pagination URLs must never consume page slots'
  );
});

test('G3.9: robots.txt groups consecutive user-agent lines and sitemap index fetches at most one child', async () => {
  const robotsTxt = `
User-agent: *
User-agent: Googlebot
Disallow: /secret-area

User-agent: MadamAfafBot
User-agent: Bingbot
Disallow: /bot-blocked
`;
  const policy = parseRobotsTxt(robotsTxt);
  assert.equal(isDisallowedByRobots('/secret-area/page', policy), true);
  assert.equal(isDisallowedByRobots('/bot-blocked/item', policy), true);
  assert.equal(isDisallowedByRobots('/public-page', policy), false);

  let childSitemapsFetched = 0;
  await withLocalServer(
    (req, res) => {
      const url = req.url || '/';
      if (url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('User-agent: *\nAllow: /');
        return;
      }
      if (url === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>http://${req.headers.host}/fixtures/post-sitemap.xml</loc></sitemap>
            <sitemap><loc>http://${req.headers.host}/fixtures/page-sitemap.xml</loc></sitemap>
            <sitemap><loc>http://${req.headers.host}/fixtures/product-sitemap.xml</loc></sitemap>
          </sitemapindex>`);
        return;
      }
      if (url.startsWith('/fixtures/') && url.endsWith('-sitemap.xml')) {
        childSitemapsFetched++;
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>http://${req.headers.host}/fixtures/from-child-1</loc></url>
            <url><loc>http://${req.headers.host}/fixtures/from-child-2</loc></url>
          </urlset>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Home</body></html>');
    },
    async baseUrl => {
      const disc = await discoverSitePages({
        rootUrl: `${baseUrl}/fixtures/home`,
        rootHtml: '<html><body><h1>Home</h1></body></html>',
        maxPages: 10,
        allowLocalFixtures: true
      });
      assert.equal(childSitemapsFetched, 1, 'Sitemap index must fetch at most 1 child sitemap');
      assert.ok(disc.selectedUrls.some(c => c.url.endsWith('/fixtures/from-child-1')));
      assert.ok(disc.selectedUrls.some(c => c.url.endsWith('/fixtures/from-child-2')));
    }
  );
});

test('G3.10: rescan comparison compares by finding fingerprint', () => {
  const tmpFile = createTempStorePath('g3_10_rescan');
  try {
    const store = new PersistentStore(tmpFile);
    const fSecHeaders: Finding = {
      id: 'f_r010_sec_headers',
      ruleId: 'R010',
      category: 'security',
      title: 'Missing Baseline Security Headers',
      titleAr: 'نقص هيدرز الحماية الأساسية',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      method: 'http',
      source: 'rule',
      url: 'https://example.com/',
      occurrences: 1,
      observed: 'Missing CSP',
      steps: [],
      evidence: [{ type: 'header', value: 'Missing CSP', ref: 'Missing CSP' }],
      recommendedFix: 'Add CSP'
    };
    const fWpUsers: Finding = {
      id: 'f_r010_wp_user_enum',
      ruleId: 'R010',
      category: 'security',
      title: 'Publicly Exposed WordPress User Enumeration (/wp-json/wp/v2/users)',
      titleAr: 'كشف مستخدمي ووردبريس',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      method: 'http',
      source: 'rule',
      url: 'https://example.com/wp-json/wp/v2/users',
      occurrences: 1,
      observed: 'Users exposed',
      steps: [],
      evidence: [{ type: 'snippet', value: 'slug: admin', ref: 'slug: admin' }],
      recommendedFix: 'Block endpoint'
    };

    const prevScan: any = {
      scanId: 'scan_prev',
      startedAt: new Date().toISOString(),
      findings: [fSecHeaders, fWpUsers]
    };
    const currScan: any = {
      scanId: 'scan_curr',
      startedAt: new Date().toISOString(),
      findings: [fSecHeaders] // fWpUsers was fixed, fSecHeaders still open
    };

    const diff = store.computeRescanDiff(prevScan, currScan);
    assert.equal(diff.stillOpenRuleIds.length, 1);
    assert.equal(diff.stillOpenRuleIds[0].titleAr, 'نقص هيدرز الحماية الأساسية');
    assert.equal(diff.resolvedRuleIds.length, 1);
    assert.equal(diff.resolvedRuleIds[0].titleAr, 'كشف مستخدمي ووردبريس');
    assert.equal(SCAN_LIMITS.RULESET_VERSION, '2.1.0', 'RULESET_VERSION must be bumped to 2.1.0 when G3 is done');
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

// ============================================================================
// PHASE G4: LIMITS AND DOMAIN LOCK (single source of truth)
// ============================================================================
test('G4.1: getRegistrableDomain uses tldts with allowPrivateDomains: true and private suffix overrides', () => {
  assert.equal(getRegistrableDomain('https://www.shop.company.com.eg/products'), 'company.com.eg');
  assert.equal(getRegistrableDomain('https://portal.ministry.gov.sa/ar'), 'ministry.gov.sa');
  assert.equal(getRegistrableDomain('https://tenant-one.vercel.app/'), 'tenant-one.vercel.app');
  assert.equal(getRegistrableDomain('https://staging.tenant-one.vercel.app/'), 'tenant-one.vercel.app');
  assert.equal(getRegistrableDomain('https://tenant-two.vercel.app/'), 'tenant-two.vercel.app');
  assert.equal(
    isSameRegistrableDomain('https://tenant-one.vercel.app', 'https://tenant-two.vercel.app'),
    false,
    'Different tenants on vercel.app must not share the same registrable domain'
  );
  assert.equal(getRegistrableDomain('https://org-a.github.io/repo'), 'org-a.github.io');
  assert.equal(getRegistrableDomain('https://app-x.netlify.app'), 'app-x.netlify.app');
  assert.equal(getRegistrableDomain('https://site-y.pages.dev'), 'site-y.pages.dev');
  assert.equal(getRegistrableDomain('https://proj-z.web.app'), 'proj-z.web.app');
});

test('G4.2: reserveScan allows scanning multiple different domains and enforces 10-page per 10-hour quota per root domain', async () => {
  const tmpFile = createTempStorePath('g4_2_atomic_reserve');
  try {
    const store = new PersistentStore(tmpFile);
    const visitor = { visitorId: 'v_parallel_tester' };

    // 1. Visitor can scan multiple different domains freely without single-domain visitor lock
    const [resA, resB] = await Promise.all([
      Promise.resolve(
        store.reserveScan(visitor, {
          scanId: 'scan_g4_2_a',
          requestedUrl: 'https://sama-link.com/shop',
          normalizedUrl: 'https://sama-link.com/shop'
        })
      ),
      Promise.resolve(
        store.reserveScan(visitor, {
          scanId: 'scan_g4_2_b',
          requestedUrl: 'https://domain-b.com',
          normalizedUrl: 'https://domain-b.com/'
        })
      )
    ]);

    assert.equal(resA.allowed, true, 'First reservation on sama-link.com must succeed');
    assert.equal(resA.registrableDomain, 'sama-link.com');
    assert.equal(resB.allowed, true, 'Reservation on a different domain (domain-b.com) must also succeed');
    assert.equal(resB.registrableDomain, 'domain-b.com');

    // 2. Subdomains and subpaths of sama-link.com share the same 10-page root domain quota
    store.commitScan('scan_g4_2_a', 9);
    const subRes = store.reserveScan(visitor, {
      scanId: 'scan_g4_2_sub',
      requestedUrl: 'https://shop.sama-link.com/categories',
      normalizedUrl: 'https://shop.sama-link.com/categories'
    });
    assert.equal(subRes.allowed, true, '10th page on subdomain shop.sama-link.com should be allowed');
    assert.equal(subRes.maxPagesOverride, 1);
    store.commitScan('scan_g4_2_sub', 1);

    // 3. Once 10 pages are exhausted on sama-link.com, further scans on sama-link.com or its subdomains are locked for 10 hours
    const blockedRes = store.reserveScan(visitor, {
      scanId: 'scan_g4_2_blocked',
      requestedUrl: 'https://sama-link.com/extra-page',
      normalizedUrl: 'https://sama-link.com/extra-page'
    });
    assert.equal(blockedRes.allowed, false, 'Exceeding 10 pages on sama-link.com within 10h window must be blocked');
    assert.equal(blockedRes.quota.pagesRemaining, 0);
    assert.ok(
      blockedRes.reasonAr?.includes('لقد استنفدت الحد الأقصى لفحص هذا الموقع (10 صفحات)'),
      `Expected exact per-domain quota message, got: ${blockedRes.reasonAr}`
    );

    // 4. Even while sama-link.com is locked, visitor can still scan another domain right now
    const resC = store.reserveScan(visitor, {
      scanId: 'scan_g4_2_c',
      requestedUrl: 'https://site-c.org',
      normalizedUrl: 'https://site-c.org/'
    });
    assert.equal(resC.allowed, true, 'Another root domain must remain scannable even when sama-link.com is locked');
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G4.3: quota-service is retired and /api/quota returns {hardDisabled, domainLock}', async () => {
  const quotaServicePath = path.resolve(PROJECT_ROOT, 'src/lib/quota-service.ts');
  assert.equal(fs.existsSync(quotaServicePath), false, 'src/lib/quota-service.ts must be deleted');

  const envExample = fs.readFileSync(path.resolve(PROJECT_ROOT, '.env.example'), 'utf-8');
  assert.ok(!envExample.includes('FREE_SCANS_PER_WINDOW'), '.env.example must not contain FREE_SCANS_PER_WINDOW');
  assert.ok(!envExample.includes('FREE_SCAN_WINDOW_HOURS'), '.env.example must not contain FREE_SCAN_WINDOW_HOURS');

  const readme = fs.readFileSync(path.resolve(PROJECT_ROOT, 'README.md'), 'utf-8');
  assert.ok(!readme.includes('FREE_SCANS_PER_WINDOW'), 'README.md must not contain FREE_SCANS_PER_WINDOW');
  assert.ok(!readme.includes('9 ساعات'), 'README.md must not reference the old 9-hour quota window');

  const tmpFile = createTempStorePath('g4_3_api_quota');
  try {
    const store = new PersistentStore(tmpFile);
    await withApiServer({ store }, async apiBaseUrl => {
      const res = await fetch(`${apiBaseUrl}/api/quota?domain=sama-link.com`, {
        headers: { Cookie: 'madam_visitor=v_quota_check' }
      });
      assert.equal(res.status, 200);
      const body: any = await res.json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.hardDisabled, 'boolean');
      assert.equal(body.domain, 'sama-link.com');
      assert.equal(body.pagesUsed, 0);
      assert.equal(body.pagesRemaining, 10);
      assert.equal(body.exhausted, false);
      assert.equal(body.resetAt, null);
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

// ============================================================================
// PHASE G5: CLIENT HONESTY AND LIFECYCLE UX
// ============================================================================
function createMemoryStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map.entries())
  };
}

test('G5.1: ScanProgress displays real server events and elapsed time without fake countdown or terminal lines', () => {
  const scanProgressPath = path.resolve(PROJECT_ROOT, 'src/components/ScanProgress.tsx');
  const source = fs.readFileSync(scanProgressPath, 'utf-8');

  // Must not contain fake terminal telemetry or fake countdown estimates
  assert.equal(source.includes('TELEMETRY_BY_STAGE'), false, 'Fake TELEMETRY_BY_STAGE must be removed');
  assert.equal(source.includes('madam-afaf-inspector --live-radar'), false, 'Fake terminal banner must be removed');
  assert.equal(source.includes('ACTIVE PROBE'), false, 'Fake ACTIVE PROBE indicator must be removed');
  assert.equal(source.includes('estimatedTotalSeconds'), false, 'Fake estimatedTotalSeconds must be removed');
  assert.equal(source.includes('remainingSeconds'), false, 'Fake remainingSeconds countdown must be removed');
  assert.equal(source.includes('متبقي تقريبًا'), false, 'Fake remaining time label must be removed');

  // Must not contain hardcoded hex colors
  const hexMatches = source.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(hexMatches, null, `ScanProgress must use CSS tokens only, found: ${hexMatches?.join(', ')}`);

  // Must display real server stageStates, elapsed time, and inspectedPagesCount
  assert.ok(source.includes('الوقت المنقضي'), 'ScanProgress must show real elapsed time');
  assert.ok(source.includes('/10'), 'ScanProgress must show real inspected pages count out of 10');
  assert.ok(source.includes('stageStates'), 'ScanProgress must render server stageStates');
});

test('G5.2: Cancel scan button exists in UI calling cancel endpoint and works with X-Visitor-Id in iframe mode', async () => {
  const scanProgressPath = path.resolve(PROJECT_ROOT, 'src/components/ScanProgress.tsx');
  const appPath = path.resolve(PROJECT_ROOT, 'src/App.tsx');
  const scanProgressSource = fs.readFileSync(scanProgressPath, 'utf-8');
  const appSource = fs.readFileSync(appPath, 'utf-8');

  assert.ok(scanProgressSource.includes('إلغاء الفحص'), 'ScanProgress must render Cancel Scan button');
  assert.ok(scanProgressSource.includes('data-testid="cancel-scan-btn"'), 'Cancel button must have testid');
  assert.ok(appSource.includes('/cancel'), 'App.tsx must call POST /api/scans/:id/cancel');

  // Verify end-to-end that starting, polling, and cancelling a scan works via X-Visitor-Id even when cookies are blocked by cross-origin iframe
  const tmpFile = createTempStorePath('g5_2_cancel_and_iframe');
  try {
    const store = new PersistentStore(tmpFile);
    let slowScanAborted = false;
    const slowProvider: ScannerProvider = {
      runScan: async (_scanId, _params, onProgress, options) => {
        onProgress({
          type: 'stage',
          stage: 'discovery',
          state: 'started',
          detail: 'جاري فحص الصفحات...'
        });
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 10_000);
          options?.signal?.addEventListener('abort', () => {
            slowScanAborted = true;
            clearTimeout(timer);
            resolve();
          });
        });
        throw new Error('Scan cancelled');
      }
    };

    await withApiServer({ store, provider: slowProvider, allowLocalFixtures: true }, async apiBaseUrl => {
      // Simulate cross-origin iframe where browser blocks Set-Cookie and sends X-Visitor-Id instead
      const visitorHeader = { 'X-Visitor-Id': 'v_iframe_visitor_987654321' };
      const startRes = await fetch(`${apiBaseUrl}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...visitorHeader },
        body: JSON.stringify({ url: 'http://127.0.0.1:9999/test', isAuthorized: true })
      });
      assert.equal(startRes.status, 200);
      const startData: any = await startRes.json();
      assert.equal(startData.ok, true);
      const scanId = startData.scanId;

      // Poll without Cookie header, using only X-Visitor-Id -> must return 200 (not 404!)
      const pollRes = await fetch(`${apiBaseUrl}/api/scans/${scanId}`, {
        headers: visitorHeader
      });
      assert.equal(pollRes.status, 200, 'Polling with X-Visitor-Id in iframe mode must succeed');
      const pollData: any = await pollRes.json();
      assert.equal(pollData.ok, true);

      // Cancel via POST /api/scans/:id/cancel using X-Visitor-Id
      const cancelRes = await fetch(`${apiBaseUrl}/api/scans/${scanId}/cancel`, {
        method: 'POST',
        headers: visitorHeader
      });
      assert.equal(cancelRes.status, 200);
      const cancelData: any = await cancelRes.json();
      assert.equal(cancelData.ok, true);
      assert.equal(cancelData.scan.status, 'cancelled');
      assert.equal(slowScanAborted, true);
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G5.3: navigating away or refreshing restores the active scan without losing progress', () => {
  const sessionStore = createMemoryStorage();

  // Initially empty
  assert.equal(loadActiveScanSession(sessionStore), null);

  // Start scan -> saves session
  const startedAt = '2026-10-22T06:00:00.000Z';
  saveActiveScanSession(
    {
      scanId: 'scan_active_restore_123456',
      requestedUrl: 'https://example.com',
      startedAt
    },
    sessionStore
  );

  // Simulate page reload / navigation back
  const restored = loadActiveScanSession(sessionStore);
  assert.ok(restored, 'Active scan session must be restored after refresh');
  assert.equal(restored.scanId, 'scan_active_restore_123456');
  assert.equal(restored.requestedUrl, 'https://example.com');
  assert.equal(restored.startedAt, startedAt);

  // When scan finishes or is cancelled -> session is cleared
  clearActiveScanSession(sessionStore);
  assert.equal(loadActiveScanSession(sessionStore), null);
});

test('G5.4: client polling implements exponential backoff and does not abort server jobs on client timeout', () => {
  const d0 = computePollBackoffMs(0);
  const d1 = computePollBackoffMs(1);
  const d2 = computePollBackoffMs(2);
  const d3 = computePollBackoffMs(3);
  const d10 = computePollBackoffMs(10);

  assert.equal(d0, 1000);
  assert.ok(d1 > d0, `Expected d1 (${d1}) > d0 (${d0})`);
  assert.ok(d2 > d1, `Expected d2 (${d2}) > d1 (${d1})`);
  assert.ok(d3 > d2, `Expected d3 (${d3}) > d2 (${d2})`);
  assert.equal(d10, 4000, 'Backoff must cap at maxMs (4000ms)');

  // Verify App.tsx uses computePollBackoffMs and does not call /cancel when MAX_CLIENT_POLL_DURATION_MS is reached
  const appPath = path.resolve(PROJECT_ROOT, 'src/App.tsx');
  const appSource = fs.readFileSync(appPath, 'utf-8');
  assert.ok(appSource.includes('computePollBackoffMs'), 'App.tsx must use exponential backoff');
  assert.ok(
    appSource.includes('الفحص لسه شغال وماتلغاش'),
    'App.tsx must keep server job alive and show non-destructive notice if polling takes long'
  );
});

test('G5.5: localStorage stores only lightweight scan summaries', () => {
  const localStore = createMemoryStorage();
  const fullScanResult: any = {
    scanId: 'scan_heavy_payload_123456',
    requestedUrl: 'https://heavy-example.com',
    finalUrl: 'https://heavy-example.com/',
    registrableDomain: 'heavy-example.com',
    status: 'completed',
    startedAt: '2026-10-22T06:00:00.000Z',
    finishedAt: '2026-10-22T06:00:12.000Z',
    uniquePagesInspected: 6,
    verdict: {
      level: 'needs_work_before_launch',
      labelAr: 'محتاج شغل قبل الإطلاق',
      summaryLinesAr: ['سطر 1', 'سطر 2'],
      isPartial: false,
      partialReasonsAr: [],
      counts: { critical: 0, high: 0, medium: 2, low: 1, passed: 5, notMeasured: 0 }
    },
    findings: [
      {
        id: 'f1',
        ruleId: 'R001',
        category: 'seo',
        severity: 'medium',
        confidence: 'confirmed',
        title: 'Missing H1',
        evidence: [{ type: 'snippet', value: '<html>very large snippet...</html>' }]
      }
    ],
    pages: [{ url: 'https://heavy-example.com/', status: 200 }],
    masterRepairPrompt: 'VERY LONG REPAIR PROMPT...'
  };

  saveRecentScanSummaryToStorage(fullScanResult, localStore);

  const rawJson = localStore.getItem('madam_afaf_recent_scans');
  assert.ok(rawJson);
  const parsed = JSON.parse(rawJson);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);

  const storedItem = parsed[0];
  assert.equal(storedItem.scanId, 'scan_heavy_payload_123456');
  assert.equal(storedItem.registrableDomain, 'heavy-example.com');
  assert.equal(storedItem.uniquePagesInspected, 6);
  assert.equal(storedItem.findingsCount, 1);
  assert.equal(storedItem.verdict?.level, 'needs_work_before_launch');

  // Heavy fields must NOT be present in localStorage
  assert.equal(storedItem.findings, undefined, 'localStorage summary must not store findings array');
  assert.equal(storedItem.pages, undefined, 'localStorage summary must not store pages array');
  assert.equal(storedItem.masterRepairPrompt, undefined, 'localStorage summary must not store masterRepairPrompt');

  const loaded = loadRecentScanSummariesFromStorage(localStore);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].findingsCount, 1);
});

test('G5.6: chat URL extractor rejects file extensions and strips punctuation', () => {
  // Reject file extensions in chat messages and direct input
  assert.equal(extractUrlFromMessage('شوف الصورة دي image.png والملف script.js و style.css'), null);
  assert.equal(extractUrlFromMessage('رفعتلك ملف report.pdf و archive.zip و config.json و index.html'), null);
  assert.equal(normalizeUserDomainOrUrl('logo.svg'), null);
  assert.equal(normalizeUserDomainOrUrl('server.ts'), null);
  assert.equal(validateAndNormalizeUrl('document.pdf').ok, false);

  // Strip Arabic and English trailing/surrounding punctuation from real domains
  assert.equal(
    extractUrlFromMessage('ممكن تراجعي موقعي: «https://vodafone.com.eg»، وتقوليلي رأيك؟'),
    'https://vodafone.com.eg/'
  );
  assert.equal(
    extractUrlFromMessage('ده لينك الموقع (example.com)، شغال؟'),
    'https://example.com/'
  );
  assert.equal(
    normalizeUserDomainOrUrl('«example.org/about»،'),
    'https://example.org/about'
  );
});

test('G5.7: evaluateAiClaims splits verbatim user text and maps strictly without fabricating claims', () => {
  const findings: Finding[] = [
    {
      id: 'f_seo_1',
      ruleId: 'R008',
      category: 'seo',
      title: 'Missing Meta Description',
      titleAr: 'وصف الصفحة التعريفي (Meta Description) ناقص',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      method: 'static_html',
      source: 'rule',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'No meta description found',
      expected: 'Meta description present',
      steps: [],
      evidence: [{ type: 'snippet', value: '<head><title>Test</title></head>', ref: '<head>' }],
      recommendedFix: 'Add meta description'
    }
  ];

  const userClaims = 'السيو متظبط 100% لجوجل، والمبيعات هتزيد 500% الشهر الجاي';
  const result = evaluateAiClaims({
    aiClaimsText: userClaims,
    findings,
    passes: [],
    notMeasured: []
  });

  // Must produce exactly 2 items corresponding to the 2 user clauses
  assert.equal(result.length, 2);

  // First clause preserves verbatim text and is contradicted by R008 SEO finding
  assert.equal(result[0].claimAr, '«السيو متظبط 100% لجوجل»');
  assert.equal(result[0].status, 'contradicted');

  // Second clause preserves verbatim text and is marked not_measured (never fabricated or guessed)
  assert.equal(result[1].claimAr, '«والمبيعات هتزيد 500% الشهر الجاي»');
  assert.equal(result[1].status, 'not_measured');
});

test('G5.8: computeVerdict is driven strictly by confirmed findings', () => {
  const suspectedMediumFinding: Finding = {
    id: 'f_suspected_med',
    ruleId: 'R007',
    category: 'responsive',
    title: 'Potential fixed width in CSS',
    titleAr: 'احتمال وجود عرض ثابت',
    kind: 'suspected_issue',
    severity: 'medium',
    confidence: 'likely',
    method: 'static_html',
    source: 'rule',
    url: 'https://example.com',
    occurrences: 1,
    observed: 'width: 900px',
    expected: 'Responsive width',
    steps: [],
    evidence: [{ type: 'snippet', value: 'width: 900px', ref: 'style' }],
    recommendedFix: 'Use max-width'
  };

  // Only likely/suspected medium finding -> must be ready_with_notes ("مفيش مشاكل مؤكدة كبيرة في العينة"), NOT needs_work_before_launch
  const verdictWithLikelyOnly = computeVerdict({
    findings: [suspectedMediumFinding],
    passes: [],
    notMeasured: []
  });
  assert.equal(verdictWithLikelyOnly.level, 'ready_with_notes');
  assert.equal(verdictWithLikelyOnly.labelAr, 'مفيش مشاكل مؤكدة كبيرة في العينة');

  // Confirmed medium finding -> needs_work_before_launch ("محتاج شغل قبل الإطلاق")
  const confirmedMediumFinding: Finding = {
    ...suspectedMediumFinding,
    id: 'f_confirmed_med',
    kind: 'confirmed_defect',
    confidence: 'confirmed'
  };
  const verdictWithConfirmedMedium = computeVerdict({
    findings: [confirmedMediumFinding],
    passes: [],
    notMeasured: []
  });
  assert.equal(verdictWithConfirmedMedium.level, 'needs_work_before_launch');
  assert.equal(verdictWithConfirmedMedium.labelAr, 'محتاج شغل قبل الإطلاق');

  // Confirmed high finding -> fix_before_handover ("فيه مشاكل لازم تتحل قبل الاستلام")
  const confirmedHighFinding: Finding = {
    ...confirmedMediumFinding,
    id: 'f_confirmed_high',
    severity: 'high'
  };
  const verdictWithConfirmedHigh = computeVerdict({
    findings: [confirmedHighFinding],
    passes: [],
    notMeasured: []
  });
  assert.equal(verdictWithConfirmedHigh.level, 'fix_before_handover');
  assert.equal(verdictWithConfirmedHigh.labelAr, 'فيه مشاكل لازم تتحل قبل الاستلام');
});

// ============================================================================
// PHASE G6: SHARING
// ============================================================================
test('G6.1: POST /api/scans/:id/share generates a 128-bit share token with 7-day expiry', async () => {
  const tmpFile = createTempStorePath('g6_1_share_create');
  try {
    const store = new PersistentStore(tmpFile);
    const ownerVisitorId = 'v_share_owner_111';
    const foreignVisitorId = 'v_share_foreign_222';
    const scanId = 'scan_share_target_333';

    store.saveScanReport(
      { visitorId: ownerVisitorId },
      {
        schemaVersion: '2.0',
        scanId,
        requestedUrl: 'https://mysite.example.com',
        registrableDomain: 'example.com',
        status: 'completed',
        startedAt: new Date().toISOString(),
        limits: { maxPages: 10, maxLighthousePages: 3 },
        pages: [],
        uniquePagesInspected: 1,
        interactionStatesTested: 1,
        findings: [
          {
            id: 'f_test_1',
            ruleId: 'R008',
            category: 'seo',
            severity: 'medium',
            confidence: 'confirmed',
            kind: 'confirmed_defect',
            method: 'static_html',
            source: 'rule',
            url: 'https://mysite.example.com',
            occurrences: 1,
            title: 'Meta description missing',
            observed: 'None',
            expected: 'Present',
            steps: [],
            evidence: [],
            recommendedFix: 'Add meta'
          }
        ],
        lighthouse: [],
        limitations: []
      }
    );

    await withApiServer({ store }, async apiBaseUrl => {
      // 1. Foreign visitor attempting to share -> 404
      const foreignRes = await fetch(`${apiBaseUrl}/api/scans/${scanId}/share`, {
        method: 'POST',
        headers: { 'X-Visitor-Id': foreignVisitorId }
      });
      assert.equal(foreignRes.status, 404, 'Foreign visitor cannot create share token');

      // 2. Owner visitor creates share token -> 200
      const ownerRes = await fetch(`${apiBaseUrl}/api/scans/${scanId}/share`, {
        method: 'POST',
        headers: { 'X-Visitor-Id': ownerVisitorId }
      });
      assert.equal(ownerRes.status, 200);
      const data: any = await ownerRes.json();
      assert.equal(data.ok, true);

      // 128-bit token = 16 bytes = 32 hexadecimal characters
      assert.ok(typeof data.shareToken === 'string');
      assert.match(data.shareToken, /^[0-9a-f]{32}$/i, 'Share token must be 128-bit (32 hex chars)');
      assert.equal(data.shareUrl, `/share/${data.shareToken}`);

      // Expiry ~ 7 days in future
      const now = Date.now();
      const expiresAtMs = new Date(data.expiresAt).getTime();
      const diffDays = (expiresAtMs - now) / (1000 * 3600 * 24);
      assert.ok(diffDays >= 6.9 && diffDays <= 7.1, `Expected ~7 days expiry, got ${diffDays}`);
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G6.2: GET /api/share/:token returns a sanitized read-only report without visitorId or private data', async () => {
  const tmpFile = createTempStorePath('g6_2_share_view');
  try {
    const store = new PersistentStore(tmpFile);
    const ownerVisitorId = 'v_share_owner_444';
    const scanId = 'scan_share_view_555';

    store.saveScanReport(
      { visitorId: ownerVisitorId },
      {
        schemaVersion: '2.0',
        scanId,
        requestedUrl: 'https://report-site.example.com',
        registrableDomain: 'example.com',
        status: 'completed',
        startedAt: new Date().toISOString(),
        limits: { maxPages: 10, maxLighthousePages: 3 },
        pages: [],
        uniquePagesInspected: 1,
        interactionStatesTested: 1,
        findings: [
          {
            id: 'f_pub_1',
            ruleId: 'R008',
            category: 'seo',
            severity: 'medium',
            confidence: 'confirmed',
            kind: 'confirmed_defect',
            method: 'static_html',
            source: 'rule',
            url: 'https://report-site.example.com',
            occurrences: 1,
            title: 'Meta description missing',
            observed: 'None',
            expected: 'Present',
            steps: [],
            evidence: [],
            recommendedFix: 'Add meta'
          }
        ],
        lighthouse: [],
        limitations: [],
        masterRepairPrompt: 'FIX EVERYTHING...'
      }
    );

    const share = store.createShareToken(scanId, ownerVisitorId);
    assert.equal(share.ok, true);
    const validToken = share.shareToken!;

    await withApiServer({ store }, async apiBaseUrl => {
      // 1. Valid token -> 200 with sanitized report
      const res = await fetch(`${apiBaseUrl}/api/share/${validToken}`);
      assert.equal(res.status, 200);
      const data: any = await res.json();
      assert.equal(data.ok, true);
      assert.ok(data.report);
      assert.equal(data.report.isSharedView, true);
      assert.ok(data.report.shareExpiresAt);
      assert.equal(data.report.findings.length, 1);
      assert.equal(data.report.masterRepairPrompt, 'FIX EVERYTHING...');

      // Private data verification: visitorId and visitorIdHash must NOT exist in response
      assert.equal(data.report.visitorId, undefined);
      assert.equal(data.report.visitorIdHash, undefined);

      // 2. Invalid token -> 404
      const invalidRes = await fetch(`${apiBaseUrl}/api/share/token_does_not_exist_999`);
      assert.equal(invalidRes.status, 404);

      // 3. Expired token -> 410 Gone
      const expiredShare = store.createShareToken(scanId, ownerVisitorId, -1000); // expired 1s ago
      const expiredRes = await fetch(`${apiBaseUrl}/api/share/${expiredShare.shareToken}`);
      assert.equal(expiredRes.status, 410);
      const expiredData: any = await expiredRes.json();
      assert.equal(expiredData.code, 'expired');

      // 4. Owner deletes report -> subsequent share lookup returns 410 Gone with code 'deleted'
      const del = store.deleteReportForVisitor(scanId, ownerVisitorId);
      assert.equal(del.deleted, true);
      const deletedShareRes = await fetch(`${apiBaseUrl}/api/share/${validToken}`);
      assert.equal(deletedShareRes.status, 410);
      const deletedData: any = await deletedShareRes.json();
      assert.equal(deletedData.code, 'deleted');
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('G6.3: share route sets noindex headers and visiting does not create scans or consume quota', async () => {
  const tmpFile = createTempStorePath('g6_3_share_noindex');
  try {
    const store = new PersistentStore(tmpFile);
    const ownerVisitorId = 'v_share_owner_777';
    const recipientVisitorId = 'v_share_recipient_888';
    const scanId = 'scan_share_noindex_999';

    store.saveScanReport(
      { visitorId: ownerVisitorId },
      {
        schemaVersion: '2.0',
        scanId,
        requestedUrl: 'https://noindex-site.example.com',
        registrableDomain: 'example.com',
        status: 'completed',
        startedAt: new Date().toISOString(),
        limits: { maxPages: 10, maxLighthousePages: 3 },
        pages: [],
        uniquePagesInspected: 1,
        interactionStatesTested: 1,
        findings: [],
        lighthouse: [],
        limitations: []
      }
    );

    const share = store.createShareToken(scanId, ownerVisitorId);
    assert.equal(share.ok, true);
    const token = share.shareToken!;

    await withApiServer({ store }, async apiBaseUrl => {
      // Snapshot store state before recipient visits
      const snapshotBefore = store.getRawStoreSnapshotForTest();
      const initialJobCount = Object.keys(snapshotBefore.jobs).length;
      const initialQuotasCount = Object.keys(snapshotBefore.quotas).length;

      // Recipient visits shared report
      const res = await fetch(`${apiBaseUrl}/api/share/${token}`, {
        headers: { 'X-Visitor-Id': recipientVisitorId }
      });
      assert.equal(res.status, 200);

      // Verify X-Robots-Tag: noindex, nofollow header
      const robotsHeader = res.headers.get('x-robots-tag');
      assert.ok(robotsHeader, 'X-Robots-Tag header must be present');
      assert.match(robotsHeader, /noindex/i, 'X-Robots-Tag must contain noindex');
      assert.match(robotsHeader, /nofollow/i, 'X-Robots-Tag must contain nofollow');

      // Verify that visiting the shared report did NOT create scans, locks, or consume quota
      const snapshotAfter = store.getRawStoreSnapshotForTest();
      assert.equal(Object.keys(snapshotAfter.jobs).length, initialJobCount, 'Visiting share must not create jobs');
      assert.equal(Object.keys(snapshotAfter.quotas).length, initialQuotasCount, 'Visiting share must not create quota entries');

      // Check recipient quota status via store -> must have 0 pages used and 10 remaining
      const quotaStatus = store.getQuotaStatus({ visitorId: recipientVisitorId }, 'sama-link.com');
      assert.equal(quotaStatus.pagesUsed, 0, 'Visiting share must not consume recipient pages');
      assert.equal(quotaStatus.pagesRemaining, 10, 'Visiting share must leave recipient with 10 pages');
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('API Safety: GET /api/scans and GET /api/share return 400 JSON and catch-all returns 404 JSON (no HTML collisions)', async () => {
  const tmpFile = createTempStorePath('api_safety_collisions');
  try {
    const store = new PersistentStore(tmpFile);
    await withApiServer({ store }, async apiBaseUrl => {
      // 1. GET /api/scans without ID -> 400 Bad Request JSON
      const missingScanRes = await fetch(`${apiBaseUrl}/api/scans`);
      assert.equal(missingScanRes.status, 400);
      const missingScanData: any = await missingScanRes.json();
      assert.equal(missingScanData.ok, false);
      assert.equal(missingScanData.code, 'missing_id');

      // 2. GET /api/share without token -> 400 Bad Request JSON
      const missingShareRes = await fetch(`${apiBaseUrl}/api/share`);
      assert.equal(missingShareRes.status, 400);
      const missingShareData: any = await missingShareRes.json();
      assert.equal(missingShareData.ok, false);
      assert.equal(missingShareData.code, 'missing_token');

      // 3. GET /api/scans with invalid characters -> 404 Not Found JSON
      const invalidScanRes = await fetch(`${apiBaseUrl}/api/scans/invalid!@#$%`);
      assert.equal(invalidScanRes.status, 404);
      const invalidScanData: any = await invalidScanRes.json();
      assert.equal(invalidScanData.ok, false);
      assert.equal(invalidScanData.code, 'not_found');

      // 4. GET /api/share with invalid characters -> 404 Not Found JSON
      const invalidShareRes = await fetch(`${apiBaseUrl}/api/share/inv!@#`);
      assert.equal(invalidShareRes.status, 404);
      const invalidShareData: any = await invalidShareRes.json();
      assert.equal(invalidShareData.ok, false);
      assert.equal(invalidShareData.code, 'not_found');

      // 5. Unhandled /api/* endpoint -> 404 JSON (not HTML fallback)
      const unknownApiRes = await fetch(`${apiBaseUrl}/api/unknown-endpoint`);
      assert.equal(unknownApiRes.status, 404);
      const contentType = unknownApiRes.headers.get('content-type') || '';
      assert.ok(contentType.includes('application/json'), 'Unhandled API endpoint must return JSON, not HTML');
      const unknownApiData: any = await unknownApiRes.json();
      assert.equal(unknownApiData.ok, false);
      assert.equal(unknownApiData.code, 'endpoint_not_found');
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

