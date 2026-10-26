import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { truncateReportEvidenceToCap, Store, PersistenceStatus } from './store-interface';
import { PsiCache, PSI_CACHE_TTL_MS } from './psi-cache';
import { PersistentStore } from './storage';
import { createApiApp } from '../../server';
import { ScanResult, Finding } from '../types/contract';
import { ScannerProvider } from './providers/index';

function startTestServer(app: ReturnType<typeof createApiApp>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        close: () => new Promise(res => {
          if (typeof (server as any).closeAllConnections === 'function') {
            (server as any).closeAllConnections();
          }
          server.close(() => res());
        })
      });
    });
  });
}

test('P1.4: truncateReportEvidenceToCap caps report size strictly under 1 MiB without dropping findings', () => {
  // Construct a simulated large report
  const findings: Finding[] = [];
  for (let i = 0; i < 50; i++) {
    findings.push({
      id: `f_${i}`,
      ruleId: `R00${i % 10}`,
      category: 'seo' as const,
      title: `Finding ${i}`,
      kind: 'suspected_issue' as const,
      severity: 'medium' as const,
      confidence: 'likely' as const,
      method: 'static_html' as const,
      affectsVerdict: true,
      needsHumanDecision: false,
      observed: 'Some observed text',
      steps: ['Step 1', 'Step 2'],
      source: 'rule' as const,
      url: 'https://example.com',
      occurrences: 1,
      evidence: [
        { type: 'snippet' as const, value: 'A'.repeat(5000), ref: 'B'.repeat(5000) },
        { type: 'text' as const, value: 'C'.repeat(5000), ref: 'D'.repeat(5000) },
        { type: 'url' as const, value: 'E'.repeat(5000), ref: 'F'.repeat(5000) },
        { type: 'dom_snippet' as const, value: 'G'.repeat(5000), ref: 'H'.repeat(5000) },
        { type: 'header' as const, value: 'I'.repeat(5000), ref: 'J'.repeat(5000) }
      ],
      recommendedFix: 'Fix it'
    });
  }

  const hugeReport: ScanResult = {
    schemaVersion: '2.0',
    scanId: 'scan_huge_test',
    requestedUrl: 'https://example.com',
    registrableDomain: 'example.com',
    status: 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    limits: { maxPages: 10 },
    pages: [],
    lighthouse: [],
    limitations: [],
    uniquePagesInspected: 1,
    findings,
    passes: [],
    notMeasured: []
  };

  const initialBytes = JSON.stringify(hugeReport).length;
  assert.ok(initialBytes > 1024 * 1024, `Initial report should exceed 1 MiB, got ${initialBytes} bytes`);

  const capped = truncateReportEvidenceToCap(hugeReport, 1024 * 1024);
  const cappedBytes = JSON.stringify(capped).length;

  assert.ok(cappedBytes <= 1024 * 1024, `Capped report must be <= 1,048,576 bytes, got ${cappedBytes}`);
  assert.equal(capped.findings.length, 50, 'Must NEVER drop or delete findings during truncation');
});

test('P1.5: PsiCache stores measurements per URL for 6 hours', () => {
  const cache = new PsiCache();
  const testUrl = 'https://example.com/test-page';
  const dummyMeasurement = {
    lcpMs: 1200,
    cls: 0.02,
    performanceScore: 85
  };

  assert.equal(cache.get(testUrl), undefined, 'Initial cache miss');

  const now = 1000000;
  cache.set(testUrl, dummyMeasurement, 'mobile', PSI_CACHE_TTL_MS, now);

  // Hit within TTL
  const hit = cache.get(testUrl, 'mobile', now + 3600 * 1000);
  assert.deepEqual(hit, dummyMeasurement);

  // Different strategy misses
  assert.equal(cache.get(testUrl, 'desktop', now + 1000), undefined);

  // Expired after 6 hours (6 * 3600 * 1000 ms)
  const expired = cache.get(testUrl, 'mobile', now + PSI_CACHE_TTL_MS + 1000);
  assert.equal(expired, undefined, 'Must expire after TTL');
});

test('P1.4: PersistentStore conforms to Store interface & returns non-durable status', () => {
  const store: Store = new PersistentStore();
  const status = store.getPersistenceStatus();

  assert.equal(status.adapter, 'file');
  assert.equal(status.mode, 'non-durable');
  assert.equal(status.durable, false);
  assert.equal(typeof status.lastWriteOk, 'boolean');
});

