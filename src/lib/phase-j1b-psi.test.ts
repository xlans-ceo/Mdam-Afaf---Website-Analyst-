import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCapabilities, getStartupPsiLogLine } from './capabilities';
import { fetchPsiMetricsIfAvailable, LiveProvider } from './providers/index';
import { runHonestChecks } from './honest-checks';

const FAKE_SECRET_KEY = 'AIzaSyTEST_DO_NOT_LEAK_998877665544332211';

describe('PHASE J1b: PSI Wiring, CWV Mapping, Error Classification & TTFB Tiers', () => {
  test('J1b.1: capabilities.psi and getStartupPsiLogLine reflect process.env.PSI_API_KEY without leaking the key', async () => {
    const prevKey = process.env.PSI_API_KEY;
    try {
      process.env.PSI_API_KEY = FAKE_SECRET_KEY;
      const logEnabled = getStartupPsiLogLine();
      assert.equal(logEnabled, 'PSI: enabled');
      assert.equal(logEnabled.includes(FAKE_SECRET_KEY), false);

      const capsEnabled = await detectCapabilities({ forceRefresh: true, skipNetworkProbe: true });
      assert.equal(capsEnabled.psi, true);

      delete process.env.PSI_API_KEY;
      const logDisabled = getStartupPsiLogLine();
      assert.equal(logDisabled, 'PSI: disabled (no key)');

      const capsDisabled = await detectCapabilities({ forceRefresh: true, skipNetworkProbe: true });
      assert.equal(capsDisabled.psi, false);
    } finally {
      if (prevKey === undefined) delete process.env.PSI_API_KEY;
      else process.env.PSI_API_KEY = prevKey;
      await detectCapabilities({ forceRefresh: true, skipNetworkProbe: true });
    }
  });

  test('J1b.2: fetchPsiMetricsIfAvailable handles success, timeout, 400, 403, 429, 5xx, malformed JSON, and key absent with stubbed fetch and never leaks key', async () => {
    const targetUrl = 'https://elabyad-eg.com/';

    // 1. Key absent -> no fetch call, returns key_absent NOT_MEASURED
    let fetchCalledWhenKeyAbsent = false;
    const absentRes = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: '',
      fetchImpl: async () => {
        fetchCalledWhenKeyAbsent = true;
        throw new Error('Should not be called');
      }
    });
    assert.equal(fetchCalledWhenKeyAbsent, false);
    assert.equal(absentRes.data, null);
    assert.equal(absentRes.failureCode, 'key_absent');
    assert.ok(absentRes.notMeasured);
    assert.equal(absentRes.notMeasured.id, 'nm_lcp_cls');

    // 2. Success (with lab metrics + CrUX field data)
    let requestedEndpoint = '';
    const successRes = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async (input: any) => {
        requestedEndpoint = String(input);
        return new Response(
          JSON.stringify({
            lighthouseResult: {
              audits: {
                'largest-contentful-paint': { numericValue: 3120 },
                'first-contentful-paint': { numericValue: 1450 },
                'cumulative-layout-shift': { numericValue: 0.042 },
                'total-blocking-time': { numericValue: 280 }
              },
              categories: {
                performance: { score: 0.74 },
                seo: { score: 0.92 }
              }
            },
            loadingExperience: {
              overall_category: 'AVERAGE',
              metrics: {
                LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2680, category: 'AVERAGE' },
                CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' },
                INTERACTION_TO_NEXT_PAINT: { percentile: 170, category: 'FAST' }
              }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    });
    assert.match(requestedEndpoint, /strategy=mobile/);
    assert.ok(successRes.data);
    assert.equal(successRes.data.lcpMs, 3120);
    assert.equal(successRes.data.cls, 0.042);
    assert.equal(successRes.data.tbtMs, 280);
    assert.equal(successRes.data.performanceScore, 74);
    assert.ok(successRes.data.fieldData, 'Expected fieldData when loadingExperience is present');
    assert.equal(successRes.data.fieldData?.lcpMs?.percentile, 2680);
    assert.equal(successRes.data.fieldData?.cls?.percentile, 0.05);

    // 3. Timeout
    const timeoutRes = await fetchPsiMetricsIfAvailable(targetUrl, 50, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async (_input: any, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error(`Request timed out for ${targetUrl}?key=${FAKE_SECRET_KEY}`));
          });
        });
      }
    });
    assert.equal(timeoutRes.data, null);
    assert.equal(timeoutRes.timedOut, true);
    assert.equal(timeoutRes.failureCode, 'timeout');
    assert.ok(timeoutRes.notMeasured);
    assert.equal(timeoutRes.notMeasured.checkId, 'PSI_TIMEOUT');
    assert.equal(JSON.stringify(timeoutRes).includes(FAKE_SECRET_KEY), false);

    // 4. HTTP 400 (invalid key)
    const res400 = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 400, message: `API key not valid: ${FAKE_SECRET_KEY}` } }), {
          status: 400
        })
    });
    assert.equal(res400.data, null);
    assert.equal(res400.failureCode, 'http_400');
    assert.equal(res400.notMeasured?.checkId, 'PSI_HTTP_400');
    assert.ok(res400.notMeasured?.reasonAr.includes('400'));
    assert.equal(JSON.stringify(res400).includes(FAKE_SECRET_KEY), false);

    // 5. HTTP 403 (API disabled or blocked)
    const res403 = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 403, message: 'PageSpeedonline API has not been used' } }), {
          status: 403
        })
    });
    assert.equal(res403.data, null);
    assert.equal(res403.failureCode, 'http_403');
    assert.equal(res403.notMeasured?.checkId, 'PSI_HTTP_403');
    assert.ok(res403.notMeasured?.reasonAr.includes('403'));
    assert.equal(JSON.stringify(res403).includes(FAKE_SECRET_KEY), false);

    // 6. HTTP 429 (quota exceeded)
    const res429 = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async () => new Response('Rate Limit Exceeded', { status: 429 })
    });
    assert.equal(res429.data, null);
    assert.equal(res429.failureCode, 'http_429');
    assert.equal(res429.notMeasured?.checkId, 'PSI_HTTP_429');
    assert.ok(res429.notMeasured?.reasonAr.includes('429'));
    assert.equal(JSON.stringify(res429).includes(FAKE_SECRET_KEY), false);

    // 7. HTTP 5xx
    const res502 = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async () => new Response('Bad Gateway', { status: 502 })
    });
    assert.equal(res502.data, null);
    assert.equal(res502.failureCode, 'http_5xx');
    assert.equal(res502.notMeasured?.checkId, 'PSI_HTTP_5XX');
    assert.equal(JSON.stringify(res502).includes(FAKE_SECRET_KEY), false);

    // 8. Malformed JSON / missing audits
    const resMalformed = await fetchPsiMetricsIfAvailable(targetUrl, 5000, undefined, {
      apiKey: FAKE_SECRET_KEY,
      fetchImpl: async () => new Response('<<<not valid json>>>', { status: 200 })
    });
    assert.equal(resMalformed.data, null);
    assert.equal(resMalformed.failureCode, 'malformed');
    assert.equal(resMalformed.notMeasured?.checkId, 'PSI_MALFORMED');
    assert.equal(JSON.stringify(resMalformed).includes(FAKE_SECRET_KEY), false);
  });

  test('J1b.3: runHonestChecks maps PSI LCP, CLS, TBT, performanceScore labeled "قياس معملي من جوجل" (method "psi") and optional fieldData', () => {
    const sampleHtml = '<!DOCTYPE html><html lang="ar"><head><title>اختبار</title><meta name="description" content="وصف كافي جداً لاختبار فحص الصفحة الرئيسية بدون أخطاء سيو"></head><body><h1>مرحبا</h1></body></html>';

    // Case A: Poor LCP (>4000ms), Needs Improvement CLS (0.15), Poor TBT (>600ms), Needs Improvement Score (62), with Field Data
    const checkPoor = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: sampleHtml,
      psiData: {
        lcpMs: 4500,
        cls: 0.15,
        tbtMs: 720,
        performanceScore: 62,
        fieldData: {
          source: 'origin',
          overallCategory: 'AVERAGE',
          lcpMs: { percentile: 2900, category: 'AVERAGE' },
          cls: { percentile: 0.04, category: 'FAST' }
        }
      }
    });

    const groupedPerf = checkPoor.allNormalizedFindings.find(f => f.id === 'f_perf_mobile_grouped');
    const fieldFinding = checkPoor.allNormalizedFindings.find(f => f.id === 'f_r013_psi_field');

    assert.ok(groupedPerf, 'Expected grouped mobile performance finding (P2b.3)');
    assert.equal(groupedPerf.method, 'psi');
    assert.equal(groupedPerf.severity, 'high', 'When field data confirms slow and LCP > 4000ms, severity is high');
    assert.equal(groupedPerf.titleAr, 'الأداء على الموبايل');
    assert.ok(groupedPerf.observed.includes('4500 ms'));
    assert.ok(groupedPerf.observed.includes('0.15'));
    assert.ok(groupedPerf.observed.includes('720 ms'));
    assert.ok(groupedPerf.observed.includes('62/100'));

    assert.ok(fieldFinding, 'Expected Field Data finding when field LCP > 2500ms');
    assert.equal(fieldFinding.method, 'psi');
    assert.ok(fieldFinding.titleAr?.includes('بيانات زوار حقيقيين من جوجل'));

    // Case B: All Good metrics, no field data returned by API
    const checkGood = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: sampleHtml,
      psiData: {
        lcpMs: 1850,
        cls: 0.02,
        tbtMs: 90,
        performanceScore: 95
      }
    });

    const passLcp = checkGood.passes.find(p => p.id === 'pass_psi_lcp');
    const passCls = checkGood.passes.find(p => p.id === 'pass_psi_cls');
    const passTbt = checkGood.passes.find(p => p.id === 'pass_psi_tbt');
    const passScore = checkGood.passes.find(p => p.id === 'pass_psi_score');
    const anyFieldItem =
      checkGood.passes.some(p => p.id === 'pass_psi_field') ||
      checkGood.allNormalizedFindings.some(f => f.id === 'f_r013_psi_field');

    assert.ok(passLcp && passLcp.method === 'psi' && passLcp.titleAr.includes('قياس معملي من جوجل'));
    assert.ok(passCls && passCls.method === 'psi' && passCls.titleAr.includes('قياس معملي من جوجل'));
    assert.ok(passTbt && passTbt.method === 'psi' && passTbt.titleAr.includes('قياس معملي من جوجل'));
    assert.ok(passScore && passScore.method === 'psi' && passScore.titleAr.includes('قياس معملي من جوجل'));
    assert.equal(anyFieldItem, false, 'Field data must NOT be added when API does not return it');
  });

  test('J1b.4: TTFB uses 3 tiers (<=800ms pass; 801-1800ms low recommendation; >1800ms medium) — 1284ms is NOT reported as "سريعة"', () => {
    const sampleHtml = '<!DOCTYPE html><html lang="ar"><head><title>اختبار</title><meta name="description" content="وصف كافي جداً لاختبار فحص الصفحة الرئيسية بدون أخطاء سيو"></head><body><h1>مرحبا</h1></body></html>';

    // 1. Good <= 800ms (e.g. 620ms) -> pass_ttfb
    const resGood = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: sampleHtml,
      ttfbMs: 620
    });
    assert.ok(resGood.passes.some(p => p.id === 'pass_ttfb'));
    assert.equal(resGood.allNormalizedFindings.some(f => f.id === 'f_perf_mobile_grouped'), false);

    // 2. Needs Improvement 801-1800ms (specifically 1284ms) -> low recommendation, NOT a pass
    const res1284 = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: sampleHtml,
      ttfbMs: 1284
    });
    assert.equal(
      res1284.passes.some(p => p.id === 'pass_ttfb'),
      false,
      '1284ms must NOT be reported as a fast TTFB pass'
    );
    const finding1284 = res1284.allNormalizedFindings.find(f => f.id === 'f_perf_mobile_grouped');
    assert.ok(finding1284, '1284ms must produce grouped performance finding');
    assert.equal(finding1284.kind, 'recommendation');
    assert.equal(finding1284.severity, 'low');

    // 3. Poor > 1800ms (e.g. 2200ms) -> medium finding
    const resSlow = runHonestChecks({
      url: 'https://elabyad-eg.com/',
      html: sampleHtml,
      ttfbMs: 2200
    });
    assert.equal(resSlow.passes.some(p => p.id === 'pass_ttfb'), false);
    const findingSlow = resSlow.allNormalizedFindings.find(f => f.id === 'f_perf_mobile_grouped');
    assert.ok(findingSlow, '2200ms must produce grouped performance finding');
    assert.equal(findingSlow.severity, 'medium');
  });
});
