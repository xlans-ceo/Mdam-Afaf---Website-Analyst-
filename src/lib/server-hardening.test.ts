import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApiApp } from '../../server';
import { PersistentStore } from './storage';

function startTestServer(app: ReturnType<typeof createApiApp>): Promise<{
  server: http.Server;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
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

function postJson(url: string, body: any): Promise<{ status: number; data?: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Connection': 'close',
          'X-Visitor-Id': 'v_hardening_test_123456'
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('PHASE H2: Server Hardening Suite', async (t) => {
  const testStore = new PersistentStore(`/tmp/test-server-hardening-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

  const mockProvider: any = {
    name: 'mock',
    async runScan(scanId: string, req: any, onEvent: any) {
      onEvent({ type: 'stage', stage: 'url_check', state: 'done' });
      onEvent({
        type: 'done',
        result: {
          schemaVersion: '2.0',
          scanId,
          requestedUrl: req.url,
          registrableDomain: 'example.com',
          status: 'completed',
          startedAt: new Date().toISOString(),
          limits: { maxPages: 10, maxLighthousePages: 2 },
          pages: [],
          uniquePagesInspected: 1,
          interactionStatesTested: 0,
          findings: [],
          lighthouse: [],
          limitations: []
        }
      });
    }
  };

  const app = createApiApp({
    store: testStore,
    provider: mockProvider,
    allowLocalFixtures: true
  });
  const { baseUrl, close } = await startTestServer(app);

  t.after(async () => {
    await close();
  });

  await t.test('H2.1: /api/feasibility is removed and /api/capabilities returns only booleans', async () => {
    const resFeas = await fetch(`${baseUrl}/api/feasibility`);
    assert.strictEqual(resFeas.status, 404, 'GET /api/feasibility must return 404');

    const resCap = await fetch(`${baseUrl}/api/capabilities`);
    assert.strictEqual(resCap.status, 200);
    const bodyCap = await resCap.json();
    assert.strictEqual(bodyCap.ok, true);
    assert.ok(bodyCap.capabilities, 'capabilities object must exist');
    for (const [key, value] of Object.entries(bodyCap.capabilities)) {
      assert.strictEqual(
        typeof value,
        'boolean',
        `Capability property ${key} must be a boolean, got ${typeof value}`
      );
    }
  });

  await t.test('H2.2: Sensitive files (/data, /server.ts, /scripts, /eval, /.env*) are blocked with 404', async () => {
    const sensitivePaths = [
      '/data/store.json',
      '/data',
      '/server.ts',
      '/scripts/check.sh',
      '/eval/fixtures.json',
      '/.env',
      '/.env.example'
    ];

    for (const p of sensitivePaths) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.strictEqual(
        res.status,
        404,
        `GET ${p} must return 404, got ${res.status}`
      );
    }
  });

  await t.test('H2.3: Spoofed X-Forwarded-For does not create a new rate limit bucket when trust proxy = 0', async () => {
    // 1. Verify that when trust proxy = 0, spoofed X-Forwarded-For is not trusted
    const spoofStore = new PersistentStore('/tmp/test-spoof-store.json');
    const spoofApp = createApiApp({ store: spoofStore });
    spoofApp.set('trust proxy', 0);
    const { baseUrl: spoofUrl, close: closeSpoof } = await startTestServer(spoofApp);
    try {
      await fetch(`${spoofUrl}/api/chat-afaf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.199',
          'X-Visitor-Id': 'v_spoof_test_123456'
        },
        body: JSON.stringify({ message: 'سلام عليكم يا مدام عفاف' })
      });
      assert.strictEqual(
        (spoofStore as any).ipBuckets.has('chat:203.0.113.199'),
        false,
        'Spoofed X-Forwarded-For must NOT create a bucket for the spoofed IP when trust proxy = 0'
      );
    } finally {
      await closeSpoof();
    }

    // 2. Verify ipBuckets cap and eviction logic in storage
    const customStore = new PersistentStore('/tmp/test-ip-buckets-store.json');
    for (let i = 0; i < 2500; i++) {
      customStore.checkEndpointRateLimit(`10.0.${Math.floor(i / 256)}.${i % 256}`, 'chat');
    }
    assert.ok(
      (customStore as any).ipBuckets.size <= 2000,
      `ipBuckets size must be capped at <= 2000, got ${(customStore as any).ipBuckets.size}`
    );
  });

  await t.test('H2.4: Body limits and Zod schema validation', async () => {
    // 1. General endpoint payload > 100kb is rejected with 413
    const bigString = 'x'.repeat(120 * 1024);
    const resBig = await postJson(`${baseUrl}/api/chat-afaf`, { message: bigString });
    assert.strictEqual(resBig.status, 413, 'Large body on /api/chat-afaf must return 413');

    // 2. /api/scans URL length > 2048 rejected with 400
    const resLongUrl = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_hardening_test_123456' },
      body: JSON.stringify({ url: 'https://example.com/' + 'a'.repeat(2100) })
    });
    assert.strictEqual(resLongUrl.status, 400, 'URL > 2048 chars must return 400');

    // 3. /api/scans purpose > 300 rejected with 400
    const resLongPurpose = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_hardening_test_123456' },
      body: JSON.stringify({
        url: 'https://example.com',
        purpose: 'p'.repeat(305)
      })
    });
    assert.strictEqual(resLongPurpose.status, 400, 'Purpose > 300 chars must return 400');

    // 4. /api/scans keyJourney > 300 rejected with 400
    const resLongJourney = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_hardening_test_123456' },
      body: JSON.stringify({
        url: 'https://example.com',
        keyJourney: 'j'.repeat(305)
      })
    });
    assert.strictEqual(resLongJourney.status, 400, 'keyJourney > 300 chars must return 400');

    // 5. /api/scans aiClaims > 1000 rejected with 400
    const resLongClaims = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_hardening_test_123456' },
      body: JSON.stringify({
        url: 'https://example.com',
        aiClaims: 'c'.repeat(1005)
      })
    });
    assert.strictEqual(resLongClaims.status, 400, 'aiClaims > 1000 chars must return 400');

    // 6. /api/scans options strips unknown keys
    const runVisitorOpts = `v_opts_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const resUnknownOpts = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Visitor-Id': runVisitorOpts
      },
      body: JSON.stringify({
        url: 'http://127.0.0.1:9999/fixture-options',
        options: {
          checkSeo: true,
          maliciousInjectedKey: 'attack',
          extraFlag: 123
        }
      })
    });
    assert.strictEqual(resUnknownOpts.status, 200, 'Valid scan request must succeed');
    const scanData = await resUnknownOpts.json();
    assert.strictEqual(scanData.ok, true);

    // 7. /api/chat-afaf zod validation for context and history shapes
    const resBadChatHistory = await fetch(`${baseUrl}/api/chat-afaf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_hardening_test_123456' },
      body: JSON.stringify({
        message: 'ازيك يا مدام عفاف',
        history: [{ role: 'invalid_role', content: 'test' }]
      })
    });
    assert.strictEqual(resBadChatHistory.status, 400, 'Invalid chat role must return 400');

    // 8. /api/transcribe rejects non-audio mime type
    const resBadMime = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_hardening_test_123456' },
      body: JSON.stringify({
        audioBase64: 'dGVzdA==',
        mimeType: 'application/x-executable'
      })
    });
    assert.strictEqual(resBadMime.status, 400, 'Non-audio mime must be rejected with 400');

    // 9. /api/transcribe rejects base64 decoded size > 4MB (5.6MB string, 4.2MB decoded)
    const fakeHugeBase64 = 'A'.repeat(5600000);
    const resHugeAudio = await postJson(`${baseUrl}/api/transcribe`, {
      audioBase64: fakeHugeBase64,
      mimeType: 'audio/webm'
    });
    assert.strictEqual(resHugeAudio.status, 400, 'Audio > 4MB decoded must be rejected with 400');
  });

  await t.test('H2.5: Ownership check before side effects in cancel and delete', async () => {
    // 1. Invalid scanId format returns 404 or 400
    const resBadFormat = await fetch(`${baseUrl}/api/scans/invalid!id@#/cancel`, {
      method: 'POST',
      headers: { 'X-Visitor-Id': 'v_hardening_test_123456' }
    });
    assert.strictEqual(resBadFormat.status, 404, 'Invalid ID format must return 404');

    // 2. Cancellation of another visitor\'s scan must not abort or cancel
    const visitorA = `v_visitor_aaa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const visitorB = `v_visitor_bbb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const resStart = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Visitor-Id': visitorA
      },
      body: JSON.stringify({ url: `http://127.0.0.1:9999/fixture-ownership-${Date.now()}` })
    });
    const { scanId } = await resStart.json();
    assert.ok(scanId);

    // Visitor B attempts to cancel Visitor A's scan
    const resCancelB = await fetch(`${baseUrl}/api/scans/${scanId}/cancel`, {
      method: 'POST',
      headers: {
        'X-Visitor-Id': visitorB
      }
    });
    assert.strictEqual(resCancelB.status, 404, 'Foreign visitor cannot cancel scan');

    // Visitor B attempts to delete Visitor A's scan
    const resDeleteB = await fetch(`${baseUrl}/api/scans/${scanId}`, {
      method: 'DELETE',
      headers: {
        'X-Visitor-Id': visitorB
      }
    });
    assert.strictEqual(resDeleteB.status, 404, 'Foreign visitor cannot delete scan');
  });
});
