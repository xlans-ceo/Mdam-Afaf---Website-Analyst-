import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createApiApp } from '../../server';
import { PersistentStore, hashVisitorId } from './storage';
import { ScanResult } from '../types/contract';

function createTempStorePath(label: string): string {
  return `/tmp/afaf_j0_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
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

function makeSampleScanResult(scanId: string, domain: string, pagesCount = 3): ScanResult {
  return {
    schemaVersion: '2.0',
    rulesetVersion: '2.0.0',
    scanId,
    requestedUrl: `https://${domain}`,
    finalUrl: `https://${domain}/`,
    registrableDomain: domain,
    status: 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    limits: { maxPages: 10, maxLighthousePages: 3 },
    pages: Array.from({ length: pagesCount }, (_, idx) => ({
      url: idx === 0 ? `https://${domain}/` : `https://${domain}/p${idx}`,
      title: `Page ${idx + 1}`,
      httpStatus: 200,
      viewportsChecked: ['desktop' as const]
    })),
    uniquePagesInspected: pagesCount,
    interactionStatesTested: 0,
    findings: [
      {
        id: 'f_real_1',
        ruleId: 'SEO001',
        category: 'seo',
        title: 'Missing meta description',
        titleAr: 'وصف الصفحة ناقص',
        kind: 'confirmed_defect',
        severity: 'medium',
        confidence: 'confirmed',
        method: 'static_html',
        source: 'rule',
        url: `https://${domain}/`,
        occurrences: 1,
        observed: 'No meta description found; internal debug http://127.0.0.1:8080/internal and key sk-proj-1234567890abcdefghijklmnop',
        expected: 'Meta description 50-160 chars',
        steps: ['افتح الصفحة الرئيسية'],
        evidence: [
          {
            type: 'snippet',
            value: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret and host http://192.168.1.55/admin',
            ref: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret and host http://192.168.1.55/admin'
          }
        ],
        recommendedFix: 'ضيف meta description'
      }
    ],
    passes: [],
    notMeasured: [],
    lighthouse: [],
    limitations: [],
    masterRepairPrompt: 'Fix SEO001 on http://10.0.0.5:3000 with token AIzaSyD1234567890123456789012345678'
  };
}

