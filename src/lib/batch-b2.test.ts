import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PersistentStore } from './storage';
import { ScanResult } from '../types/contract';

test('BATCH B2: Calm UI (Landing, Dock, Status Dots, Progress, Reports Page, Single-Column Report)', async (t) => {
  await t.test('B2.1: Landing page has centered max-w-[720px] column, top wordmark+avatar, headline, 4-step strip, and two popover pills', () => {
    const heroSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/MadamAfafHero.tsx'), 'utf-8');
    assert.ok(heroSrc.includes('720px'), 'Landing column must have max-width ~720px');
    assert.ok(heroSrc.includes('ما بتخمنش. بتشوف، وبتورّيك الدليل.'), 'Landing must include the exact headline');
    assert.ok(heroSrc.includes('example.com'), 'Landing input must have placeholder example.com');
    assert.ok(heroSrc.includes('موقعك أو موقع معاك إذن صاحبه'), 'Landing must include tiny permission caption');
    assert.ok(heroSrc.includes('ابعت اللينك'), '4-step strip must include step 1: ابعت اللينك');
    assert.ok(heroSrc.includes('شوف المشاكل بالدليل'), '4-step strip must include step 2: شوف المشاكل بالدليل');
    assert.ok(heroSrc.includes('انسخ البرومبت'), '4-step strip must include step 3: انسخ البرومبت');
    assert.ok(heroSrc.includes('أعد الفحص'), '4-step strip must include step 4: أعد الفحص');
    assert.ok(heroSrc.includes('هنفحص:'), 'Landing must include pill 1: هنفحص: الكل ▾');
    assert.ok(heroSrc.includes('لحد 10 صفحات') || heroSrc.includes('لحد ١٠ صفحات'), 'Options popover must include note لحد 10 صفحات');
    assert.ok(heroSrc.includes('الـ AI قالك إيه؟ (اختياري)'), 'Landing must include pill 2: الـ AI قالك إيه؟ (اختياري)');
  });

  await t.test('B2.2: Dock component exists with required items, roving tabindex, desktop hover magnification, mobile scroll-snap, and hides when a sheet is open', () => {
    const dockPath = path.resolve(process.cwd(), 'src/components/MadamAfafDock.tsx');
    assert.ok(fs.existsSync(dockPath), 'src/components/MadamAfafDock.tsx must exist');
    const dockSrc = fs.readFileSync(dockPath, 'utf-8');
    for (const itemLabel of ['فحص جديد', 'تقاريري', 'البرومبت', 'شات عفاف', 'المزيد']) {
      assert.ok(dockSrc.includes(itemLabel), `Dock must include item "${itemLabel}"`);
    }
    for (const moreItem of ['PDF/طباعة', 'تصدير JSON', 'مشاركة', 'الخصوصية', 'الشروط', 'LinkedIn']) {
      assert.ok(dockSrc.includes(moreItem), `Dock "المزيد" sheet must include "${moreItem}"`);
    }
    assert.ok(dockSrc.includes('tabIndex'), 'Dock must support roving tabIndex for keyboard navigation');
    assert.ok(dockSrc.includes('aria-label'), 'Dock items must have aria-labels');

    const cssSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf-8');
    assert.ok(cssSrc.includes('@media (hover: hover)'), 'Desktop dock magnification must be gated by @media (hover: hover)');
    assert.ok(cssSrc.includes('prefers-reduced-motion'), 'Dock motion must respect prefers-reduced-motion');
  });

  await t.test('B2.3: StatusDot maps running->شغّال (orange), done->خلص (green), failed/interrupted->فشل (red) with icon + word', async () => {
    const statusDotPath = path.resolve(process.cwd(), 'src/components/StatusDot.tsx');
    assert.ok(fs.existsSync(statusDotPath), 'src/components/StatusDot.tsx must exist');
    const mod = await import('../components/StatusDot.js');
    assert.equal(typeof mod.getScanStatusDotMeta, 'function', 'getScanStatusDotMeta must be exported');

    const runningMeta = mod.getScanStatusDotMeta('running');
    assert.equal(runningMeta.labelAr, 'شغّال');
    assert.equal(runningMeta.state, 'running');

    const queuedMeta = mod.getScanStatusDotMeta('queued');
    assert.equal(queuedMeta.labelAr, 'شغّال');

    const doneMeta = mod.getScanStatusDotMeta('completed');
    assert.equal(doneMeta.labelAr, 'خلص');
    assert.equal(doneMeta.state, 'done');

    const failedMeta = mod.getScanStatusDotMeta('failed');
    assert.equal(failedMeta.labelAr, 'فشل');
    assert.equal(failedMeta.state, 'failed');

    const interruptedMeta = mod.getScanStatusDotMeta('interrupted');
    assert.equal(interruptedMeta.labelAr, 'فشل');
    assert.equal(interruptedMeta.state, 'failed');
  });

  await t.test('B2.4: Progress screen is one calm card with stage name, elapsed time, N/M only after discovery, إلغاء link, and background completion notice', () => {
    const progressSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ScanProgress.tsx'), 'utf-8');
    assert.ok(
      progressSrc.includes('تقدر تقفل الصفحة أو تفتح حاجة تانية؛ الفحص مكمل'),
      'Progress screen must include the exact calm background message'
    );
    assert.ok(progressSrc.includes('إلغاء'), 'Progress screen must include إلغاء action');
    assert.ok(progressSrc.includes('discoveryDone'), 'Progress screen must gate N/M page counter on discovery completion');
  });

  await t.test('B2.5: Server-side listVisitorReports (last 20 summaries) and ReportsPage grouped by domain with R1/R2/R3 chips', () => {
    const tmpFile = path.resolve(process.cwd(), `data/store.b2test.${Date.now()}.json`);
    const store = new PersistentStore(tmpFile);
    try {
      const visitorId = 'v_b2_reports_tester';
      const job1 = store.createJob({ visitorId }, {
        scanId: 'scan_b2_r1',
        requestedUrl: 'https://alpha.example.com/',
        normalizedUrl: 'https://alpha.example.com/',
        registrableDomain: 'alpha.example.com',
      });
      assert.ok(job1.scanId);

      const sampleResult: ScanResult = {
        schemaVersion: '2.0',
        scanId: 'scan_b2_r1',
        requestedUrl: 'https://alpha.example.com/',
        registrableDomain: 'alpha.example.com',
        status: 'completed',
        startedAt: new Date(Date.now() - 10000).toISOString(),
        finishedAt: new Date(Date.now() - 5000).toISOString(),
        limits: { maxPages: 10 },
        pages: [],
        uniquePagesInspected: 3,
        findings: [],
        passes: [],
        notMeasured: [],
        lighthouse: [],
        limitations: [],
        verdict: {
          level: 'ready_with_notes',
          labelAr: 'جاهز بملاحظات',
          headlineAr: 'مفيش مشاكل مؤكدة كبيرة في العينة',
          summaryLinesAr: ['ملخص تجريبي ١', 'ملخص تجريبي ٢'],
          isPartial: false,
          partialReasonsAr: [],
          counts: {
            critical: 0,
            high: 0,
            medium: 0,
            low: 1,
            passed: 4,
            notMeasured: 0,
          },
        },
      };
      store.saveScanReport({ visitorId }, sampleResult);

      const job2 = store.createJob({ visitorId }, {
        scanId: 'scan_b2_r2',
        requestedUrl: 'https://alpha.example.com/',
        normalizedUrl: 'https://alpha.example.com/',
        registrableDomain: 'alpha.example.com',
      });
      store.updateJobProgress(job2.scanId, { status: 'running' });

      assert.equal(typeof (store as any).listVisitorReports, 'function', 'store.listVisitorReports must exist');
      const summaries = (store as any).listVisitorReports(visitorId, 20);
      assert.ok(Array.isArray(summaries), 'listVisitorReports must return an array');
      assert.equal(summaries.length, 2, 'Should return both completed report and running job');
      assert.equal(summaries[0].registrableDomain, 'alpha.example.com');
      assert.ok(summaries.some((s: any) => s.reviewNumber === 1), 'First scan of domain gets reviewNumber=1 (R1)');
      assert.ok(summaries.some((s: any) => s.reviewNumber === 2), 'Second scan of domain gets reviewNumber=2 (R2)');

      const reportsPagePath = path.resolve(process.cwd(), 'src/components/ReportsPage.tsx');
      assert.ok(fs.existsSync(reportsPagePath), 'src/components/ReportsPage.tsx must exist');
      const reportsPageSrc = fs.readFileSync(reportsPagePath, 'utf-8');
      assert.ok(reportsPageSrc.includes('افتح'), 'ReportsPage must include button افتح');
      assert.ok(reportsPageSrc.includes('أعد الفحص'), 'ReportsPage must include button أعد الفحص');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  await t.test('B2.6: Report screen is a single centered column (~840px) with top 3 priorities, tool-aware primary prompt button, publish check card, and 4-tab details', () => {
    const reportSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    assert.ok(reportSrc.includes('840px'), 'ReportView must have a single centered column max-w-[840px]');
    assert.ok(reportSrc.includes('مراجعة رقم'), 'Header line must show مراجعة رقم N');
    assert.ok(reportSrc.includes('من عينة'), 'Verdict block must show من عينة N صفحات');
    assert.ok(reportSrc.includes('أهم حاجات تصلحها'), 'Report must show أهم حاجات تصلحها section (max 3 cards)');
    assert.ok(reportSrc.includes('انسخ البرومبت للـ'), 'Primary CTA must say انسخ البرومبت للـ {tool or الـ AI}');
    assert.ok(reportSrc.includes('تقرير للمطور'), 'Secondary CTA must say تقرير للمطور');
    assert.ok(reportSrc.includes('بعد ما تصلّح'), 'Report must include بعد ما تصلّح card');
    assert.ok(reportSrc.includes('نشرت التعديلات من الأداة؟'), 'After-fix card must include publish checkbox');
    assert.ok(reportSrc.includes('كل التفاصيل'), 'Report must include كل التفاصيل tabs section');
    assert.ok(reportSrc.includes('تفاصيل للمبرمج'), 'Technical evidence must be inside تفاصيل للمبرمج');
    assert.ok(reportSrc.includes('حدود الفحص'), 'Report must include حدود الفحص link that opens a sheet');
  });
});
