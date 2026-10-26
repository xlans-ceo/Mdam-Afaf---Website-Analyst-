import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { LiveProvider } from './providers/index';
import { globalPsiCache, PsiCache } from './psi-cache';
import { computeDeploymentFingerprint } from './fingerprint';
import { clearOutboundFetchCacheForTesting } from './ssrf-validator';
import { runHonestChecks, computeVerdict } from './honest-checks';
import { buildSiteProfile } from './site-profiler';
import { buildPlatformAwareRepairPack } from './platform-adapter';
import { computeRescanDiff } from './storage';
import { ScanResult, Finding } from '../types/contract';

test('BATCH B1: Stabilize, Calibrate, Declutter Regression Suite', async (t) => {
  await t.test('B1.3a: PSI cache key includes deploymentFingerprint, rescans bypass cache, and results are labeled "قياس جديد" or "من الكاش (منذ N دقيقة)"', async () => {
    globalPsiCache.clear();
    clearOutboundFetchCacheForTesting();

    let currentHtml = '<html><head><title>Site V1</title><script src="/assets/index-aaa111.js"></script></head><body><h1>مرحبا بكم في موقعنا</h1></body></html>';
    let currentEtag = '"etag-v1"';
    let psiCallCount = 0;

    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'ETag': currentEtag,
      });
      res.end(currentHtml);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/fixtures/psi-site`;

    try {
      const provider = new LiveProvider();
      const mockPsiFetcher = async () => {
        psiCallCount++;
        return {
          available: true,
          source: 'lighthouse' as const,
          lcpMs: psiCallCount === 1 ? 3900 : 2100,
          cls: 0.05,
          tbtMs: 120,
          fcpMs: 1400,
          performanceScore: psiCallCount === 1 ? 65 : 92,
        };
      };

      // Scan 1: fresh measurement
      const res1 = await provider.runScan(
        'scan_b1_1',
        { url: baseUrl, locale: 'ar-EG' },
        () => {},
        { allowLocalFixtures: true, psiFetcher: mockPsiFetcher }
      );
      assert.equal(psiCallCount, 1, 'First scan must invoke PSI fetcher');
      assert.equal(res1.psiData?.cacheLabelAr, 'قياس جديد', 'Fresh scan must be labeled قياس جديد');
      assert.ok(res1.deploymentFingerprint, 'ScanResult must include deploymentFingerprint');

      // Scan 2 with SAME fingerprint (not marked isRescan): hits cache
      const res1Cached = await provider.runScan(
        'scan_b1_1_cached',
        { url: baseUrl, locale: 'ar-EG' },
        () => {},
        { allowLocalFixtures: true, psiFetcher: mockPsiFetcher }
      );
      assert.equal(psiCallCount, 1, 'Same fingerprint without isRescan should use PSI cache');
      assert.match(res1Cached.psiData?.cacheLabelAr || '', /^من الكاش \(منذ \d+ دقيقة\)$/, 'Cached PSI result must be labeled من الكاش (منذ N دقيقة)');

      // Scan 3 with CHANGED deployment fingerprint (bundle hash + ETag changed): must fetch fresh PSI!
      clearOutboundFetchCacheForTesting();
      currentHtml = '<html><head><title>Site V2</title><script src="/assets/index-bbb222.js"></script></head><body><h1>مرحبا بكم في موقعنا المحدث</h1></body></html>';
      currentEtag = '"etag-v2"';

      const res2 = await provider.runScan(
        'scan_b1_2',
        { url: baseUrl, locale: 'ar-EG' },
        () => {},
        { allowLocalFixtures: true, psiFetcher: mockPsiFetcher }
      );
      assert.equal(psiCallCount, 2, 'Changed deploymentFingerprint must bypass old PSI cache entry and fetch fresh PSI');
      assert.notEqual(res2.deploymentFingerprint, res1.deploymentFingerprint, 'deploymentFingerprint must change when script hashes/ETag change');
      assert.equal(res2.psiData?.lcpMs, 2100, 'Second scan with changed fingerprint must get fresh LCP (2100ms)');
      assert.equal(res2.psiData?.cacheLabelAr, 'قياس جديد', 'Freshly fetched PSI must be labeled قياس جديد');

      // Scan 4 with SAME fingerprint but isRescan=true: must bypass cache!
      const res3 = await provider.runScan(
        'scan_b1_3',
        { url: baseUrl, locale: 'ar-EG', isRescan: true } as any,
        () => {},
        { allowLocalFixtures: true, psiFetcher: mockPsiFetcher }
      );
      assert.equal(psiCallCount, 3, 'Any re-scan (isRescan=true) must bypass the PSI cache');
      assert.equal(res3.psiData?.cacheLabelAr, 'قياس جديد');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await t.test('B1.3b: Lab-only bands (LCP 2.5–4.0s, CLS 0.1–0.25, TBT 201–600ms -> low, recommendation, affectsVerdict=false; >4.0s -> medium/confirmed affectsVerdict=true)', () => {
    const cleanHtml = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>شركة النور للتوريدات الصناعية</title>
        <meta name="description" content="شركة النور لتوريد المعدات الصناعية المعتمدة في مصر" />
        <link rel="canonical" href="https://elnour.example.com/" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        <h1>شركة النور للتوريدات الصناعية</h1>
        <p>${'نص تفصيلي عن خدمات الشركة ومعداتها المعتمدة '.repeat(20)}</p>
      </body>
      </html>
    `;

    // Case 1: Lab metrics in "needs improvement" band (LCP 3.2s, CLS 0.15, TBT 350ms)
    const needsImprovementCheck = runHonestChecks({
      url: 'https://elnour.example.com/',
      statusCode: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self'",
      },
      html: cleanHtml,
      ttfbMs: 300,
      psiData: {
        available: true,
        source: 'lighthouse',
        lcpMs: 3200,
        cls: 0.15,
        tbtMs: 350,
        performanceScore: 72,
      },
      discoveryMeta: {
        robotsTxtPresent: true,
        sitemapXmlPresent: true,
      },
    });

    const perfFinding1 = needsImprovementCheck.findings.find((f) => f.ruleId === 'R013_PERF');
    assert.ok(perfFinding1, 'Must emit grouped performance finding for needs-improvement lab metrics');
    assert.equal(perfFinding1.severity, 'low', 'Needs-improvement lab metrics must be severity=low');
    assert.equal(perfFinding1.kind, 'recommendation', 'Needs-improvement lab metrics must be kind=recommendation');
    assert.equal(perfFinding1.affectsVerdict, false, 'Needs-improvement lab metrics must have affectsVerdict=false');
    assert.match(`${perfFinding1.titleAr} ${perfFinding1.observed}`, /تحسين مقترح/, 'Needs-improvement lab finding must say "تحسين مقترح"');

    const verdict1 = computeVerdict({
      findings: needsImprovementCheck.findings,
      passes: needsImprovementCheck.passes,
      notMeasured: needsImprovementCheck.notMeasured,
      pagesAnalyzed: 1,
    });
    assert.equal(
      verdict1.headlineAr,
      'مفيش مشاكل مؤكدة كبيرة في العينة',
      'A site whose only issue is a needs-improvement lab metric gets "مفيش مشاكل مؤكدة كبيرة في العينة" and never "محتاج شغل قبل الإطلاق"'
    );
    assert.notEqual(verdict1.level, 'needs_work_before_launch');

    // Case 2: Lab metric > 4.0s (LCP 4500ms) -> medium, confirmed, affectsVerdict=true
    const poorLabCheck = runHonestChecks({
      url: 'https://elnour.example.com/',
      statusCode: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self'",
      },
      html: cleanHtml,
      ttfbMs: 300,
      psiData: {
        available: true,
        source: 'lighthouse',
        lcpMs: 4500,
        cls: 0.05,
        tbtMs: 150,
      },
    });
    const perfFinding2 = poorLabCheck.findings.find((f) => f.ruleId === 'R013_PERF');
    assert.ok(perfFinding2, 'Must emit grouped performance finding for >4.0s LCP');
    assert.equal(perfFinding2.severity, 'medium', 'LCP > 4.0s in lab must be medium');
    assert.equal(perfFinding2.confidence, 'confirmed', 'LCP > 4.0s in lab must be confirmed');
    assert.equal(perfFinding2.affectsVerdict, true, 'LCP > 4.0s must have affectsVerdict=true');
  });

  await t.test('B1.3c: RC009 (export/market claims) fires only in site positioning, NOT in case-study/portfolio/blog/product listing context', () => {
    // Fixture 1: A case-study page mentioning "تصدير" -> NO finding
    const caseStudyHtml = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <title>دراسة حالة: تطوير نظام لمصنع يهدف إلى تصدير منتجاته</title>
        <meta name="description" content="تفاصيل مشروع عميلنا في قطاع التصدير" />
      </head>
      <body>
        <h1>مشروع تطوير منصة عميلنا</h1>
        <p>ساعدنا العميل في تصدير منتجاته إلى الأسواق العالمية عبر بناء لوحة تحكم حديثة.</p>
      </body>
      </html>
    `;
    const caseStudyCheck = runHonestChecks({
      url: 'https://agency.example.com/case-study/export-client',
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      html: caseStudyHtml,
      ttfbMs: 120,
    });
    const rc009OnCaseStudy = caseStudyCheck.findings.find((f) => f.ruleId === 'RC009');
    assert.equal(rc009OnCaseStudy, undefined, 'Case-study page mentioning "تصدير" must NOT trigger RC009');

    // Fixture 2: Homepage where "تصدير" is only in body paragraph inside portfolio section, NOT in title/meta/h1/nav/footer -> NO finding
    const bodyOnlyExportHtml = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <title>شركة ديجيتال للبرمجيات</title>
        <meta name="description" content="نبني مواقع وتطبيقات للشركات" />
      </head>
      <body>
        <nav><a href="/">الرئيسية</a> <a href="/contact">تواصل معنا</a></nav>
        <h1>شركة ديجيتال للبرمجيات وتصميم المواقع</h1>
        <section>
          <h2>سابقة أعمالنا ومشاريعنا</h2>
          <p>قمنا بتنفيذ موقع لشركة تعمل في تصدير الفواكه إلى أوروبا.</p>
        </section>
      </body>
      </html>
    `;
    const bodyOnlyCheck = runHonestChecks({
      url: 'https://agency.example.com/',
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      html: bodyOnlyExportHtml,
      ttfbMs: 120,
    });
    assert.equal(
      bodyOnlyCheck.findings.find((f) => f.ruleId === 'RC009'),
      undefined,
      'Export mention inside portfolio section only must NOT trigger RC009'
    );

    // Fixture 3: Site positioning (hero h1 / title) claims export without logistics details -> fires as low, recommendation, affectsVerdict=false
    const positioningExportHtml = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <title>مصنع الأهرام للتصدير لجميع دول العالم</title>
        <meta name="description" content="رواد تصدير الرخام والجرانيت عالمياً" />
      </head>
      <body>
        <h1>مصنع الأهرام للتصدير الدولي</h1>
        <p>نقدم أفضل أنواع الرخام والجرانيت بأعلى جودة.</p>
      </body>
      </html>
    `;
    const positioningCheck = runHonestChecks({
      url: 'https://ahram-marble.example.com/',
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      html: positioningExportHtml,
      ttfbMs: 120,
    });
    const rc009Finding = positioningCheck.findings.find((f) => f.ruleId === 'RC009');
    assert.ok(rc009Finding, 'Positioning export claim without details should trigger RC009');
    assert.equal(rc009Finding.severity, 'low');
    assert.equal(rc009Finding.kind, 'recommendation');
    assert.equal(rc009Finding.affectsVerdict, false);
  });

  await t.test('B1.3d, B1.3e, B1.3f: AI Builders registry (lovable verified=true), platform="ai_builder", staging domain note, and tool-aware headers advice', async () => {
    const aiBuildersPath = path.resolve(process.cwd(), 'src/knowledge/ai-builders.ts');
    assert.ok(fs.existsSync(aiBuildersPath), 'src/knowledge/ai-builders.ts must exist');
    const buildersMod = await import('../knowledge/ai-builders.js');
    assert.ok(Array.isArray(buildersMod.AI_BUILDERS), 'AI_BUILDERS array must be exported');

    const lovableEntry = buildersMod.AI_BUILDERS.find((b: any) => b.id === 'lovable');
    assert.ok(lovableEntry, 'lovable entry must exist');
    assert.equal(lovableEntry.verified, true, 'lovable must have verified=true');
    assert.ok(lovableEntry.hostSuffixes.includes('lovable.app'), 'lovable must include lovable.app hostSuffix');

    for (const candidateId of ['replit', 'base44', 'bolt', 'v0', 'emergent', 'ai-studio']) {
      const candidateEntry: any = buildersMod.AI_BUILDERS.find((b: any) => b.id === candidateId);
      assert.ok(candidateEntry, `Candidate ${candidateId} must exist in AI_BUILDERS`);
      assert.equal(candidateEntry.verified, false, `Candidate ${candidateId} must have verified=false`);
      assert.equal(candidateEntry.needsReview, true, `Candidate ${candidateId} must have needsReview=true`);
    }

    const lovableHtml = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <title>شركة إكسلانس</title>
        <meta name="description" content="شركة إكسلانس للحلول الرقمية" />
        <script type="module" crossorigin src="/assets/index-D8x9a1.js"></script>
      </head>
      <body>
        <div id="root">
          <h1>شركة إكسلانس للحلول الرقمية</h1>
          <p>${'خدمات متكاملة للشركات في مصر والخليج '.repeat(15)}</p>
          <a href="mailto:info@xlans-company.com">info@xlans-company.com</a>
        </div>
      </body>
      </html>
    `;

    const profile = buildSiteProfile({
      url: 'https://xlans.lovable.app/',
      html: lovableHtml,
      headers: { 'content-type': 'text/html' },
    });

    assert.equal(profile.platform, 'ai_builder', 'Lovable site must have platform="ai_builder"');
    assert.equal(profile.builder, 'lovable', 'Lovable site must have builder="lovable"');
    assert.equal(profile.platformConfidence, 'high', 'Host suffix match on lovable.app must give high confidence');

    const checkRes = runHonestChecks({
      url: 'https://xlans.lovable.app/',
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      html: lovableHtml,
      ttfbMs: 180,
      siteProfile: profile,
    });

    // B1.3e: Staging domain note replaces RC002 email-domain question
    const stagingNote = checkRes.findings.find((f) => f.ruleId === 'RC002');
    assert.ok(stagingNote, 'Must emit staging domain note when builder-hosted domain differs from contact email domain');
    assert.equal(stagingNote.severity, 'low');
    assert.equal(stagingNote.kind, 'recommendation');
    assert.equal(stagingNote.affectsVerdict, false);
    assert.equal(stagingNote.needsHumanDecision, true);
    assert.ok(
      stagingNote.observed.includes('الموقع لسه على دومين تجريبي من المنصة (xlans.lovable.app). لما تربط دومينك الأساسي راجع الإيميل والروابط تاني.') ||
      (stagingNote.titleAr || '').includes('الموقع لسه على دومين تجريبي من المنصة (xlans.lovable.app). لما تربط دومينك الأساسي راجع الإيميل والروابط تاني.'),
      'Staging domain note must match exact required Arabic text'
    );

    // B1.3f: Tool-aware headers advice (never mention Vercel/Cloudflare panels)
    const headersFinding = checkRes.findings.find((f) => f.ruleId === 'R010');
    assert.ok(headersFinding, 'Missing security headers should emit R010');
    assert.equal(headersFinding.severity, 'low');
    assert.equal(headersFinding.kind, 'recommendation');
    assert.equal(headersFinding.affectsVerdict, false);
    assert.match(headersFinding.titleAr || '', /تحسين حماية/);
    assert.match(
      headersFinding.recommendedFix,
      /اطلب من الأداة تضيف الهيدرز في طبقة السيرفر\/الـ middleware، وتأكد إن المعاينة بتاعتها لسه شغالة/
    );
    assert.doesNotMatch(headersFinding.recommendedFix, /Vercel|Cloudflare/i, 'Builder-hosted site headers advice must never mention Vercel/Cloudflare');

    // B1.3d: Fix prompt says "Tool: Lovable" instead of a stack line
    const repairPack = buildPlatformAwareRepairPack({
      url: 'https://xlans.lovable.app/',
      profile,
      findings: checkRes.findings,
    });
    assert.ok(repairPack.aiRepairPrompt.includes('Tool: Lovable'), 'Fix prompt must include "Tool: Lovable" instead of a Stack line');
    assert.ok(!repairPack.aiRepairPrompt.includes('Stack:'), 'Fix prompt for ai_builder must not include a Stack: line');
  });

  await t.test('B1.3g: robots.txt, sitemap.xml, and favicon link rules (low, recommendation, affectsVerdict=false, each with a PASS when present)', () => {
    const htmlWithFavicon = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <title>موقع مكتمل</title>
        <link rel="icon" href="/favicon.png" />
      </head>
      <body><h1>موقع مكتمل</h1></body>
      </html>
    `;
    const presentRes = runHonestChecks({
      url: 'https://complete.example.com/',
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      html: htmlWithFavicon,
      ttfbMs: 100,
      discoveryMeta: {
        robotsTxtPresent: true,
        sitemapXmlPresent: true,
      },
    });
    assert.ok(presentRes.passes.some((p) => p.id === 'pass_favicon'), 'Must emit PASS when favicon link is present');
    assert.ok(presentRes.passes.some((p) => p.id === 'pass_robots_txt'), 'Must emit PASS when robots.txt is present');
    assert.ok(presentRes.passes.some((p) => p.id === 'pass_sitemap_xml'), 'Must emit PASS when sitemap.xml is present');

    const htmlWithoutFavicon = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head><title>موقع ناقص</title></head>
      <body><h1>موقع ناقص</h1></body>
      </html>
    `;
    const missingRes = runHonestChecks({
      url: 'https://missing.example.com/',
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      html: htmlWithoutFavicon,
      ttfbMs: 100,
      discoveryMeta: {
        robotsTxtPresent: false,
        sitemapXmlPresent: false,
      },
    });

    for (const ruleId of ['R_FAVICON', 'R_ROBOTS', 'R_SITEMAP']) {
      const f = missingRes.findings.find((item) => item.ruleId === ruleId);
      assert.ok(f, `Missing ${ruleId} must emit a finding`);
      assert.equal(f.severity, 'low', `${ruleId} must be low severity`);
      assert.equal(f.kind, 'recommendation', `${ruleId} must be recommendation`);
      assert.equal(f.affectsVerdict, false, `${ruleId} must have affectsVerdict=false`);
    }
  });

  await t.test('B1.3h: Rescan comparison compares by fingerprint and, for grouped performance finding, by metric (before -> after with delta, labeled lab)', () => {
    const prevScan: ScanResult = {
      schemaVersion: '2.0',
      scanId: 'scan_prev',
      requestedUrl: 'https://example.com',
      registrableDomain: 'example.com',
      status: 'completed',
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      finishedAt: new Date(Date.now() - 3600_000).toISOString(),
      limits: { maxPages: 10 },
      pages: [],
      uniquePagesInspected: 1,
      lighthouse: [],
      limitations: [],
      findings: [
        {
          id: 'f_r013_perf',
          ruleId: 'R013_PERF',
          category: 'performance',
          title: 'Mobile Performance',
          titleAr: 'الأداء على الموبايل',
          kind: 'confirmed_defect',
          severity: 'medium',
          confidence: 'confirmed',
          affectsVerdict: true,
          method: 'psi',
          source: 'lighthouse',
          url: 'https://example.com',
          occurrences: 1,
          observed: 'LCP 4.5s',
          steps: [],
          evidence: [],
          recommendedFix: '',
        },
      ],
      passes: [],
      notMeasured: [],
      capabilities: {} as any,
      psiData: {
        available: true,
        source: 'lighthouse',
        lcpMs: 4500,
        cls: 0.22,
        tbtMs: 480,
      },
    };

    const currScan: ScanResult = {
      ...prevScan,
      scanId: 'scan_curr',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      psiData: {
        available: true,
        source: 'lighthouse',
        lcpMs: 2800,
        cls: 0.08,
        tbtMs: 180,
      },
    };

    const diff = computeRescanDiff(prevScan, currScan);
    assert.ok(Array.isArray(diff.metricDeltas), 'RescanComparison must include metricDeltas');
    assert.ok(diff.metricDeltas!.length >= 3, 'Must compare LCP, CLS, and TBT');
    const lcpDelta = diff.metricDeltas!.find((m) => m.metric === 'LCP');
    assert.ok(lcpDelta, 'Must include LCP delta');
    assert.equal(lcpDelta.before, 4500);
    assert.equal(lcpDelta.after, 2800);
    assert.equal(lcpDelta.delta, -1700);
    assert.equal(lcpDelta.statusAr, 'تحسّن');
    assert.equal(lcpDelta.note, 'lab');
  });

  await t.test('B1.4: Landing page decluttered via OFF feature flags (methodology panel, MOCK sample buttons, examples, voice teaser OFF)', async () => {
    const limitsMod = await import('../config/limits.js');
    assert.ok(limitsMod.FEATURE_FLAGS, 'FEATURE_FLAGS must be exported from src/config/limits.ts');
    assert.equal(limitsMod.FEATURE_FLAGS.SHOW_METHODOLOGY_PANEL, false);
    assert.equal(limitsMod.FEATURE_FLAGS.SHOW_MOCK_SAMPLE_BUTTONS, false);
    assert.equal(limitsMod.FEATURE_FLAGS.SHOW_LANDING_EXAMPLES, false);
    assert.equal(limitsMod.FEATURE_FLAGS.SHOW_VOICE_TEASER, false);

    const heroSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/MadamAfafHero.tsx'), 'utf-8');
    assert.ok(heroSrc.includes('FEATURE_FLAGS.SHOW_METHODOLOGY_PANEL'), 'Methodology panel must be gated by FEATURE_FLAGS.SHOW_METHODOLOGY_PANEL');
    assert.ok(heroSrc.includes('FEATURE_FLAGS.SHOW_MOCK_SAMPLE_BUTTONS'), 'Mock sample buttons must be gated by FEATURE_FLAGS.SHOW_MOCK_SAMPLE_BUTTONS');
    assert.ok(heroSrc.includes('FEATURE_FLAGS.SHOW_LANDING_EXAMPLES'), 'Examples must be gated by FEATURE_FLAGS.SHOW_LANDING_EXAMPLES');
    assert.ok(heroSrc.includes('FEATURE_FLAGS.SHOW_VOICE_TEASER'), 'Voice teaser must be gated by FEATURE_FLAGS.SHOW_VOICE_TEASER');
  });
});
