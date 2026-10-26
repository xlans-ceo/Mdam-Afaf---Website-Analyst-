import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApiApp } from '../../server';
import { PersistentStore } from './storage';
import { ScanResult } from '../types/contract';

describe('PHASE K0: Debt Claimed But Not Delivered Suite (K0.1 - K0.7)', () => {
  const tmpDir = '/tmp';

  it('K0.1: storage atomic write, compact JSON, corrupt file rename to store.corrupt.<ts>.json, and persistence health status', async () => {
    const corruptFile = path.join(tmpDir, `test_corrupt_${Date.now()}.json`);
    fs.writeFileSync(corruptFile, 'INVALID_JSON_CONTENT{{{', 'utf-8');

    // 1. Corrupt file is renamed to store.corrupt.<ts>.json instead of silently wiping it
    const store = new PersistentStore(corruptFile);
    assert.equal(fs.existsSync(corruptFile), false, 'Original corrupted file must be renamed away');

    const corruptBackups = fs.readdirSync(tmpDir).filter(f => f.startsWith('test_corrupt_') && f.includes('store.corrupt.'));
    assert.ok(corruptBackups.length > 0, 'Corrupted file must be preserved as store.corrupt.<ts>.json');
    for (const b of corruptBackups) {
      fs.unlinkSync(path.join(tmpDir, b));
    }

    // 2. Compact JSON & Atomic write: store file content has no newline indentations
    const testFile = path.join(tmpDir, `test_atomic_${Date.now()}.json`);
    try {
      const atomicStore = new PersistentStore(testFile);
      atomicStore.reserveScan({ visitorId: 'v_atomic_1' }, { scanId: 's1', requestedUrl: 'https://example.com' });
      atomicStore.flushToDisk();

      assert.ok(fs.existsSync(testFile), 'Store file must be written to disk');
      const content = fs.readFileSync(testFile, 'utf-8');
      assert.equal(content.includes('\n  "quotas"'), false, 'Saved JSON must be compact (no indentation)');
      assert.ok(content.startsWith('{"quotas":'), 'Saved JSON must be valid compact JSON');

      // 3. /api/health exposes persistence status
      const app = createApiApp({ store: atomicStore });
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        const data = await res.json() as any;
        assert.ok(data.persistence, '/api/health must expose persistence object');
        assert.equal(typeof data.persistence.durable, 'boolean');
        assert.equal(typeof data.persistence.lastWriteOk, 'boolean');
        assert.equal(data.persistence.lastWriteOk, true);
      } finally {
        server.closeAllConnections?.();
      server.close();
      }
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  });

  it('K0.2: Security headers present on every response (nosniff, Referrer-Policy, Permissions-Policy, HSTS on https, CSP Report-Only)', async () => {
    const app = createApiApp();
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // Plain HTTP request
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(res.headers.get('permissions-policy'), 'microphone=(self)');
      assert.ok(res.headers.get('content-security-policy-report-only')?.includes("default-src 'self'"));
      // By default no X-Frame-Options or frame-ancestors to allow AI Studio iframe
      assert.equal(res.headers.get('x-frame-options'), null);

      // HTTPS / Forwarded proto request gets HSTS
      const httpsRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { 'X-Forwarded-Proto': 'https' }
      });
      assert.ok(httpsRes.headers.get('strict-transport-security')?.includes('max-age='));
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it('K0.3: Server-grounded chat ignores client context, refuses foreign scanId, uses madam-persona.ts, and validates against report', async () => {
    const tmpStoreFile = path.join(tmpDir, `test_chat_ground_${Date.now()}.json`);
    try {
      const store = new PersistentStore(tmpStoreFile);
      const ownerVisitor = 'v_chat_owner';
      const foreignVisitor = 'v_chat_foreign';
      const scanId = 'scan_chat_ground_1';

      const scanResult: ScanResult = {
        schemaVersion: '2.0',
        rulesetVersion: '2.1.0',
        scanId,
        requestedUrl: 'https://authentic-site.com/',
        registrableDomain: 'authentic-site.com',
        status: 'completed',
        startedAt: new Date().toISOString(),
        limits: { maxPages: 10 },
        pages: [{ url: 'https://authentic-site.com/', viewportsChecked: ['desktop'] }],
        uniquePagesInspected: 1,
        findings: [
          {
            id: 'f_real_hsts',
            ruleId: 'SEC001',
            category: 'security',
            title: 'Missing HSTS',
            titleAr: 'ترويسة HSTS غير مفعلة',
            kind: 'confirmed_defect',
            severity: 'medium',
            confidence: 'confirmed',
            url: 'https://authentic-site.com/',
            occurrences: 1,
            observed: 'Strict-Transport-Security header missing',
            steps: [],
            evidence: [],
            recommendedFix: 'Add HSTS',
            source: 'rule'
          }
        ],
        passes: [],
        notMeasured: [],
        lighthouse: [],
        limitations: []
      };

      store.saveScanReport({ visitorId: ownerVisitor }, scanResult);

      const app = createApiApp({ store });
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;

      try {
        // 1. Foreign visitor sending scanId is refused with 404
        const foreignRes = await fetch(`http://127.0.0.1:${port}/api/chat-afaf`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Visitor-Id': foreignVisitor
          },
          body: JSON.stringify({
            scanId,
            message: 'إيه الأخبار؟'
          })
        });
        assert.equal(foreignRes.status, 404, 'Foreign visitor querying private scanId in chat must receive 404');

        // 2. Client sending spoofed context is ignored; server loads authentic-site.com
        const ownerRes = await fetch(`http://127.0.0.1:${port}/api/chat-afaf`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Visitor-Id': ownerVisitor
          },
          body: JSON.stringify({
            scanId,
            message: 'إيه أهم المشاكل؟',
            // Spoofed context must be ignored!
            context: {
              domain: 'SPOOFED-EVIL-DOMAIN.COM',
              topFindings: [{ ruleId: 'FAKE_999', titleAr: 'ملاحظة مزيفة' }]
            }
          })
        });
        assert.equal(ownerRes.status, 200);
        const chatJson = await ownerRes.json() as any;
        assert.equal(chatJson.ok, true);
        assert.ok(!chatJson.reply.includes('SPOOFED-EVIL-DOMAIN.COM'), 'Server must never echo spoofed client context');
        assert.ok(chatJson.reply.includes('authentic-site.com'), 'Server must ground chat in server-stored report domain');

        // 3. Verify madam-persona.ts and eval/chat-cases.json exist
        const personaPath = path.resolve(process.cwd(), 'src/lib/madam-persona.ts');
        const chatCasesPath = path.resolve(process.cwd(), 'eval/chat-cases.json');
        assert.ok(fs.existsSync(personaPath), 'src/lib/madam-persona.ts must exist');
        assert.ok(fs.existsSync(chatCasesPath), 'eval/chat-cases.json must exist');

        const { MADAM_AFAF_FEW_SHOT_PAIRS } = await import('./madam-persona.js');
        assert.ok(Array.isArray(MADAM_AFAF_FEW_SHOT_PAIRS) && MADAM_AFAF_FEW_SHOT_PAIRS.length >= 30, 'madam-persona.ts must provide >=30 few-shot Q&A pairs');
      } finally {
        server.closeAllConnections?.();
      server.close();
      }
    } finally {
      if (fs.existsSync(tmpStoreFile)) fs.unlinkSync(tmpStoreFile);
    }
  });

  it('K0.4 & K0.5: Repo hygiene (.gitignore includes data/ and .tts-cache.json) and gold:export script', async () => {
    const gitignoreContent = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf-8');
    assert.ok(gitignoreContent.includes('data/'), '.gitignore must ignore data/');
    assert.ok(gitignoreContent.includes('.tts-cache.json'), '.gitignore must ignore .tts-cache.json');
    assert.ok(gitignoreContent.includes('.aistudio/'), '.gitignore must ignore .aistudio/');

    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    assert.ok(pkg.scripts['gold:export'], 'package.json must define gold:export script');

    const goldExportPath = path.resolve(process.cwd(), 'scripts/gold-export.ts');
    assert.ok(fs.existsSync(goldExportPath), 'scripts/gold-export.ts must exist');

    // eval/GOLD_SET.md precision numbers check: no percentage precision when n < 10
    const goldSetContent = fs.readFileSync(path.resolve(process.cwd(), 'eval/GOLD_SET.md'), 'utf-8');
    assert.equal(goldSetContent.includes('100%'), false, 'eval/GOLD_SET.md must not contain pre-filled precision percentages without n>=10');
  });

  it('K0.6: Deep Scan scaffolding (docs/DEEP_SCAN.md, deep-scan.ts providers, disabled UI button with قريبًا)', async () => {
    const deepScanDocPath = path.resolve(process.cwd(), 'docs/DEEP_SCAN.md');
    assert.ok(fs.existsSync(deepScanDocPath), 'docs/DEEP_SCAN.md must exist');
    const docContent = fs.readFileSync(deepScanDocPath, 'utf-8');
    assert.ok(docContent.includes('GLM_API_KEY'), 'DEEP_SCAN.md must document GLM_API_KEY');
    assert.ok(docContent.includes('glm-5.3'), 'DEEP_SCAN.md must document default model glm-5.3');

    const deepScanProviderPath = path.resolve(process.cwd(), 'src/lib/providers/deep-scan.ts');
    assert.ok(fs.existsSync(deepScanProviderPath), 'src/lib/providers/deep-scan.ts must exist');
    const mod = await import('./providers/deep-scan.js');
    assert.ok(mod.DisabledSecurityDeepProvider, 'Must export DisabledSecurityDeepProvider');
    assert.ok(mod.FakeBrowserChecksProvider, 'Must export FakeBrowserChecksProvider');

    const reportViewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');
    assert.ok(reportViewSrc.includes('فحص عميق') && reportViewSrc.includes('قريبًا'), 'ReportView must render disabled deep scan button with "قريبًا" chip');
  });

  it('K0.7: Voice Gemini Live API behind VOICE_LIVE_ENABLED=false with POST /api/voice/token', async () => {
    const app = createApiApp();
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/voice/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Visitor-Id': 'v_voice_token_test_123456' }
      });
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(typeof data.enabled, 'boolean');
      assert.equal(data.enabled, false, 'VOICE_LIVE_ENABLED should be false by default');
      assert.ok(data.model.includes('live'), 'Live voice model should be configured');
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
