import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApiApp } from '../../server';
import { PersistentStore } from './storage';
import { ScanResult } from '../types/contract';
import { formatNumber } from './format';

describe('PHASE J4: Rescan Diff, Health Endpoint & Production Retention Suite', () => {
  const goldSetPath = path.resolve(process.cwd(), 'eval/GOLD_SET.md');
  const reportViewPath = path.resolve(process.cwd(), 'src/components/ReportView.tsx');

  it('J4.1: GET /api/health returns 200 with ok: true, status: "healthy", uptime, version and no secret leaks', async () => {
    const app = createApiApp();
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200, 'GET /api/health must return 200');
      const data = await res.json() as any;
      assert.equal(data.ok, true);
      assert.equal(data.status, 'healthy');
      assert.equal(typeof data.uptimeSeconds, 'number');
      assert.equal(typeof data.version, 'string');
      assert.equal(typeof data.scanMode, 'string');

      const rawJson = JSON.stringify(data);
      assert.equal(rawJson.includes('KEY'), false, 'Health check must never leak environment secrets');
      assert.equal(rawJson.includes('SECRET'), false);
    } finally {
      server.close();
    }
  });

  it('J4.2: Rescan Comparison computes resolved, still open, and new findings when a visitor rescans a domain', () => {
    const tmpStoreFile = `/tmp/afaf_test_rescan_${Date.now()}.json`;
    try {
      const store = new PersistentStore(tmpStoreFile);
      const visitor = { visitorId: 'v_rescan_user' };
      const domain = 'elabyad-eg.com';

      const scan1Result: ScanResult = {
        schemaVersion: '2.0',
        rulesetVersion: '2.1.0',
        scanId: 'scan_rescan_1',
        requestedUrl: `https://${domain}/`,
        registrableDomain: domain,
        status: 'completed',
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        finishedAt: new Date(Date.now() - 3500000).toISOString(),
        limits: { maxPages: 10 },
        pages: [{ url: `https://${domain}/`, viewportsChecked: ['desktop'] }],
        uniquePagesInspected: 1,
        findings: [
          {
            id: 'f_hsts_missing',
            ruleId: 'SEC001',
            category: 'security',
            title: 'Missing HSTS header',
            titleAr: 'غياب ترويسة HSTS',
            kind: 'confirmed_defect',
            severity: 'medium',
            confidence: 'confirmed',
            url: `https://${domain}/`,
            occurrences: 1,
            observed: 'No Strict-Transport-Security header',
            steps: [],
            evidence: [],
            recommendedFix: 'Add HSTS',
            source: 'rule'
          },
          {
            id: 'f_alt_missing_1',
            ruleId: 'SEO005',
            category: 'seo',
            title: 'Missing alt attribute',
            titleAr: 'صورة من غير وصف بديل',
            kind: 'confirmed_defect',
            severity: 'low',
            confidence: 'confirmed',
            url: `https://${domain}/`,
            occurrences: 1,
            observed: 'img without alt',
            steps: [],
            evidence: [],
            recommendedFix: 'Add alt',
            source: 'rule'
          }
        ],
        passes: [],
        notMeasured: [],
        lighthouse: [],
        limitations: []
      };

      store.saveScanReport(visitor, scan1Result);

      // Scan 2: HSTS is fixed (resolved!), Alt missing is still open, and Video without poster is newly found
      const scan2Result: ScanResult = {
        ...scan1Result,
        scanId: 'scan_rescan_2',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        findings: [
          scan1Result.findings[1], // Alt missing still present
          {
            id: 'f_video_no_poster',
            ruleId: 'R013',
            category: 'performance',
            title: 'Video lacking poster',
            titleAr: 'فيديو من غير صورة غلاف (poster)',
            kind: 'recommendation',
            severity: 'low',
            confidence: 'likely',
            url: `https://${domain}/`,
            occurrences: 1,
            observed: 'video tag without poster attribute',
            steps: [],
            evidence: [],
            recommendedFix: 'Add poster',
            source: 'rule'
          }
        ]
      };

      const savedReport2 = store.saveScanReport(visitor, scan2Result);
      assert.ok(savedReport2.rescanComparison, 'Second scan on same domain must compute rescanComparison');
      assert.equal(savedReport2.rescanComparison.previousScanId, 'scan_rescan_1');
      assert.equal(savedReport2.rescanComparison.resolvedRuleIds.length, 1);
      assert.equal(savedReport2.rescanComparison.resolvedRuleIds[0].ruleId, 'SEC001');
      assert.equal(savedReport2.rescanComparison.stillOpenRuleIds.length, 1);
      assert.equal(savedReport2.rescanComparison.stillOpenRuleIds[0].ruleId, 'SEO005');
      assert.equal(savedReport2.rescanComparison.newRuleIds.length, 1);
      assert.equal(savedReport2.rescanComparison.newRuleIds[0].ruleId, 'R013');
    } finally {
      if (fs.existsSync(tmpStoreFile)) fs.unlinkSync(tmpStoreFile);
    }
  });

  it('J4.3: ReportView.tsx formats rescan counts using formatNumber with Latin digits', () => {
    const reportSrc = fs.readFileSync(reportViewPath, 'utf-8');
    assert.ok(reportSrc.includes('id="sec-rescan"'), 'ReportView must include #sec-rescan section');
    assert.ok(
      reportSrc.includes('formatNumber(result.rescanComparison.resolvedRuleIds.length)'),
      'ReportView must format resolved count using formatNumber'
    );
    assert.ok(
      reportSrc.includes('formatNumber(result.rescanComparison.stillOpenRuleIds.length)'),
      'ReportView must format still-open count using formatNumber'
    );
    assert.ok(
      reportSrc.includes('formatNumber(result.rescanComparison.newRuleIds.length)'),
      'ReportView must format new count using formatNumber'
    );
  });

  it('J4.4: 30-Day retention cleanup automatically purges expired reports and jobs', () => {
    const tmpStoreFile = `/tmp/afaf_test_retention_${Date.now()}.json`;
    try {
      const store = new PersistentStore(tmpStoreFile);
      const visitor = { visitorId: 'v_retention_user' };
      const domain = 'old-site.com';

      const oldReport: ScanResult = {
        schemaVersion: '2.0',
        rulesetVersion: '2.1.0',
        scanId: 'scan_old_expired',
        requestedUrl: `https://${domain}/`,
        registrableDomain: domain,
        status: 'completed',
        startedAt: new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString(),
        finishedAt: new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString(),
        limits: { maxPages: 10 },
        pages: [],
        uniquePagesInspected: 0,
        findings: [],
        passes: [],
        notMeasured: [],
        lighthouse: [],
        limitations: []
      };

      // Save report with custom expiry in the past
      store.saveScanReport(visitor, oldReport, {
        customExpiresAtMs: Date.now() - 1000
      });

      // Querying scan status should trigger cleanup and return 410 gone or 404
      const lookup = store.getScanStatusForVisitor('scan_old_expired', visitor.visitorId);
      assert.ok(lookup.httpStatus === 410 || lookup.httpStatus === 404, 'Expired scan must be cleaned up');
    } finally {
      if (fs.existsSync(tmpStoreFile)) fs.unlinkSync(tmpStoreFile);
    }
  });

  it('J4.5: eval/GOLD_SET.md rejects precision percentages without n>=10 samples', () => {
    assert.ok(fs.existsSync(goldSetPath), 'eval/GOLD_SET.md must exist');
    const content = fs.readFileSync(goldSetPath, 'utf-8');
    assert.ok(content.includes('elabyad-eg.com'), 'GOLD_SET.md must include elabyad-eg.com');
    assert.ok(content.includes('R013'), 'GOLD_SET.md must include R013');
    assert.ok(content.includes('RC005'), 'GOLD_SET.md must include RC005');

    // Rule: no precision percentage (e.g. 100%, 95%) is allowed in the table unless n >= 10 is established
    const precisionMatches = content.match(/\|\s*\d+%\s*\|/g);
    assert.strictEqual(
      precisionMatches,
      null,
      'eval/GOLD_SET.md must NOT contain pre-filled precision percentages without human labeling (n >= 10)'
    );
  });
});