test('P1.4: In-memory Mock Firestore Store contract implementation', () => {
  class MockFirestoreStore implements Store {
    private jobs = new Map<string, any>();
    private reports = new Map<string, ScanResult>();

    getPersistenceStatus(): PersistenceStatus {
      return {
        adapter: 'firestore',
        mode: 'durable',
        durable: true,
        lastWriteOk: true
      };
    }
    createJob(identity: any, params: any) {
      const job: any = { scanId: params.scanId || 's1', status: 'queued', visitorIdHash: 'vh_1' };
      this.jobs.set(job.scanId, job);
      return job;
    }
    getScanStatusForVisitor(scanId: string) {
      const scan = this.jobs.get(scanId);
      return scan ? { httpStatus: 200, scan } : { httpStatus: 404 };
    }
    updateJobProgress(scanId: string, updates: any) {
      const existing = this.jobs.get(scanId) || {};
      const updated = { ...existing, ...updates };
      this.jobs.set(scanId, updated);
      return updated;
    }
    cancelJob(scanId: string) {
      const job = this.jobs.get(scanId);
      if (job) job.status = 'cancelled';
      return { ok: true, status: 200, job };
    }
    failJob(scanId: string, msg: string, code = 'internal') {
      const job = this.jobs.get(scanId);
      if (job) { job.status = 'failed'; job.errorCode = code; job.errorMessage = msg; }
      return job;
    }
    saveScanReport(_id: any, result: ScanResult) {
      this.reports.set(result.scanId, result);
      return result;
    }
    deleteReportForVisitor(scanId: string) {
      this.reports.delete(scanId);
      return { deleted: true, status: 200 };
    }
    listVisitorReports() {
      return [];
    }
    getQuotaStatus() {
      return {
        domain: 'example.com',
        pagesUsed: 0,
        pagesRemaining: 10,
        maxPages: 10,
        resetAt: null,
        exhausted: false,
        remainingMinutes: 0
      };
    }
    reserveScan(_id: any, params: any) {
      return {
        allowed: true,
        reused: false,
        registrableDomain: 'example.com',
        maxPagesOverride: 10,
        quota: this.getQuotaStatus(),
        job: { scanId: params.scanId || 's1' } as any
      };
    }
    commitScan() {}
    releaseReservation() {}
    getIdempotentScan() { return null; }
    saveIdempotencyRecord() {}
    createShareToken() { return { ok: true, status: 200, shareId: 'sh_1' }; }
    revokeShareForScan() { return { ok: true, status: 200, revokedCount: 1 }; }
    getSharedReport() { return { ok: true, status: 200 }; }
    submitFeedback() { return { ok: true, status: 200, feedback: { id: 'fb_1' } as any }; }
    saveReportFeedback() { return { ok: true, status: 200 }; }
    saveFindingFeedback() { return { ok: true, status: 200 }; }
    getAdminFeedbackOverview() {
      return {
        totalReportRatings: 0,
        averageStars: 0,
        ratingDistribution: {},
        topReasons: [],
        ruleStats: [],
        recentComments: []
      };
    }
    recordFeedback() { return null; }
    acquireConcurrentScanSlot() { return { allowed: true }; }
    releaseConcurrentScanSlot() {}
    checkEndpointRateLimit() { return { allowed: true, remaining: 10, limit: 20 }; }
    generateScanId() { return 'scan_mock_123'; }
    cleanupExpired() {}
  }

  const mockStore: Store = new MockFirestoreStore();
  const status = mockStore.getPersistenceStatus();
  assert.equal(status.adapter, 'firestore');
  assert.equal(status.durable, true);
});

test('P1.6: GET /api/health returns persistence status and boolean config with zero secrets', async () => {
  const app = createApiApp();
  const { baseUrl, close } = await startTestServer(app);

  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(body.status, 'healthy');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal(typeof body.version, 'string');

    // Persistence block
    assert.equal(body.persistence?.adapter, 'file');
    assert.equal(body.persistence?.mode, 'non-durable');
    assert.equal(body.persistence?.durable, false);
    assert.equal(typeof body.persistence?.lastWriteOk, 'boolean');

    // Config block - strictly boolean
    assert.equal(typeof body.config?.saltOk, 'boolean');
    assert.equal(typeof body.config?.adminEnabled, 'boolean');
    assert.equal(typeof body.config?.psi, 'boolean');
    assert.equal(typeof body.config?.gemini, 'boolean');

    // Verify zero secret leakage in health response
    const serialized = JSON.stringify(body);
    const adminToken = (process.env.ADMIN_TOKEN || '').trim();
    const salt = (process.env.VISITOR_ID_SALT || '').trim();
    if (adminToken.length > 4) assert.ok(!serialized.includes(adminToken));
    if (salt.length > 4) assert.ok(!serialized.includes(salt));
  } finally {
    await close();
  }
});

