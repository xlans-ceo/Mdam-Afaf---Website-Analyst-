/**
 * Madam Afaf Smoke Test Script (B4.6)
 * Usage: npm run smoke -- [TARGET_URL]
 */
import http from 'node:http';
import https from 'node:https';

const targetBaseUrl = (process.argv[2] || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

async function fetchUrl(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; headers: Record<string, string>; body: string; json: any }> {
  const url = new URL(path, targetBaseUrl);
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          let json: any = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // not json
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
          }
          resolve({
            status: res.statusCode || 0,
            headers,
            body: raw,
            json
          });
        });
      }
    );

    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runSmokeTests() {
  console.log('================================================================');
  console.log(`         فحص الدخان المباشر (Smoke Test) — ${targetBaseUrl}         `);
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail: string) {
    if (condition) {
      console.log(`[PASS] ${testName} (${detail})`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} (${detail})`);
      failed++;
    }
  }

  try {
    // 1. Health + Badge
    const health = await fetchUrl('/api/health');
    assert(
      health.status === 200 && health.json?.ok === true && Boolean(health.json?.release?.badgeTextAr),
      '1. Health & Release Badge',
      `Status: ${health.status}, Stage: ${health.json?.release?.stage}`
    );

    // 2. Data & Server Isolation (404)
    const dataCheck = await fetchUrl('/data/store.json');
    const serverCheck = await fetchUrl('/server.ts');
    assert(
      dataCheck.status === 404 && serverCheck.status === 404,
      '2. Protected Paths Hidden (404)',
      `/data: ${dataCheck.status}, /server.ts: ${serverCheck.status}`
    );

    // 3. CSRF Guard: POST without X-Visitor-Id -> 403
    const csrfCheck = await fetchUrl('/api/scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert(
      csrfCheck.status === 403,
      '3. CSRF Guard Enforced',
      `POST without header returned ${csrfCheck.status}`
    );

    // 4. Quota endpoint
    const quotaCheck = await fetchUrl('/api/quota?domain=example.com', {
      headers: { 'X-Visitor-Id': 'v_smoke_test_visitor_01' }
    });
    assert(
      quotaCheck.status === 200 && quotaCheck.json?.ok === true,
      '4. Quota Status Available',
      `Pages Remaining: ${quotaCheck.json?.pagesRemaining}`
    );

    // 5. Admin Token Gated (or disabled)
    const adminCheck = await fetchUrl('/api/admin/feedback');
    assert(
      adminCheck.status === 401 || adminCheck.status === 404,
      '5. Admin Protected',
      `GET /api/admin/feedback without token returned ${adminCheck.status}`
    );

    // 6. Static Legal Pages (200)
    const privacyCheck = await fetchUrl('/privacy');
    const termsCheck = await fetchUrl('/terms');
    assert(
      privacyCheck.status === 200 && termsCheck.status === 200,
      '6. Legal Pages Accessible',
      `/privacy: ${privacyCheck.status}, /terms: ${termsCheck.status}`
    );

    console.log('\n================================================================');
    console.log(`Smoke Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err: any) {
    console.error('Smoke tests failed with network or runtime error:', err?.message || err);
    process.exit(1);
  }
}

runSmokeTests();
