import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PersistentStore, computeRescanDiff } from './storage';
import { LiveProvider } from './providers/index';
import { buildPlatformAwareRepairPack } from './platform-adapter';
import { buildRepairPrompts } from './repair-prompt-builder';
import { clearOutboundFetchCacheForTesting } from './ssrf-validator';
import { PsiCache } from './psi-cache';
import { runHonestChecks } from './honest-checks';
import { buildSiteProfile } from './site-profiler';
import { SCAN_LIMITS } from '../config/limits';
import { Finding, ScanResult, SiteProfile } from '../types/contract';

function createTempStorePath(label: string): string {
  return `/tmp/afaf_b3_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
}

test('BATCH B3: The Re-scan Loop Regression Suite (B3.1..B3.7)', async (t) => {
  await t.test('B3.1: reviewNumber sequence (1, 2, 3), MAX_REVIEWS=3 limit, same-pages re-scan consumes 1 review and 0 page budget, remaining-pages consumes both review and page budget', async () => {
    assert.equal((SCAN_LIMITS as any).MAX_REVIEWS_PER_DOMAIN_PER_WINDOW, 3, 'MAX_REVIEWS_PER_DOMAIN_PER_WINDOW must be 3');

    const tmpFile = createTempStorePath('b3_1_quota');
    try {
      const store = new PersistentStore(tmpFile);
      const visitor = { visitorId: 'v_b3_reviewer_1' };
      const domain = 'lovable-client.com';

      // Initial quota check: 0 reviews used, 3 remaining, 0 pages used, 10 remaining
      const q0 = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(q0.reviewsUsed, 0);
      assert.equal(q0.reviewsRemaining, 3);
      assert.equal(q0.maxReviews, 3);
      assert.equal(q0.pagesUsed, 0);
      assert.equal(q0.pagesRemaining, 10);

      // Review 1: initial scan of 4 pages (out of 6 discovered)
      const r1 = store.reserveScan(visitor, {
        scanId: 'scan_b3_r1',
        requestedUrl: `https://${domain}/`,
        normalizedUrl: `https://${domain}/`,
        registrableDomain: domain,
      });
      assert.equal(r1.allowed, true);

      const rep1 = store.saveScanReport(visitor, {
        schemaVersion: '2.0',
        scanId: 'scan_b3_r1',
        requestedUrl: `https://${domain}/`,
        finalUrl: `https://${domain}/`,
        registrableDomain: domain,
        status: 'completed',
        startedAt: new Date(Date.now() - 30000).toISOString(),
        finishedAt: new Date(Date.now() - 25000).toISOString(),
        limits: { maxPages: 10 },
        pages: [
          { url: `https://${domain}/`, viewportsChecked: [] },
          { url: `https://${domain}/about`, viewportsChecked: [] },
          { url: `https://${domain}/services`, viewportsChecked: [] },
          { url: `https://${domain}/contact`, viewportsChecked: [] },
        ],
        discoveredNotScanned: [
          `https://${domain}/pricing`,
          `https://${domain}/faq`,
        ],
        uniquePagesInspected: 4,
        findings: [],
        passes: [],
        notMeasured: [],
        lighthouse: [],
        limitations: [],
      } as any);

      assert.equal(rep1.reviewNumber, 1, 'First scan must have reviewNumber=1');
      assert.equal(rep1.previousScanId, undefined);

      const qAfter1 = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(qAfter1.reviewsUsed, 1, 'After 1st scan, reviewsUsed must be 1');
      assert.equal(qAfter1.reviewsRemaining, 2, 'After 1st scan, reviewsRemaining must be 2');
      assert.equal(qAfter1.pagesUsed, 4, 'After 1st scan of 4 pages, pagesUsed must be 4');
      assert.equal(qAfter1.pagesRemaining, 6, 'After 1st scan of 4 pages, pagesRemaining must be 6');

      // Review 2: "نفس الصفحات تاني (للتأكد من الإصلاح)" (same_pages mode) -> consumes 1 review and NO page budget
      const r2 = store.reserveScan(visitor, {
        scanId: 'scan_b3_r2',
        requestedUrl: `https://${domain}/`,
        normalizedUrl: `https://${domain}/`,
        registrableDomain: domain,
        rescanMode: 'same_pages',
      } as any);
      assert.equal(r2.allowed, true);

      const rep2 = store.saveScanReport(
        visitor,
        {
          schemaVersion: '2.0',
          scanId: 'scan_b3_r2',
          requestedUrl: `https://${domain}/`,
          finalUrl: `https://${domain}/`,
          registrableDomain: domain,
          status: 'completed',
          startedAt: new Date(Date.now() - 20000).toISOString(),
          finishedAt: new Date(Date.now() - 15000).toISOString(),
          limits: { maxPages: 10 },
          rescanMode: 'same_pages',
          pages: [
            { url: `https://${domain}/`, viewportsChecked: [] },
            { url: `https://${domain}/about`, viewportsChecked: [] },
            { url: `https://${domain}/services`, viewportsChecked: [] },
            { url: `https://${domain}/contact`, viewportsChecked: [] },
          ],
          discoveredNotScanned: [
            `https://${domain}/pricing`,
            `https://${domain}/faq`,
          ],
          uniquePagesInspected: 4,
          findings: [],
          passes: [],
          notMeasured: [],
          lighthouse: [],
          limitations: [],
        } as any
      );

      assert.equal(rep2.reviewNumber, 2, 'Second scan must have reviewNumber=2');
      assert.equal(rep2.previousScanId, 'scan_b3_r1', 'Second scan must reference previousScanId=scan_b3_r1');

      const qAfter2 = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(qAfter2.reviewsUsed, 2, 'same_pages re-scan must consume 1 review (reviewsUsed=2)');
      assert.equal(qAfter2.reviewsRemaining, 1, 'reviewsRemaining must be 1');
      assert.equal(qAfter2.pagesUsed, 4, 'same_pages re-scan must consume NO page budget (pagesUsed stays 4)');
      assert.equal(qAfter2.pagesRemaining, 6, 'pagesRemaining stays 6');

      // Review 3: "باقي الصفحات" (remaining_pages mode) -> scans next 2 unscanned pages and consumes 1 review + 2 pages budget
      const r3 = store.reserveScan(visitor, {
        scanId: 'scan_b3_r3',
        requestedUrl: `https://${domain}/`,
        normalizedUrl: `https://${domain}/`,
        registrableDomain: domain,
        rescanMode: 'remaining_pages',
      } as any);
      assert.equal(r3.allowed, true);

      const rep3 = store.saveScanReport(
        visitor,
        {
          schemaVersion: '2.0',
          scanId: 'scan_b3_r3',
          requestedUrl: `https://${domain}/`,
          finalUrl: `https://${domain}/`,
          registrableDomain: domain,
          status: 'completed',
          startedAt: new Date(Date.now() - 10000).toISOString(),
          finishedAt: new Date(Date.now() - 5000).toISOString(),
          limits: { maxPages: 10 },
          rescanMode: 'remaining_pages',
          pages: [
            { url: `https://${domain}/pricing`, viewportsChecked: [] },
            { url: `https://${domain}/faq`, viewportsChecked: [] },
          ],
          discoveredNotScanned: [],
          uniquePagesInspected: 2,
          findings: [],
          passes: [],
          notMeasured: [],
          lighthouse: [],
          limitations: [],
        } as any
      );

      assert.equal(rep3.reviewNumber, 3, 'Third scan must have reviewNumber=3');
      assert.equal(rep3.previousScanId, 'scan_b3_r2', 'Third scan must reference previousScanId=scan_b3_r2');

      const qAfter3 = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(qAfter3.reviewsUsed, 3, 'After 3rd scan, reviewsUsed must be 3');
      assert.equal(qAfter3.reviewsRemaining, 0, 'After 3rd scan, reviewsRemaining must be 0');
      assert.equal(qAfter3.pagesUsed, 6, 'remaining_pages re-scan must consume 2 page budget (4 + 2 = 6)');
      assert.equal(qAfter3.pagesRemaining, 4, 'pagesRemaining must be 4');
      assert.equal(qAfter3.exhausted, true, 'Quota must be marked exhausted when reviewsRemaining === 0');

      // 4th attempt on same domain within 10h window must be blocked because MAX_REVIEWS=3 is reached
      const r4 = store.reserveScan(visitor, {
        scanId: 'scan_b3_r4_blocked',
        requestedUrl: `https://${domain}/`,
        normalizedUrl: `https://${domain}/`,
        registrableDomain: domain,
        rescanMode: 'same_pages',
      } as any);
      assert.equal(r4.allowed, false, '4th review in 10-hour window must be rejected');
      assert.match(r4.reasonAr || '', /3 مراجعات/, 'Exhausted message must mention 3 مراجعات');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  await t.test('B3.1 & B3.3: LiveProvider supports same_pages / remaining_pages discovery and stops early without consuming quota when deploymentFingerprint is unchanged (unless forceRescan=true)', async () => {
    clearOutboundFetchCacheForTesting();
    let currentHtml = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>الرئيسية V1</title><script src="/fixtures/app-v1.js"></script></head><body><nav><a href="/fixtures/about">من نحن</a><a href="/fixtures/contact">تواصل</a><a href="/fixtures/services">خدماتنا</a></nav><h1>الرئيسية V1</h1><p>${'محتوى الصفحة الرئيسية '.repeat(20)}</p></body></html>`;
    let currentEtag = '"deploy-v1"';

    const server = http.createServer((req, res) => {
      const u = req.url || '/fixtures/home';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ETag: currentEtag,
      });
      if (u === '/fixtures/home' || u === '/') {
        res.end(currentHtml);
      } else {
        res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>صفحة ${u}</title></head><body><h1>صفحة ${u}</h1><p>${'محتوى داخلي '.repeat(20)}</p></body></html>`);
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/fixtures/home`;

    const tmpFile = createTempStorePath('b3_3_early_stop');
    try {
      const store = new PersistentStore(tmpFile);
      const visitor = { visitorId: 'v_b3_early_stop' };
      const domain = 'example-rescan.com';
      const provider = new LiveProvider();

      // 1. First scan with maxPagesOverride = 2 -> scans '/fixtures/home' and '/fixtures/contact', leaves '/fixtures/about' and '/fixtures/services' in discoveredNotScanned
      const res1 = await provider.runScan(
        'scan_live_1',
        { url: baseUrl, locale: 'ar-EG' },
        () => {},
        { allowLocalFixtures: true, maxPagesOverride: 2 }
      );
      res1.registrableDomain = domain;
      store.saveScanReport(visitor, res1);

      assert.equal(res1.pages.length, 2, 'First scan with maxPagesOverride=2 must inspect 2 pages');
      assert.ok(Array.isArray((res1 as any).discoveredNotScanned), 'ScanResult must store discoveredNotScanned');
      assert.equal((res1 as any).discoveredNotScanned.length, 2, 'Remaining 2 discovered pages must be stored in discoveredNotScanned');

      const qAfter1 = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(qAfter1.reviewsUsed, 1);
      assert.equal(qAfter1.pagesUsed, 2);

      // 2. Re-scan when site was NOT republished (identical deploymentFingerprint) and forceRescan is false -> STOP EARLY!
      const r2 = store.reserveScan(visitor, {
        scanId: 'scan_live_2_unchanged',
        requestedUrl: baseUrl,
        normalizedUrl: baseUrl,
        registrableDomain: domain,
      });
      assert.equal(r2.allowed, true);

      const res2Unchanged = await provider.runScan(
        'scan_live_2_unchanged',
        {
          url: baseUrl,
          locale: 'ar-EG',
          isRescan: true,
          previousDeploymentFingerprint: res1.deploymentFingerprint,
          forceRescan: false,
        } as any,
        () => {},
        { allowLocalFixtures: true }
      );

      assert.equal(
        (res2Unchanged as any).unchangedDeployment,
        true,
        'Unchanged deployment fingerprint without forceRescan must set unchangedDeployment=true'
      );
      assert.equal(
        (res2Unchanged as any).unchangedMessageAr,
        'ما لقيتش تغيير في الموقع المنشور. غالبًا التعديلات ما اتنشرتش.',
        'Must return exact Arabic early-stop message'
      );

      // Saving/handling an unchangedDeployment result must NOT consume a review or page quota!
      res2Unchanged.registrableDomain = domain;
      store.saveScanReport(visitor, res2Unchanged);
      const qAfterUnchanged = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(qAfterUnchanged.reviewsUsed, 1, 'Early stop on unchanged fingerprint must NOT consume a review');
      assert.equal(qAfterUnchanged.pagesUsed, 2, 'Early stop on unchanged fingerprint must NOT consume page quota');

      // 3. User clicks "افحص على أي حال" (forceRescan=true) -> proceeds even with identical fingerprint and consumes 1 review (0 pages in same_pages mode)
      const r3Force = store.reserveScan(visitor, {
        scanId: 'scan_live_3_forced',
        requestedUrl: baseUrl,
        normalizedUrl: baseUrl,
        registrableDomain: domain,
        rescanMode: 'same_pages',
      } as any);
      assert.equal(r3Force.allowed, true);

      const res3Forced = await provider.runScan(
        'scan_live_3_forced',
        {
          url: baseUrl,
          locale: 'ar-EG',
          isRescan: true,
          previousDeploymentFingerprint: res1.deploymentFingerprint,
          forceRescan: true,
          rescanMode: 'same_pages',
          targetUrls: res1.pages.map((p) => p.url),
        } as any,
        () => {},
        { allowLocalFixtures: true }
      );
      assert.ok(!(res3Forced as any).unchangedDeployment, 'forceRescan=true must proceed with full scan');
      res3Forced.registrableDomain = domain;
      (res3Forced as any).rescanMode = 'same_pages';
      store.saveScanReport(visitor, res3Forced);

      const qAfterForced = store.getQuotaStatus(visitor, domain) as any;
      assert.equal(qAfterForced.reviewsUsed, 2, 'Forced re-scan must consume 1 review');
      assert.equal(qAfterForced.pagesUsed, 2, 'same_pages forced re-scan must consume 0 additional page quota');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await t.test('B3.4: Comparison block computes fingerprint diff, confirmed resolution lines, and lab metric deltas', () => {
    const fConfirmed1: Finding = {
      id: 'f1',
      ruleId: 'R001',
      category: 'links',
      title: 'Broken Contact Link',
      titleAr: 'رابط تواصل مكسور',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'http',
      source: 'rule',
      url: 'https://example.com/contact',
      location: 'https://example.com/contact',
      occurrences: 1,
      observed: '404 Not Found',
      steps: [],
      evidence: [{ type: 'url', value: 'https://example.com/contact -> 404', ref: '404' }],
      recommendedFix: 'صلح الرابط',
    };
    const fConfirmed2: Finding = {
      id: 'f2',
      ruleId: 'R008',
      category: 'seo',
      title: 'Missing Title',
      titleAr: 'عنوان الصفحة ناقص',
      kind: 'confirmed_defect',
      severity: 'medium',
      confidence: 'confirmed',
      method: 'static_html',
      source: 'rule',
      url: 'https://example.com/about',
      location: 'https://example.com/about',
      occurrences: 1,
      observed: 'Empty <title>',
      steps: [],
      evidence: [{ type: 'snippet', value: '<title></title>', ref: '<title>' }],
      recommendedFix: 'ضيف عنوان',
    };

    const prev: ScanResult = {
      schemaVersion: '2.0',
      scanId: 'scan_prev_b3',
      requestedUrl: 'https://example.com',
      registrableDomain: 'example.com',
      status: 'completed',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      finishedAt: new Date(Date.now() - 55000).toISOString(),
      limits: { maxPages: 10 },
      pages: [],
      uniquePagesInspected: 2,
      findings: [fConfirmed1, fConfirmed2],
      passes: [],
      notMeasured: [],
      lighthouse: [],
      limitations: [],
      ttfbMs: 650,
      psiData: {
        lcpMs: 4200,
        cls: 0.18,
        tbtMs: 410,
      },
    };

    // Case A: 1 confirmed resolved, 1 still open
    const currPartialFix: ScanResult = {
      ...prev,
      scanId: 'scan_curr_partial',
      findings: [fConfirmed2],
      ttfbMs: 320,
      psiData: {
        lcpMs: 2400,
        cls: 0.04,
        tbtMs: 150,
      },
    };

    const diffPartial = computeRescanDiff(prev, currPartialFix) as any;
    assert.equal(diffPartial.resolvedRuleIds.length, 1);
    assert.equal(diffPartial.stillOpenRuleIds.length, 1);
    assert.equal(diffPartial.newRuleIds.length, 0);
    assert.equal(diffPartial.resolvedConfirmedCount, 1, 'Must track resolvedConfirmedCount=1');
    assert.equal(diffPartial.allConfirmedResolved, false, 'allConfirmedResolved must be false when 1 confirmed finding remains');
    assert.ok(diffPartial.metricDeltas.some((m: any) => m.metric === 'TTFB' && m.statusAr === 'تحسّن' && m.note === 'lab'));

    // Case B: All confirmed items resolved
    const currAllFixed: ScanResult = {
      ...prev,
      scanId: 'scan_curr_all_fixed',
      findings: [],
      ttfbMs: 280,
      psiData: {
        lcpMs: 2100,
        cls: 0.02,
        tbtMs: 90,
      },
    };
    const diffAll = computeRescanDiff(prev, currAllFixed) as any;
    assert.equal(diffAll.resolvedConfirmedCount, 2);
    assert.equal(diffAll.allConfirmedResolved, true, 'allConfirmedResolved must be true when all confirmed items are resolved');

    // Verify ReportView.tsx contains the required B3.4 strings
    const reportViewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    assert.ok(
      reportViewSrc.includes('التعديلات اللي طلبتها اتنفذت:'),
      'ReportView.tsx must include "✔ التعديلات اللي طلبتها اتنفذت: N ملاحظة اتحلت"'
    );
    assert.ok(
      reportViewSrc.includes('كل المشاكل المؤكدة اتحلت في العينة دي'),
      'ReportView.tsx must include scope-limited "كل المشاكل المؤكدة اتحلت في العينة دي"'
    );
    assert.ok(
      !reportViewSrc.includes('الموقع سليم 100%') && !reportViewSrc.includes('الموقع سليم تماماً'),
      'ReportView.tsx must never claim "الموقع سليم"'
    );
  });

  await t.test('B3.5: Fix prompts per tool include context line, one task per CONFIRMED finding with evidence + location + acceptance criterion, constraints, platform objection clause, publish instruction, and no hosting-panel instructions for builder sites', () => {
    const lovableProfile: SiteProfile = {
      type: 'standard',
      confidence: 0.95,
      signals: ['Builder host suffix matched: lovable.app (Lovable)'],
      platform: 'ai_builder',
      builder: 'lovable',
      confidenceLevel: 'high',
      platformConfidence: 'high',
      hasTailwind: true,
      isCodeRepoPlatform: true,
    };

    const confirmedFinding: Finding = {
      id: 'f_conf_1',
      ruleId: 'R001',
      category: 'links',
      title: 'Broken Link in Header',
      titleAr: 'رابط مكسور في الهيدر',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      method: 'http',
      source: 'rule',
      url: 'https://xlans.lovable.app/',
      location: 'الهيدر',
      where: {
        pageUrl: 'https://xlans.lovable.app/',
        sectionAr: 'الهيدر',
        visibleText: 'تواصل معنا',
        selector: 'header nav a[href="/contact-us"]',
        snippet: '<a href="/contact-us">تواصل معنا</a>',
      },
      occurrences: 1,
      observed: 'GET /contact-us returned 404',
      expected: 'Link should return HTTP 200 OK',
      steps: ['افتح الصفحة الرئيسية واضغط على تواصل معنا وتأكد أنها تفتح بدون 404'],
      evidence: [{ type: 'snippet', value: '<a href="/contact-us">تواصل معنا</a>', ref: '404' }],
      recommendedFix: 'صلّح مسار الرابط في الهيدر ليشير إلى الصفحة الصحيحة.',
    };

    const pack = buildPlatformAwareRepairPack({
      requestedUrl: 'https://xlans.lovable.app/',
      profile: lovableProfile,
      findings: [confirmedFinding],
    });

    assert.ok(
      pack.masterPrompt.includes('الموقع مبني على Lovable'),
      'Fix prompt for Lovable must include context line "الموقع مبني على Lovable"'
    );
    assert.ok(
      pack.masterPrompt.includes('معيار القبول') || pack.masterPrompt.includes('Acceptance'),
      'Fix prompt must include an acceptance criterion per confirmed finding'
    );
    assert.ok(
      pack.masterPrompt.includes('لو ملاحظة مش مناسبة للمنصة قول ليه بدل ما تفرضها'),
      'Fix prompt must include "لو ملاحظة مش مناسبة للمنصة قول ليه بدل ما تفرضها"'
    );
    assert.ok(
      pack.masterPrompt.includes('لما تخلص: انشر التعديلات واكتب إيه اللي اتغير'),
      'Fix prompt must include "لما تخلص: انشر التعديلات واكتب إيه اللي اتغير"'
    );
    assert.doesNotMatch(
      pack.masterPrompt,
      /cPanel|\.htaccess|Cloudflare панель/i,
      'Fix prompt for builder-hosted site must not contain hosting-panel instructions'
    );

    // Also test toolOverride (when host is unknown and user picks a tool chip in ReportView)
    const unknownProfile: SiteProfile = {
      type: 'standard',
      confidence: 0.4,
      signals: [],
      platform: 'unknown',
      builder: 'unknown',
      confidenceLevel: 'low',
    };
    const overriddenPrompts = buildRepairPrompts({
      requestedUrl: 'https://custom-domain.com/',
      siteProfile: unknownProfile,
      findings: [confirmedFinding],
      toolOverride: 'Bolt',
    } as any);
    assert.ok(
      overriddenPrompts.confirmedOnlyMasterPrompt.includes('الموقع مبني على Bolt'),
      'Selecting a tool chip must update the context line to "الموقع مبني على {tool}"'
    );

    // Check ReportView has the optional chip row "اتبنى بإيه؟" and MadamAfafHero does NOT
    const reportViewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    const heroSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/MadamAfafHero.tsx'), 'utf-8');
    assert.ok(reportViewSrc.includes('اتبنى بإيه؟'), 'ReportView.tsx must include optional "اتبنى بإيه؟" chip row when host is unknown');
    assert.ok(!heroSrc.includes('اتبنى بإيه؟'), '"اتبنى بإيه؟" must NEVER appear on the landing page');
  });

  await t.test('B3.6: docs/AI_BUILDERS.md exists and documents registry fields, verification rule, and candidate tools', () => {
    const docPath = path.resolve(process.cwd(), 'docs/AI_BUILDERS.md');
    assert.ok(fs.existsSync(docPath), 'docs/AI_BUILDERS.md must exist');
    const content = fs.readFileSync(docPath, 'utf-8');
    assert.ok(content.includes('hostSuffixes'), 'docs/AI_BUILDERS.md must document hostSuffixes');
    assert.ok(content.includes('verifiedAt'), 'docs/AI_BUILDERS.md must document verifiedAt');
    assert.ok(content.includes('source'), 'docs/AI_BUILDERS.md must document official source URL requirement');
    for (const tool of ['Lovable', 'Replit', 'Base44', 'Bolt', 'v0', 'Emergent', 'AI Studio']) {
      assert.ok(content.includes(tool), `docs/AI_BUILDERS.md must mention ${tool}`);
    }
  });

  await t.test('B3.7: Changed deploymentFingerprint bypasses PSI cache and builder staging-domain replaces email mismatch with staging note', () => {
    const psiCache = new PsiCache();
    psiCache.set(
      'https://xlans.lovable.app/',
      { lcpMs: 3900, cls: 0.05, tbtMs: 210, rawCategories: {} } as any,
      'mobile',
      'fp_v1'
    );
    const hitSameFp = psiCache.getWithMeta('https://xlans.lovable.app/', 'mobile', 'fp_v1');
    assert.ok(hitSameFp, 'Same fingerprint hits PSI cache');

    const missChangedFp = psiCache.getWithMeta('https://xlans.lovable.app/', 'mobile', 'fp_v2');
    assert.equal(missChangedFp, undefined, 'Changed deploymentFingerprint must bypass PSI cache');

    const lovableHtml =
      '<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>شركة إكسلانس</title></head><body><h1>شركة إكسلانس</h1><p>خدمات رقمية</p><a href="mailto:info@xlans-company.com">info@xlans-company.com</a></body></html>';
    const profile = buildSiteProfile({
      url: 'https://xlans.lovable.app/',
      html: lovableHtml,
      headers: { 'content-type': 'text/html' },
    });
    const stagingChecks = runHonestChecks({
      url: 'https://xlans.lovable.app/',
      statusCode: 200,
      html: lovableHtml,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      siteProfile: profile,
    });
    const stagingNote = stagingChecks.findings.find((f) => f.ruleId === 'RC002');
    assert.ok(stagingNote, 'Staging domain email mismatch must emit RC002 staging note');
    assert.ok(
      (stagingNote.observed || '').includes('الموقع لسه على دومين تجريبي من المنصة (xlans.lovable.app)'),
      'Staging note must use exact builder-hosted staging domain wording'
    );
    assert.equal(stagingNote.affectsVerdict, false, 'Staging note must not affect verdict');
    assert.equal(stagingNote.needsHumanDecision, true, 'Staging note must be in decision list');
  });
});