describe('PHASE J0: Quota Isolation, Reservation Release, Share Hardening & Feedback Verification', () => {
  test('J0.1 (H3): Quota is keyed by ${visitorHash}:${rootDomain}, isolates visitors, and removes legacy locks/getVisitorLockStatus', () => {
    const tmpFile = createTempStorePath('j0_1_isolation');
    try {
      const store = new PersistentStore(tmpFile);
      const visitorA = { visitorId: 'v_alice_1111' };
      const visitorB = { visitorId: 'v_bob_2222' };

      // Legacy getVisitorLockStatus stub and locks structure must not exist
      assert.equal('getVisitorLockStatus' in (store as any), false, 'getVisitorLockStatus stub must be removed');
      const snap0 = store.getRawStoreSnapshotForTest() as any;
      assert.equal(snap0.locks, undefined, 'Legacy locks map must be removed');
      assert.equal(snap0.domainQuotas, undefined, 'Legacy global domainQuotas map must be removed');
      assert.ok(snap0.quotas && typeof snap0.quotas === 'object', 'Store must have single quotas structure');

      // Visitor A reserves and commits 10 pages on elabyad-eg.com
      const resA = store.reserveScan(visitorA, {
        scanId: 'scan_a1',
        requestedUrl: 'https://elabyad-eg.com',
        normalizedUrl: 'https://elabyad-eg.com/',
        registrableDomain: 'elabyad-eg.com'
      });
      assert.equal(resA.allowed, true);
      assert.equal(resA.maxPagesOverride, 10);

      store.commitScan('scan_a1', 10);

      // Verify structure key is ${visitorHash}:${rootDomain}
      const expectedKeyA = `${hashVisitorId(visitorA.visitorId)}:elabyad-eg.com`;
      const snap1 = store.getRawStoreSnapshotForTest() as any;
      assert.ok(snap1.quotas[expectedKeyA], `Expected quota key ${expectedKeyA}`);
      assert.equal(snap1.quotas[expectedKeyA].pagesCommitted, 10);
      assert.deepEqual(snap1.quotas[expectedKeyA].reservations, {});

      // Visitor A is now exhausted on elabyad-eg.com
      const qA = store.getQuotaStatus(visitorA, 'elabyad-eg.com');
      assert.equal(qA.pagesUsed, 10);
      assert.equal(qA.pagesRemaining, 0);
      assert.equal(qA.exhausted, true);
      assert.ok(qA.resetAt);

      const resA2 = store.reserveScan(visitorA, {
        scanId: 'scan_a2',
        requestedUrl: 'https://elabyad-eg.com/about'
      });
      assert.equal(resA2.allowed, false, 'Visitor A must be blocked after exhausting 10 pages');

      // Visitor B is completely isolated and can scan elabyad-eg.com with all 10 pages
      const qB = store.getQuotaStatus(visitorB, 'elabyad-eg.com');
      assert.equal(qB.pagesUsed, 0);
      assert.equal(qB.pagesRemaining, 10);
      assert.equal(qB.exhausted, false);
      assert.equal(qB.resetAt, null);

      const resB = store.reserveScan(visitorB, {
        scanId: 'scan_b1',
        requestedUrl: 'https://elabyad-eg.com'
      });
      assert.equal(resB.allowed, true, 'Visitor B must not be blocked by Visitor A');
      assert.equal(resB.maxPagesOverride, 10);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('J0.2 (H3): Every non-success path (failJob, cancelJob, interrupted on restart, status-only, 0 pages) calls releaseReservation', () => {
    const tmpFile = createTempStorePath('j0_2_release');
    try {
      const store = new PersistentStore(tmpFile);
      const visitor = { visitorId: 'v_release_tester' };
      const domain = 'release-test.com';

      // 1. failJob releases reservation
      const r1 = store.reserveScan(visitor, { scanId: 'scan_fail', requestedUrl: `https://${domain}` });
      assert.equal(r1.allowed, true);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 0); // 10 reserved
      store.failJob('scan_fail', 'Network error');
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 10, 'failJob must release reservation');

      // 2. cancelJob releases reservation
      const r2 = store.reserveScan(visitor, { scanId: 'scan_cancel', requestedUrl: `https://${domain}` });
      assert.equal(r2.allowed, true);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 0);
      store.cancelJob('scan_cancel', visitor.visitorId);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 10, 'cancelJob must release reservation');

      // 3. status-only report releases reservation
      const r3 = store.reserveScan(visitor, { scanId: 'scan_status_only', requestedUrl: `https://${domain}` });
      assert.equal(r3.allowed, true);
      const statusOnlyResult = makeSampleScanResult('scan_status_only', domain, 1);
      statusOnlyResult.siteStatus = {
        state: 'maintenance_or_coming_soon',
        whatISawAr: 'الموقع تحت الصيانة',
        whatItMeansAr: 'صفحة صيانة مؤقتة',
        whatToDoAr: 'جرب بعد انتهاء الصيانة',
        evidence: []
      };
      store.saveScanReport(visitor, statusOnlyResult);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesUsed, 0);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 10, 'status-only scan must release reservation');

      // 4. 0-pages scan releases reservation
      const r4 = store.reserveScan(visitor, { scanId: 'scan_zero_pages', requestedUrl: `https://${domain}` });
      assert.equal(r4.allowed, true);
      store.commitScan('scan_zero_pages', 0);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesUsed, 0);
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 10, '0-page commitScan must release reservation');

      // 5. Server restart marks running/queued jobs interrupted and releases reservations
      const r5 = store.reserveScan(visitor, { scanId: 'scan_restart', requestedUrl: `https://${domain}` });
      assert.equal(r5.allowed, true);
      store.updateJobProgress('scan_restart', { status: 'running' });
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 0);

      const restartedStore = new PersistentStore(tmpFile);
      assert.equal(
        restartedStore.getQuotaStatus(visitor, domain).pagesRemaining,
        10,
        'Server restart must release unfinished scan reservations'
      );
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('J0.3 (H3): Remaining-pages cap (maxPagesOverride), concurrent scans, GET /api/quota?domain=<d>, and RESCAN_SAME_PAGES_FREE', async () => {
    const tmpFile = createTempStorePath('j0_3_cap_concurrent');
    let srv: Awaited<ReturnType<typeof startTestServer>> | null = null;
    try {
      const store = new PersistentStore(tmpFile);
      const visitor = { visitorId: 'v_cap_tester' };
      const domain = 'capped-site.com';

      // Scan 1 reserves 10, commits 6 pages
      const res1 = store.reserveScan(visitor, {
        scanId: 'scan_c1',
        requestedUrl: `https://${domain}`
      });
      assert.equal(res1.allowed, true);
      assert.equal(res1.maxPagesOverride, 10);
      store.commitScan('scan_c1', 6, [
        `https://${domain}/`,
        `https://${domain}/p1`,
        `https://${domain}/p2`,
        `https://${domain}/p3`,
        `https://${domain}/p4`,
        `https://${domain}/p5`
      ]);

      // Scan 2 reserves min(10, remaining=4) -> maxPagesOverride = 4
      const res2 = store.reserveScan(visitor, {
        scanId: 'scan_c2',
        requestedUrl: `https://${domain}`
      });
      assert.equal(res2.allowed, true);
      assert.equal(res2.maxPagesOverride, 4, 'Second scan must only reserve remaining 4 pages');

      // Concurrent Scan 3 while Scan 2 is active for same (visitor, domain) -> P2c.1 single-flight reuses scan_c2!
      const res3Concurrent = store.reserveScan(visitor, {
        scanId: 'scan_c3',
        requestedUrl: `https://${domain}`
      });
      assert.equal(res3Concurrent.allowed, true);
      assert.equal(res3Concurrent.reused, true, 'Concurrent scan for same (visitor, domain) reuses active scan_c2');
      assert.equal(res3Concurrent.job?.scanId, 'scan_c2');

      // Release Scan 2 -> 4 pages available again
      store.releaseReservation('scan_c2');
      assert.equal(store.getQuotaStatus(visitor, domain).pagesRemaining, 4);

      // Test RESCAN_SAME_PAGES_FREE=true behavior
      const prevEnv = process.env.RESCAN_SAME_PAGES_FREE;
      process.env.RESCAN_SAME_PAGES_FREE = 'true';
      try {
        const resFree = store.reserveScan(visitor, {
          scanId: 'scan_free_rescan',
          requestedUrl: `https://${domain}`
        });
        assert.equal(resFree.allowed, true);
        // Commit the exact same URLs that were already committed in scan_c1
        store.commitScan('scan_free_rescan', 2, [
          `https://${domain}/`,
          `https://${domain}/p1`
        ]);
        assert.equal(
          store.getQuotaStatus(visitor, domain).pagesUsed,
          6,
          'When RESCAN_SAME_PAGES_FREE=true, rescanning already-committed URLs must not increase pagesUsed'
        );
      } finally {
        if (prevEnv === undefined) delete process.env.RESCAN_SAME_PAGES_FREE;
        else process.env.RESCAN_SAME_PAGES_FREE = prevEnv;
      }

      // Verify GET /api/quota?domain=capped-site.com and maxPagesOverride passed to provider
      let receivedMaxPagesOverride: number | undefined;
      const customProvider = {
        async runScan(scanId: string, req: any, onEvent: any, options?: any) {
          receivedMaxPagesOverride = options?.maxPagesOverride;
          const res = makeSampleScanResult(scanId, domain, 2);
          onEvent({ type: 'done', result: res });
          return res;
        }
      };

      const app = createApiApp({ store, provider: customProvider });
      srv = await startTestServer(app);

      const quotaRes = await fetch(`${srv.baseUrl}/api/quota?domain=${domain}`, {
        headers: { 'X-Visitor-Id': visitor.visitorId }
      });
      assert.equal(quotaRes.status, 200);
      const quotaJson: any = await quotaRes.json();
      assert.equal(quotaJson.ok, true);
      assert.equal(quotaJson.pagesUsed, 6);
      assert.equal(quotaJson.pagesRemaining, 4);
      assert.equal(quotaJson.exhausted, false);
      assert.ok(quotaJson.resetAt, 'resetAt must be returned when window is active');

      // Trigger scan via POST /api/scans -> provider must receive maxPagesOverride = 4
      const scanRes = await fetch(`${srv.baseUrl}/api/scans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': visitor.visitorId
        },
        body: JSON.stringify({ url: `https://${domain}` })
      });
      assert.equal(scanRes.status, 200);
      assert.equal(receivedMaxPagesOverride, 4, 'Server must pass maxPagesOverride to provider.runScan');
    } finally {
      if (srv) await srv.close();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('J0.4 (H4): Share tokens stored hashed, DELETE /api/scans/:id/share revokes (410 revoked), allowlist DTO replaces scanId and redacts secrets/private hosts, Cache-Control: no-store & rate limit', async () => {
    const tmpFile = createTempStorePath('j0_4_share');
    let srv: Awaited<ReturnType<typeof startTestServer>> | null = null;
    try {
      const store = new PersistentStore(tmpFile);
      const ownerId = 'v_owner_share_1';
      const foreignId = 'v_foreign_share_2';
      const scanId = 'scan_real_secret_id_999';

      const sampleReport = makeSampleScanResult(scanId, 'elabyad-eg.com', 2);
      (sampleReport as any).internalDebugField = 'DO_NOT_LEAK_ME';
      sampleReport.rescanComparison = {
        previousScanId: 'scan_prev_private_id',
        previousScanDate: new Date().toISOString(),
        resolvedRuleIds: [],
        stillOpenRuleIds: [],
        newRuleIds: []
      };
      store.saveScanReport({ visitorId: ownerId }, sampleReport);

      const app = createApiApp({ store });
      srv = await startTestServer(app);

      // 1. Create share token
      const createRes = await fetch(`${srv.baseUrl}/api/scans/${scanId}/share`, {
        method: 'POST',
        headers: { 'X-Visitor-Id': ownerId }
      });
      assert.equal(createRes.status, 200);
      const createData: any = await createRes.json();
      const rawToken = createData.shareToken;
      assert.ok(rawToken && rawToken.length >= 32);

      // Verify raw token is NOT stored in raw store snapshot (stored hashed only)
      const diskRaw = JSON.stringify(store.getRawStoreSnapshotForTest());
      assert.equal(diskRaw.includes(rawToken), false, 'Raw share token must NEVER be stored unhashed');

      // 2. GET /api/share/:token returns allowlist DTO with Cache-Control: no-store
      const getRes = await fetch(`${srv.baseUrl}/api/share/${rawToken}`);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.headers.get('cache-control'), 'no-store');
      assert.match(getRes.headers.get('x-robots-tag') || '', /noindex/i);

      const getJson: any = await getRes.json();
      const sharedReport = getJson.report;
      assert.ok(sharedReport);
      assert.notEqual(sharedReport.scanId, scanId, 'Shared report must replace real scanId with share id');
      assert.match(sharedReport.scanId, /^share_/, 'Shared report scanId should start with share_');
      assert.equal(sharedReport.internalDebugField, undefined, 'Non-allowlisted fields must be stripped');
      assert.equal(sharedReport.rescanComparison, undefined, 'Private rescanComparison must not be leaked in shared DTO');

      // Check secret & private host redaction in findings and prompts
      const serializedReport = JSON.stringify(sharedReport);
      assert.equal(serializedReport.includes('sk-proj-1234567890'), false, 'Secret sk-proj must be redacted');
      assert.equal(serializedReport.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false, 'Bearer token must be redacted');
      assert.equal(serializedReport.includes('AIzaSyD1234567890'), false, 'Google API key must be redacted');
      assert.equal(serializedReport.includes('127.0.0.1:8080'), false, 'Loopback host must be redacted');
      assert.equal(serializedReport.includes('192.168.1.55'), false, 'Private LAN host must be redacted');
      assert.equal(serializedReport.includes('10.0.0.5:3000'), false, 'Private 10.x host must be redacted');

      // 3. Foreign visitor cannot revoke share
      const revokeForeign = await fetch(`${srv.baseUrl}/api/scans/${scanId}/share`, {
        method: 'DELETE',
        headers: { 'X-Visitor-Id': foreignId }
      });
      assert.equal(revokeForeign.status, 404);

      // 4. Owner revokes share via DELETE /api/scans/:id/share -> subsequent GET returns 410 'revoked'
      const revokeOwner = await fetch(`${srv.baseUrl}/api/scans/${scanId}/share`, {
        method: 'DELETE',
        headers: { 'X-Visitor-Id': ownerId }
      });
      assert.equal(revokeOwner.status, 200);

      const getAfterRevoke = await fetch(`${srv.baseUrl}/api/share/${rawToken}`);
      assert.equal(getAfterRevoke.status, 410);
      const revokedJson: any = await getAfterRevoke.json();
      assert.equal(revokedJson.code, 'revoked');

      // 5. Rate-limit GET /api/share/:token per IP
      for (let i = 0; i < 60; i++) {
        store.checkEndpointRateLimit('127.0.0.1', 'share');
      }
      const rateLimitedShare = await fetch(`${srv.baseUrl}/api/share/${rawToken}`);
      assert.equal(rateLimitedShare.status, 429, 'GET /api/share/:token must enforce rate limiting');
    } finally {
      if (srv) await srv.close();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  test('J0.5 (H4): /api/feedback enforces Zod caps, visitor ownership, finding existence, server-derived ruleId/domain, and one vote per (visitor, scan, finding)', async () => {
    const tmpFile = createTempStorePath('j0_5_feedback');
    let srv: Awaited<ReturnType<typeof startTestServer>> | null = null;
    try {
      const store = new PersistentStore(tmpFile);
      const ownerId = 'v_fb_owner_1';
      const foreignId = 'v_fb_foreign_2';
      const scanId = 'scan_fb_test_1';

      const sampleReport = makeSampleScanResult(scanId, 'authentic-domain.com', 1);
      store.saveScanReport({ visitorId: ownerId }, sampleReport);

      const app = createApiApp({ store });
      srv = await startTestServer(app);

      // 1. Foreign visitor cannot vote on ownerId's scan
      const resForeign = await fetch(`${srv.baseUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': foreignId
        },
        body: JSON.stringify({
          scanId,
          findingId: 'f_real_1',
          vote: 'up'
        })
      });
      assert.equal(resForeign.status, 404, 'Foreign visitor feedback must be rejected with 404');

      // 2. Non-existent findingId in that report is rejected with 400
      const resFakeFinding = await fetch(`${srv.baseUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': ownerId
        },
        body: JSON.stringify({
          scanId,
          findingId: 'f_does_not_exist_in_report',
          vote: 'up'
        })
      });
      assert.equal(resFakeFinding.status, 400, 'Non-existent findingId must be rejected with 400');

      // 3. Zod cap: oversized findingId (> 128 chars) rejected with 400
      const resOversized = await fetch(`${srv.baseUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': ownerId
        },
        body: JSON.stringify({
          scanId,
          findingId: 'f_' + 'x'.repeat(200),
          vote: 'up'
        })
      });
      assert.equal(resOversized.status, 400, 'Oversized findingId must be rejected by Zod schema');

      // 4. Valid vote derives ruleId and domain from stored report (ignoring spoofed client fields)
      const resValidUp = await fetch(`${srv.baseUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': ownerId
        },
        body: JSON.stringify({
          scanId,
          findingId: 'f_real_1',
          ruleId: 'SPOOFED_CLIENT_RULE',
          domain: 'spoofed-client.com',
          vote: 'up'
        })
      });
      assert.equal(resValidUp.status, 200);
      const validUpData: any = await resValidUp.json();
      assert.equal(validUpData.feedback.ruleId, 'SEO001', 'Server must derive ruleId from stored report finding');
      assert.equal(validUpData.feedback.domain, 'authentic-domain.com', 'Server must derive domain from stored report');

      // 5. Second vote on same (visitor, scan, finding) replaces previous vote (one vote total)
      const resChangeVote = await fetch(`${srv.baseUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Visitor-Id': ownerId
        },
        body: JSON.stringify({
          scanId,
          findingId: 'f_real_1',
          vote: 'down'
        })
      });
      assert.equal(resChangeVote.status, 200);
      const stats = store.getFeedbackStats();
      assert.deepEqual(stats['SEO001'], { up: 0, down: 1, precision: 0 });
    } finally {
      if (srv) await srv.close();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