test('P1.4 / P1.5: FIFO scan queue enqueues when slots full, exposes queuePosition, and unqueues on cancel', async () => {
  // Provider that hangs until resolved manually
  const pendingResolvers = new Map<string, (val?: any) => void>();
  const controlledProvider: ScannerProvider = {
    runScan: (scanId: string, _request: any, emitEvent: any, options: any): Promise<ScanResult> => {
      return new Promise<ScanResult>((resolve, reject) => {
        pendingResolvers.set(scanId, () => {
          const dummyResult: ScanResult = {
            schemaVersion: '2.0',
            scanId,
            requestedUrl: 'https://example.com',
            registrableDomain: 'example.com',
            status: 'completed',
            startedAt: new Date().toISOString(),
            limits: { maxPages: 10 },
            pages: [],
            lighthouse: [],
            limitations: [],
            uniquePagesInspected: 1,
            findings: [],
            passes: [],
            notMeasured: []
          };
          emitEvent({
            type: 'done',
            result: dummyResult
          });
          resolve(dummyResult);
        });

        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }
      });
    }
  };

  // Create app with maxGlobal = 1 concurrency slot for clear queue testing
  const app = createApiApp({
    provider: controlledProvider,
    allowLocalFixtures: true,
    concurrencyLimits: { maxGlobal: 1, maxPerIp: 10 }
  });

  const { baseUrl, close } = await startTestServer(app);

  try {
    const visitor1 = 'v_user_queue_test_1';
    const visitor2 = 'v_user_queue_test_2';
    const visitor3 = 'v_user_queue_test_3';

    // 1. Start first scan -> occupies the 1 global slot immediately
    const res1 = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': visitor1 },
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/page1' })
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.ok, true);
    const scanId1 = body1.scanId;

    // 2. Start second scan -> slot occupied, joins FIFO queue at position 1
    const res2 = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': visitor2 },
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/page2' })
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.ok, true);
    assert.equal(body2.status, 'queued');
    assert.equal(body2.queuePosition, 1);
    const scanId2 = body2.scanId;

    // 3. Start third scan -> joins FIFO queue at position 2
    const res3 = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': visitor3 },
      body: JSON.stringify({ url: 'http://127.0.0.1:8080/page3' })
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.ok, true);
    assert.equal(body3.status, 'queued');
    assert.equal(body3.queuePosition, 2);
    const scanId3 = body3.scanId;

    // 4. GET /api/scans/:id for queued scans returns their queue position
    const pollRes2 = await fetch(`${baseUrl}/api/scans/${scanId2}`, {
      headers: { 'X-Visitor-Id': visitor2 }
    });
    assert.equal(pollRes2.status, 200);
    const pollBody2 = await pollRes2.json();
    assert.equal(pollBody2.scan.status, 'queued');
    assert.equal(pollBody2.scan.queuePosition, 1);
    assert.ok(pollBody2.scan.stageDetail.includes('1'));

    // 5. Cancel scan 2 while queued -> unqueues, releases reservation, updates scan 3 to position 1
    const cancelRes2 = await fetch(`${baseUrl}/api/scans/${scanId2}/cancel`, {
      method: 'POST',
      headers: { 'X-Visitor-Id': visitor2 }
    });
    assert.equal(cancelRes2.status, 200);
    const cancelBody2 = await cancelRes2.json();
    assert.equal(cancelBody2.ok, true);
    assert.equal(cancelBody2.scan.status, 'cancelled');

    const pollRes3 = await fetch(`${baseUrl}/api/scans/${scanId3}`, {
      headers: { 'X-Visitor-Id': visitor3 }
    });
    assert.equal(pollRes3.status, 200);
    const pollBody3 = await pollRes3.json();
    assert.equal(pollBody3.scan.status, 'queued');
    assert.equal(pollBody3.scan.queuePosition, 1);

    // 6. Complete scan 1 -> advances queue, scan 3 starts running
    const resolve1 = pendingResolvers.get(scanId1);
    assert.ok(resolve1);
    resolve1();

    // Allow microtasks to advance queue
    await new Promise(r => setTimeout(r, 60));

    const pollRes3Running = await fetch(`${baseUrl}/api/scans/${scanId3}`, {
      headers: { 'X-Visitor-Id': visitor3 }
    });
    assert.equal(pollRes3Running.status, 200);
    const pollBody3Running = await pollRes3Running.json();
    assert.equal(pollBody3Running.scan.status, 'running');

    // Cleanup scan 3
    const resolve3 = pendingResolvers.get(scanId3);
    if (resolve3) resolve3();
  } finally {
    await close();
  }
});
