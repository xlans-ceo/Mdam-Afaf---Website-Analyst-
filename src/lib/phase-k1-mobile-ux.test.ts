import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  isolateLtr,
  isolateNumber,
  formatScoreRatio,
  formatBidiDate,
  formatLcpTitleAr
} from './bidi';
import {
  formatArabicNoteCount,
  computeVerdict
} from './honest-checks';
import { hasRealVisibleText } from './format';
import { LiveProvider } from './providers/index';
import { safeFetchHtmlWithSsrf } from './ssrf-validator';
import { Finding, NotMeasuredItem } from '../types/contract';

test('PHASE K1: Mobile UX & Bidi Invariants Suite', async (t) => {
  await t.test('K1.1 & K1.2 & K1.9: Floating elements, 48px sticky bar, no CTA overlap, and landing cleanup', () => {
    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
    const heroSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/MadamAfafHero.tsx'), 'utf-8');
    const widgetSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/MadamAfafFloatingWidget.tsx'), 'utf-8');
    const reportSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    const headerSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/Header.tsx'), 'utf-8');
    const cssSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf-8');

    // K1.1: Only ONE floating widget in App.tsx (MadamAfafFloatingWidget); WhatsApp removed, LinkedIn added
    assert.ok(appSrc.includes('<MadamAfafFloatingWidget'), 'Chat widget must remain in App.tsx');
    assert.ok(!appSrc.includes('<WhatsAppSupport'), 'Floating WhatsAppSupport must be removed from App.tsx');
    assert.ok(!appSrc.includes('footer-whatsapp-link'), 'WhatsApp link must be removed from footer in App.tsx');
    assert.ok(appSrc.includes('data-testid="footer-linkedin-link"'), 'LinkedIn link must be in the footer');
    assert.ok(!reportSrc.includes('menu-whatsapp-link'), 'WhatsApp link must be removed from ReportView menu');
    assert.ok(reportSrc.includes('data-testid="menu-linkedin-link"'), 'LinkedIn link must be in the المزيد menu');
    assert.ok(appSrc.includes('https://www.linkedin.com/in/mo7amadsultan/'), 'Footer must point to LinkedIn');
    assert.ok(reportSrc.includes('https://www.linkedin.com/in/mo7amadsultan/'), 'Report menu must point to LinkedIn');

    // K1.1: Bottom padding on <main> so no fixed element covers the landing primary CTA
    assert.ok(appSrc.includes('pb-24'), 'Main container must have bottom padding on mobile so fixed chat button never overlaps primary CTA');

    // K1.1: Floating master prompt button is icon-only and appears only after toolbar scrolls out of view
    assert.ok(reportSrc.includes('window.scrollY > 200'), 'Master prompt floating button must track scroll > 200px');
    assert.ok(reportSrc.includes('toolbarScrolledOut && ('), 'Master prompt floating button must only render when toolbarScrolledOut is true');

    // K1.1: Chat teaser bubble shows once per session, auto-hides after 6 seconds, and never on the landing form
    assert.ok(widgetSrc.includes('if (!scanResult)'), 'Chat teaser bubble must never show on the landing form (!scanResult)');
    assert.ok(widgetSrc.includes('sessionStorage.getItem'), 'Chat teaser bubble must check sessionStorage to show once per session');
    assert.ok(widgetSrc.includes('6000'), 'Chat teaser bubble must auto-hide after 6 seconds (6000ms)');

    // K1.2: Sticky top bar is a single 48px line (h-12) and --sticky-offset is 3rem (48px)
    assert.ok(cssSrc.includes('--sticky-offset: 3rem;'), 'CSS must set --sticky-offset to 3rem (48px)');
    assert.ok(headerSrc.includes('h-12'), 'Header must use h-12 (48px)');
    assert.ok(reportSrc.includes('sticky top-0 z-20 h-12'), 'Report sticky bar must be a single 48px (h-12) sticky line');

    // K1.9: Duplicated example.com helper label removed from above the input in MadamAfafHero.tsx
    const labelToInputSlice = heroSrc.slice(
      heroSrc.indexOf('htmlFor="target-url"'),
      heroSrc.indexOf('id="target-url"')
    );
    assert.ok(!labelToInputSlice.includes('example.com'), 'MadamAfafHero must not have a duplicated example.com label above the input');
  });

  await t.test('K1.3: Bidi isolates, order preservation, and Arabic date rendering', () => {
    const ltrWrapped = isolateLtr('example.com/path');
    assert.match(ltrWrapped, /\u2066example\.com\/path\u2069/);

    const numWrapped = isolateNumber(4.2);
    assert.match(numWrapped, /\u20664\.2\u2069/);

    const score = formatScoreRatio(80, 100);
    assert.equal(score, '\u206680/100\u2069');

    const sampleDate = new Date('2026-10-24T10:57:00');
    const formattedDate = formatBidiDate(sampleDate);
    assert.match(formattedDate, /24/);
    assert.match(formattedDate, /أكتوبر/);
    assert.match(formattedDate, /2026/);
    assert.match(formattedDate, /10:57/);
    assert.match(formattedDate, /ص/);
    assert.doesNotMatch(formattedDate, /undefined/);

    const lcpTitle = formatLcpTitleAr('4.2');
    assert.equal(lcpTitle, 'بطء ظهور المحتوى الرئيسي على الموبايل: 4.2 ثانية (LCP)');
    assert.doesNotMatch(lcpTitle, /\(LCP = 4\.2\)/);
  });

  await t.test('K1.4: "ما اتقاسش" counter and honest naming consistency', () => {
    const reportSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    assert.ok(
      reportSrc.includes('ما اتقاسش (<bdi dir="ltr">{formatNumber(notMeasured.length)}</bdi>)'),
      'Section 9 heading must be renamed to "ما اتقاسش (N)" matching TOC and summary tile'
    );

    const dummyNotMeasured: NotMeasuredItem[] = [
      {
        id: 'nm_1',
        checkId: 'CHK_1',
        category: 'responsive',
        titleAr: 'تجاوب الشاشات الدقيق والتمرير الأفقي',
        reasonAr: 'يحتاج متصفح حي',
        missingCapability: 'browserRendering'
      },
      {
        id: 'nm_2',
        checkId: 'CHK_2',
        category: 'accessibility',
        titleAr: 'اختبار النقر على أزرار التفاعل',
        reasonAr: 'يحتاج تشغيل جافاسكريبت',
        missingCapability: 'browserRendering'
      }
    ];

    const verdict = computeVerdict({
      findings: [],
      passes: [],
      notMeasured: dummyNotMeasured
    });

    assert.equal(verdict.counts.notMeasured, 2);
  });

  await t.test('K1.5: Numeric-plus-dual grammar ("ملاحظتين" without the digit 2)', () => {
    assert.equal(formatArabicNoteCount(0), 'صفر ملاحظات');
    assert.equal(formatArabicNoteCount(1), 'ملاحظة واحدة');
    assert.equal(formatArabicNoteCount(2), 'ملاحظتين');
    assert.doesNotMatch(formatArabicNoteCount(2), /2\s*ملاحظتين/);
    assert.equal(formatArabicNoteCount(3), '3 ملاحظات');
    assert.equal(formatArabicNoteCount(10), '10 ملاحظات');
    assert.equal(formatArabicNoteCount(11), '11 ملاحظة');
  });

  await t.test('K1.5: Verdict drivers: one primary reason per measurement and no duplicated (قياس معملي)', () => {
    const lcpFinding: Finding = {
      id: 'f_lcp',
      ruleId: 'R013',
      category: 'performance',
      title: 'Slow LCP',
      titleAr: 'بطء ظهور المحتوى الرئيسي على الموبايل: 4.2 ثانية (LCP) — قياس معملي من جوجل (محاكاة موبايل بطيء)',
      kind: 'confirmed_defect',
      severity: 'high',
      confidence: 'confirmed',
      affectsVerdict: true,
      method: 'psi',
      source: 'lighthouse',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'LCP is 4.2s',
      steps: [],
      evidence: [{ type: 'measurement', ref: 'lcp', value: '4.2s' }],
      recommendedFix: 'Optimize images'
    };

    const overallScoreFinding: Finding = {
      id: 'f_r013_psi_score',
      ruleId: 'R013_SCORE',
      category: 'performance',
      title: 'Overall Performance Score Low',
      titleAr: 'مؤشر أداء الموقع العام منخفض: 35/100',
      kind: 'recommendation',
      severity: 'medium',
      confidence: 'confirmed',
      affectsVerdict: false,
      method: 'psi',
      source: 'lighthouse',
      url: 'https://example.com',
      occurrences: 1,
      observed: 'Score is 35/100',
      steps: [],
      evidence: [{ type: 'measurement', ref: 'score', value: '35/100' }],
      recommendedFix: 'General optimization'
    };

    const verdict = computeVerdict({
      findings: [lcpFinding, overallScoreFinding],
      passes: [],
      notMeasured: []
    });

    assert.equal(verdict.level, 'fix_before_handover');
    const drivers = verdict.drivers || [];
    assert.ok(drivers.length > 0);
    const hasScoreDriver = drivers.some(d => d.findingId === 'f_r013_psi_score' || d.ruleId === 'R013_SCORE');
    assert.equal(hasScoreDriver, false, 'Overall performance score must be informational and not a driver');

    const driverSummary = drivers[0].summaryAr;
    const occurrences = (driverSummary.match(/قياس معملي/g) || []).length;
    assert.ok(occurrences <= 1, `(قياس معملي) must not be duplicated, found ${occurrences} in: "${driverSummary}"`);
  });

  await t.test('K1.6 & K1.7: PSI findings show "العنصر:" and hide "افتح الصفحة عند النص"; URLs truncate with copy button', () => {
    assert.equal(hasRealVisibleText(undefined), false);
    assert.equal(hasRealVisibleText('أعلى الصفحة (لا يوجد نص مرئي محدد)'), false);
    assert.equal(hasRealVisibleText('المحتوى الرئيسي للصفحة'), false);
    assert.equal(hasRealVisibleText('تواصل معنا الآن'), true);

    const reportSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    assert.ok(reportSrc.includes("f.method === 'psi' || f.source === 'lighthouse' ? ("), 'ReportView must branch for PSI findings to show العنصر');
    assert.ok(reportSrc.includes('العنصر:'), 'ReportView must display "العنصر:" for PSI findings');
    assert.ok(
      reportSrc.includes("f.method !== 'psi' && f.source !== 'lighthouse' && textFragmentUrl && hasRealVisibleText(f.where?.visibleText)"),
      'ReportView must hide "افتح الصفحة عند النص" when f.method === psi or visibleText is not real'
    );
    assert.ok(reportSrc.includes('formatDomainPathDisplay'), 'ReportView must format URLs as domain/path with ellipsis and copy button');
  });

  await t.test('K1.8: Slow homepage 1 retry with 20s timeout on root request only + timeout stage reporting', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/fixtures/timeout-first-byte') {
        requestCount++;
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>Late</body></html>');
          }
        }, 400);
        return;
      }
      if (req.url === '/fixtures/retry-root') {
        requestCount++;
        if (requestCount === 1) {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><head><title>Slow Site</title></head><body><h1>أهلا بكم</h1></body></html>');
            }
          }, 250);
        } else {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<html><head><title>Slow Site</title></head><body><h1>أهلا بكم في موقعنا</h1></body></html>');
            }
          }, 120);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Test A: Timeout stage reporting ('first_byte')
      const timeoutRes = await safeFetchHtmlWithSsrf(`${baseUrl}/fixtures/timeout-first-byte`, {
        timeoutMs: 80,
        allowLocalFixtures: true
      });
      assert.equal(timeoutRes.ok, false);
      assert.equal(timeoutRes.timedOut, true);
      assert.equal(timeoutRes.timedOutStage, 'first_byte');
      assert.match(timeoutRes.errorReasonAr || '', /first byte/);

      // Test B: Root request retry succeeds when first attempt times out at 80ms and retry uses 500ms
      requestCount = 0;
      const provider = new LiveProvider();
      const scanRes = await provider.runScan(
        'test_k1_8_retry',
        { url: `${baseUrl}/fixtures/retry-root`, locale: 'ar-EG' },
        () => {},
        {
          rootRequestTimeoutMs: 80,
          rootRetryTimeoutMs: 500
        }
      );
      assert.equal(scanRes.siteStatus?.state ?? 'ok', 'ok', 'Root request should succeed on retry');
      assert.ok(requestCount >= 2, 'Root request must have been retried after first timeout');

      // Test C: Status report hides "0/10 (عينة)" in ReportView.tsx
      const reportSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
      assert.ok(
        reportSrc.includes('!isStatusReportOnly && (') && reportSrc.includes('الصفحات المفحوصة:'),
        'Status reports must hide the "الصفحات المفحوصة: 0/10 (عينة)" note'
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
