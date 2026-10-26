import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createApiApp } from '../../server';
import { SCAN_LIMITS } from '../config/limits';
import { validateVisitorIdSalt } from './storage';

describe('PHASE J5: Final Verification & System Invariants Suite', () => {
  it('J5.1: Health, capabilities, and quota endpoints respond correctly without authentication', async () => {
    const app = createApiApp();
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // 1. Health
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json() as any;
      assert.equal(health.ok, true);
      assert.equal(health.status, 'healthy');
      assert.equal(health.version, SCAN_LIMITS.RULESET_VERSION);

      // 2. Capabilities
      const capRes = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
      assert.equal(capRes.status, 200);
      const caps = await capRes.json() as any;
      assert.equal(caps.ok, true);
      assert.equal(typeof caps.capabilities, 'object');
      for (const val of Object.values(caps.capabilities)) {
        assert.equal(typeof val, 'boolean', 'All capability values must be strict booleans');
      }

      // 3. Quota
      const quotaRes = await fetch(`http://127.0.0.1:${port}/api/quota?domain=elabyad-eg.com`);
      assert.equal(quotaRes.status, 200);
      const quota = await quotaRes.json() as any;
      assert.equal(quota.ok, true);
      assert.equal(typeof quota.pagesRemaining, 'number');
      assert.equal(typeof quota.maxPages, 'number');
    } finally {
      server.close();
    }
  });

  it('J5.2: Sensitive paths (/data, /server.ts, /scripts, /eval, /.env) are blocked with 404', async () => {
    const app = createApiApp();
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const blockedPaths = [
        '/data',
        '/data/store.json',
        '/server.ts',
        '/scripts/bench-scan.ts',
        '/eval/GOLD_SET.md',
        '/.env',
        '/.env.example',
        '/.env.production'
      ];

      for (const p of blockedPaths) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        assert.equal(res.status, 404, `Path ${p} must be blocked with 404, got ${res.status}`);
      }
    } finally {
      server.close();
    }
  });

  it('J5.3: Production security: VISITOR_ID_SALT enforces >= 32 characters in production', () => {
    assert.throws(
      () => validateVisitorIdSalt({ NODE_ENV: 'production', VISITOR_ID_SALT: '' }),
      /VISITOR_ID_SALT/
    );
    assert.throws(
      () => validateVisitorIdSalt({ NODE_ENV: 'production', VISITOR_ID_SALT: 'short-salt-under-32-chars' }),
      /32/
    );
    const valid = validateVisitorIdSalt({
      NODE_ENV: 'production',
      VISITOR_ID_SALT: 'a_secure_production_salt_of_sufficient_length_32_chars'
    });
    assert.equal(valid.valid, true);
  });

  it('J5.4: Client dist bundle is clean of server tokens and secrets', () => {
    const distAssetsDir = path.resolve(process.cwd(), 'dist/assets');
    assert.ok(fs.existsSync(distAssetsDir), 'dist/assets directory must exist (built)');

    const files = fs.readdirSync(distAssetsDir).filter(f => f.endsWith('.js'));
    assert.ok(files.length > 0, 'Must have at least one JS bundle file in dist/assets');

    const forbiddenTokens = [
      'process.cwd',
      'dotenv',
      'node:fs',
      'GEMINI_API_KEY',
      'PSI_API_KEY',
      'VISITOR_ID_SALT'
    ];

    for (const f of files) {
      const content = fs.readFileSync(path.join(distAssetsDir, f), 'utf-8');
      for (const token of forbiddenTokens) {
        assert.equal(
          content.includes(token),
          false,
          `Forbidden token "${token}" found in client bundle ${f}`
        );
      }
    }
  });
});
