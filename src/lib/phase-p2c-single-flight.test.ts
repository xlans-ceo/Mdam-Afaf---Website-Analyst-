import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createApiApp } from '../../server';
import {
  PersistentStore,
  hashVisitorId,
  getActiveScanMarkerId
} from './storage';
import {
  safeFetchHtmlWithSsrf,
  clearOutboundFetchCacheForTesting
} from './ssrf-validator';
import {
  ATTACHED_RUNNING_SCAN_MESSAGE_AR,
  getScanBroadcastChannelName
} from './scan-lifecycle';
import { ScannerProvider } from './providers/index';
import { ScanResult } from '../types/contract';

function createTempStorePath(label: string): string {
  return `/tmp/afaf_p2c_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
}

function startTestServer(app: ReturnType<typeof createApiApp>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise(res => {
            if (typeof (server as any).closeAllConnections === 'function') {
              (server as any).closeAllConnections();
            }
            server.close(() => res());
          })
      });
    });
  });
}

describe('PHASE P2c: Single-Flight Scan Deduplication, Idempotency-Key, BroadcastChannel & Host Politeness', () => {
  test('P2c.1 & P2c.5: reserveScan single-flight marker active_{visitorHash}_{domain} reuses active job with zero extra quota, frees marker on terminal states, and expires stale markers after SCAN_TIMEOUT_S+30s', () => {
    const tmpFile = createTempStorePath('p2c_1_marker');
    try {
      const store = new PersistentStore(tmpFile);
      const visitorA = { visitorId: 'v_p2c_alice_1' };
      const visitorB = { visitorId: 'v_p2c_bob_2' };
      const domain1 = 'elabyad-eg.com';
      const domain2 = 'other-domain.com';

      const vhA = hashVisitorId(visitorA.visitorId);
      const expectedMarkerKey = getActiveScanMarkerId(vhA, domain1);
      assert.equal(expectedMarkerKey, `active_${vhA}_${domain1}`);

      // 1. First reserveScan creates job and active marker
      const r1 = store.reserveScan(visitorA, {
        scanId: 'scan_p2c_1',
        requestedUrl: `https://${domain1}`,
        normalizedUrl: `https://${domain1}/`,
        registrableDomain: domain1
      });
      assert.equal(r1.allowed, true);
      assert.equal(r1.reused, false);
      assert.equal(r1.job?.scanId, 'scan_p2c_1');

      const snap1 = store.getRawStoreSnapshotForTest() as any;
      assert.ok(snap1.activeMarkers?.[expectedMarkerKey], 'Active marker must be stored under active_{visitorHash}_{domain}');
      assert.equal(snap1.activeMarkers[expectedMarkerKey].scanId, 'scan_p2c_1');

      // 2. Second reserveScan for same (visitor, domain) while active returns same job with reused=true and consumes NO extra quota
      const r2 = store.reserveScan(visitorA, {
        scanId: 'scan_p2c_2_should_not_be_created',
        requestedUrl: `https://${domain1}/about`,
        normalizedUrl: `https://${domain1}/about`,
        registrableDomain: domain1
      });
      assert.equal(r2.allowed, true);
      assert.equal(r2.reused, true, 'Second reserveScan on active domain must return reused=true');
      assert.equal(r2.job?.scanId, 'scan_p2c_1', 'Must return existing active job');
      assert.equal(
        store.getScanStatusForVisitor('scan_p2c_2_should_not_be_created', visitorA.visitorId).httpStatus,
        404,
        'Duplicate job must NOT be created'
      );

      // 3. Different domain for the same visitor is independent
      const rOtherDomain = store.reserveScan(visitorA, {
        scanId: 'scan_p2c_domain2',
        requestedUrl: `https://${domain2}`,
        normalizedUrl: `https://${domain2}/`,
        registrableDomain: domain2
      });
      assert.equal(rOtherDomain.allowed, true);
      assert.equal(rOtherDomain.reused, false, 'Different domain for same visitor must be independent');
      assert.equal(rOtherDomain.job?.scanId, 'scan_p2c_domain2');

      // 4. Different visitor on the same domain is independent
      const rOtherVisitor = store.reserveScan(visitorB, {
        scanId: 'scan_p2c_visitorB',
        requestedUrl: `https://${domain1}`,
        normalizedUrl: `https://${domain1}/`,
        registrableDomain: domain1
      });
      assert.equal(rOtherVisitor.allowed, true);
      assert.equal(rOtherVisitor.reused, false, 'Different visitor on same domain must be independent');
      assert.equal(rOtherVisitor.job?.scanId, 'scan_p2c_visitorB');

      // 5. Cancelling job frees the marker so a new scan can start
      store.cancelJob('scan_p2c_1', visitorA.visitorId);
      const snapAfterCancel = store.getRawStoreSnapshotForTest() as any;
      assert.equal(snapAfterCancel.activeMarkers?.[expectedMarkerKey], undefined, 'Cancelled job must free active marker');

      const rAfterCancel = store.reserveScan(visitorA, {
        scanId: 'scan_p2c_after_cancel',
        requestedUrl: `https://${domain1}`,
        normalizedUrl: `https://${domain1}/`,
        registrableDomain: domain1
      });
      assert.equal(rAfterCancel.allowed, true);
      assert.equal(rAfterCancel.reused, false);
      assert.equal(rAfterCancel.job?.scanId, 'scan_p2c_after_cancel');

      // 6. Failing job frees the marker
      store.failJob('scan_p2c_after_cancel', 'Simulated failure');
      const snapAfterFail = store.getRawStoreSnapshotForTest() as any;
      assert.equal(snapAfterFail.activeMarkers?.[expectedMarkerKey], undefined, 'Failed job must free active marker');

      // 7. Stale marker expires after SCAN_TIMEOUT_S + 30s (120s)
      const rStale = store.reserveScan(visitorA, {
        scanId: 'scan_p2c_stale',
        requestedUrl: `https://${domain1}`,
        normalizedUrl: `https://${domain1}/`,
        registrableDomain: domain1
      });
      assert.equal(rStale.reused, false);
      const futureNow = Date.now() + (90 + 31) * 1000;
      store.cleanupExpired(futureNow);
      const snapAfterExpire = store.getRawStoreSnapshotForTest() as any;
      assert.equal(snapAfterExpire.activeMarkers?.[expectedMarkerKey], undefined, 'Stale marker must expire after SCAN_TIMEOUT_S+30s');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('P2c.1 & P2c.2: Two simultaneous POST /api/scans -> one job; double click / Idempotency-Key within 10 minutes -> same scan', async () => {
    const tmpFile = createTempStorePath('p2c_2_http');
    let providerCallCount = 0;
    const pendingResolvers = new Map<string, () => void>();

    const controlledProvider: ScannerProvider = {
      runScan(scanId: string, req: any, emitEvent: any): Promise<ScanResult> {
        providerCallCount++;
        return new Promise<ScanResult>(resolve => {
          pendingResolvers.set(scanId, () => {
            const dummy: ScanResult = {
              schemaVersion: '2.0',
              scanId,
              requestedUrl: req.url,
              registrableDomain: 'elabyad-eg.com',
              status: 'completed',
              startedAt: new Date().toISOString(),
              limits: { maxPages: 10 },
              pages: [{ url: req.url, viewportsChecked: ['desktop'] }],
              uniquePagesInspected: 1,
              findings: [],
              passes: [],
              notMeasured: [],
              lighthouse: [],
              limitations: []
            };
            emitEvent({ type: 'done', result: dummy });
            resolve(dummy);
          });
        });
      }
    };

    const store = new PersistentStore(tmpFile);
    const app = createApiApp({
      store,
      provider: controlledProvider,
      allowLocalFixtures: true
    });
    const { baseUrl, close } = await startTestServer(app);

    try {
      const visitor = 'v_p2c_simultaneous_user';

      // 1. Two simultaneous POSTs for the same domain -> one job
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/scans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': visitor },
          body: JSON.stringify({ url: 'http://127.0.0.1:8080/page-a' })
        }),
        fetch(`${baseUrl}/api/scans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': visitor },
          body: JSON.stringify({ url: 'http://127.0.0.1:8080/page-a' })
        })
      ]);

      const body1: any = await res1.json();
      const body2: any = await res2.json();
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(body1.scanId, body2.scanId, 'Two simultaneous POSTs must return the exact same scanId');
      assert.equal(providerCallCount, 1, 'ScannerProvider.runScan must only be invoked ONCE');
      assert.ok(body1.reused === true || body2.reused === true, 'Second simultaneous POST must be marked reused=true');

      // Finish the running scan
      const finishFirst = pendingResolvers.get(body1.scanId);
      assert.ok(finishFirst);
      finishFirst();
      await new Promise(r => setTimeout(r, 80));

      // 2. Idempotency-Key header within 10 minutes returns the same scan even after completion
      const idemKey = 'idem_key_test_123456';
      const idemRes1 = await fetch(`${baseUrl}/api/scans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': visitor,
          'Idempotency-Key': idemKey
        },
        body: JSON.stringify({ url: 'http://127.0.0.1:8080/page-b' })
      });
      const idemBody1: any = await idemRes1.json();
      assert.equal(idemRes1.status, 200);
      assert.ok(idemBody1.scanId);

      // Finish the scan for idemBody1
      const finishSecond = pendingResolvers.get(idemBody1.scanId);
      if (finishSecond) finishSecond();
      await new Promise(r => setTimeout(r, 80));

      // Replay the exact same Idempotency-Key within 10 minutes -> must return idemBody1.scanId without starting a new scan
      const callsBeforeReplay = providerCallCount;
      const idemRes2 = await fetch(`${baseUrl}/api/scans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': visitor,
          'Idempotency-Key': idemKey
        },
        body: JSON.stringify({ url: 'http://127.0.0.1:8080/page-b' })
      });
      const idemBody2: any = await idemRes2.json();
      assert.equal(idemRes2.status, 200);
      assert.equal(idemBody2.scanId, idemBody1.scanId, 'Same Idempotency-Key within 10m must return the same scanId');
      assert.equal(idemBody2.reused, true);
      assert.equal(providerCallCount, callsBeforeReplay, 'Idempotent replay must not start a new provider scan');
    } finally {
      await close();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('P2c.3: Client BroadcastChannel helper and double-click / attached scan message constants', () => {
    assert.equal(ATTACHED_RUNNING_SCAN_MESSAGE_AR, 'الفحص شغال بالفعل، وصّلتك بيه');
    assert.equal(getScanBroadcastChannelName('scan_abc_123'), 'madam_afaf_scan_scan_abc_123');
  });

  test('P2c.4: Per-host limiter (max 2 concurrent per host, >=250ms spacing) and 60s GET coalescing/caching', async () => {
    clearOutboundFetchCacheForTesting();

    let serverHits = 0;
    let activeOnHost = 0;
    let maxConcurrentOnHost = 0;
    const requestStartTimes: number[] = [];

    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      serverHits++;
      activeOnHost++;
      maxConcurrentOnHost = Math.max(maxConcurrentOnHost, activeOnHost);
      requestStartTimes.push(Date.now());

      setTimeout(() => {
        activeOnHost--;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body>Response for ${url} (hit ${serverHits})</body></html>`);
      }, 300);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. In-flight coalescing of identical GET URLs: 3 simultaneous GETs to /fixtures/coalesce -> 1 server hit
      const [c1, c2, c3] = await Promise.all([
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/coalesce`, { allowLocalFixtures: true }),
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/coalesce`, { allowLocalFixtures: true }),
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/coalesce`, { allowLocalFixtures: true })
      ]);
      assert.equal(c1.ok, true);
      assert.equal(c2.ok, true);
      assert.equal(c3.ok, true);
      assert.equal(c1.html, c2.html);
      assert.equal(c2.html, c3.html);
      assert.equal(serverHits, 1, 'Simultaneous identical GET URLs must coalesce into 1 HTTP request');

      // Subsequent GET within 60s hits cache -> still 1 server hit
      const c4Cached = await safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/coalesce`, { allowLocalFixtures: true });
      assert.equal(c4Cached.ok, true);
      assert.equal(serverHits, 1, 'Identical GET within 60s must be served from public bytes cache');

      // 2. Per-host limiter across 4 distinct GET URLs on the same host:
      // maxConcurrentOnHost <= 2 and spacing between consecutive starts >= 230ms (250ms target with timer jitter tolerance)
      requestStartTimes.length = 0;
      maxConcurrentOnHost = 0;

      await Promise.all([
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/p1`, { allowLocalFixtures: true }),
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/p2`, { allowLocalFixtures: true }),
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/p3`, { allowLocalFixtures: true }),
        safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/p4`, { allowLocalFixtures: true })
      ]);

      assert.equal(requestStartTimes.length, 4);
      assert.ok(
        maxConcurrentOnHost <= 2,
        `Max concurrent requests per host must be <= 2, got ${maxConcurrentOnHost}`
      );

      for (let i = 1; i < requestStartTimes.length; i++) {
        const spacing = requestStartTimes[i] - requestStartTimes[i - 1];
        assert.ok(
          spacing >= 220,
          `Expected >= 250ms spacing between requests ${i} and ${i + 1} on same host, got ${spacing}ms`
        );
      }
    } finally {
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
      clearOutboundFetchCacheForTesting();
    }
  });
});
