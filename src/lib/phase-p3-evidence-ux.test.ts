import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('PHASE P3: Evidence-Led UX and Trust Suite', () => {
  const rootDir = process.cwd();
  const demoReportsPath = path.join(rootDir, 'src/lib/demo-reports.ts');
  const heroPath = path.join(rootDir, 'src/components/MadamAfafHero.tsx');
  const reportViewPath = path.join(rootDir, 'src/components/ReportView.tsx');
  const appPath = path.join(rootDir, 'src/App.tsx');

  test('P3.1: Mock Sample Reports (src/lib/demo-reports.ts) are explicitly labeled MOCK in code and UI and never masquerade as real scans', async () => {
    assert.ok(fs.existsSync(demoReportsPath), 'src/lib/demo-reports.ts must exist');
    const demoMod = await import('./demo-reports.js');
    assert.ok(Array.isArray(demoMod.MOCK_DEMO_REPORTS), 'MOCK_DEMO_REPORTS must be an array');
    assert.ok(demoMod.MOCK_DEMO_REPORTS.length >= 2, 'Must provide at least 2 sample reports (e.g. WordPress B2B & AI-built SPA)');
    assert.equal(typeof demoMod.getMockDemoReport, 'function', 'Must export getMockDemoReport');

    for (const sample of demoMod.MOCK_DEMO_REPORTS) {
      const report = sample.report;
      assert.equal(report.isMockFallback, true, `Sample report ${sample.id} must have isMockFallback: true`);
      assert.ok(report.scanId.startsWith('mock_demo_'), `Sample scanId must start with mock_demo_, got ${report.scanId}`);
      assert.ok(report.findings.length > 0, `Sample report ${sample.id} must contain realistic findings`);
      for (const f of report.findings) {
        assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0, `Finding ${f.id} must have evidence`);
        assert.ok(f.evidence[0].id, `Finding ${f.id} evidence[0] must have an explicit id`);
        assert.ok(f.whyItMattersAr && f.whyItMattersAr.length > 10, `Finding ${f.id} must include whyItMattersAr`);
      }
      assert.ok(report.verdict, `Sample report ${sample.id} must have a deterministic verdict`);
      assert.ok(report.masterRepairPrompt && report.masterRepairPrompt.length > 20, 'Sample report must include masterRepairPrompt');
      assert.ok(report.developerMarkdownHandoff && report.developerMarkdownHandoff.length > 20, 'Sample report must include developerMarkdownHandoff');
    }

    const heroSrc = fs.readFileSync(heroPath, 'utf-8');
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    assert.ok(
      heroSrc.includes('data-testid="open-sample-report-btn"'),
      'MadamAfafHero.tsx must render 1-click sample report preview button (data-testid="open-sample-report-btn")'
    );
    assert.ok(
      heroSrc.includes('MOCK'),
      'MadamAfafHero.tsx sample report trigger must explicitly display MOCK label'
    );
    assert.ok(
      reportSrc.includes('data-testid="mock-demo-banner"'),
      'ReportView.tsx must render prominent mock-demo-banner when result.isMockFallback is true'
    );
  });

  test('P3.2: ReportView includes Evidence-First Findings Filter Bar (All / Confirmed / Needs Verification), Expand-All Toggle, and Evidence ID citations', () => {
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');

    assert.ok(
      reportSrc.includes('data-testid="findings-filter-bar"'),
      'ReportView.tsx must render findings-filter-bar inside #sec-findings'
    );
    assert.ok(
      reportSrc.includes('data-testid="expand-all-findings-btn"'),
      'ReportView.tsx must render expand-all-findings-btn for progressive disclosure control'
    );
    assert.ok(
      reportSrc.includes('ev.id'),
      'ReportView.tsx EvidenceBlock must render individual evidence IDs (ev.id) to connect with cause-to-fix recommendations'
    );
  });

  test('P3.3: Share & Revoke UX in ReportView.tsx and revoked share error handling in App.tsx', () => {
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    const appSrc = fs.readFileSync(appPath, 'utf-8');

    assert.ok(
      reportSrc.includes('data-testid="revoke-share-btn"'),
      'ReportView.tsx must provide a revoke-share-btn calling DELETE /api/scans/:id/share'
    );
    assert.ok(
      reportSrc.includes("method: 'DELETE'") && reportSrc.includes('/share'),
      'ReportView.tsx must call DELETE on /api/scans/:id/share when revoking'
    );
    assert.ok(
      appSrc.includes("data?.code === 'revoked'") &&
        appSrc.includes('تم إلغاء رابط المشاركة ده من صاحب التقرير'),
      'App.tsx must handle HTTP 410 code="revoked" with a clear Egyptian-Arabic message'
    );
  });

  test('P3.4: Domain Lock & Quota StatusBanner is rendered when visitor has an active domain lock', () => {
    const heroSrc = fs.readFileSync(heroPath, 'utf-8');
    assert.ok(
      heroSrc.includes('data-testid="domain-lock-status-banner"'),
      'MadamAfafHero.tsx must render data-testid="domain-lock-status-banner" when domainLock.domain is active'
    );
  });
});
