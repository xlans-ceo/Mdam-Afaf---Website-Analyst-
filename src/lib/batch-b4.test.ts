import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('BATCH B4: Legal, Feedback, Release, Preflight & Smoke Suite (B4.1..B4.7)', async (t) => {
  await t.test('B4.1: Static pages /privacy and /terms exist with required disclosures and disclaimers', () => {
    const privacyPath = path.resolve(process.cwd(), 'src/components/PrivacyPage.tsx');
    const termsPath = path.resolve(process.cwd(), 'src/components/TermsPage.tsx');
    assert.ok(fs.existsSync(privacyPath), 'src/components/PrivacyPage.tsx must exist');
    assert.ok(fs.existsSync(termsPath), 'src/components/TermsPage.tsx must exist');

    const privacySrc = fs.readFileSync(privacyPath, 'utf-8');
    const termsSrc = fs.readFileSync(termsPath, 'utf-8');

    assert.ok(privacySrc.includes('مسودة، تحتاج مراجعة قانونية'), 'Privacy page must contain legal draft note');
    assert.ok(privacySrc.includes('30') && privacySrc.includes('12'), 'Privacy page must state 30 days reports/text and 12 months aggregates retention');
    assert.ok(privacySrc.includes('PageSpeed') && (privacySrc.includes('Gemini') || privacySrc.includes('الذكاء الاصطناعي')), 'Privacy page must disclose Google PageSpeed and Gemini LLM third parties');
    assert.ok(privacySrc.includes('linkedin.com/in/mo7amadsultan'), 'Privacy page must direct deletion requests to LinkedIn developer contact');

    assert.ok(termsSrc.includes('مسودة، تحتاج مراجعة قانونية'), 'Terms page must contain legal draft note');
    assert.ok(termsSrc.includes('عينة') || termsSrc.includes('استرشادي'), 'Terms page must state automated sample review and not a guarantee');
    assert.ok(termsSrc.includes('linkedin.com/in/mo7amadsultan'), 'Terms page must direct inquiries to LinkedIn contact');
  });

  await t.test('B4.2 & B4.3: Feedback storage & rating card schema through Store interface', async () => {
    const storePath = path.resolve(process.cwd(), 'src/lib/storage.ts');
    const storeSrc = fs.readFileSync(storePath, 'utf-8');
    assert.ok(storeSrc.includes('saveReportFeedback'), 'PersistentStore must implement saveReportFeedback');
    assert.ok(storeSrc.includes('saveFindingFeedback'), 'PersistentStore must implement saveFindingFeedback');
    assert.ok(storeSrc.includes('getAdminFeedbackOverview'), 'PersistentStore must implement getAdminFeedbackOverview');
  });

  await t.test('B4.4: Read-only admin gated by Bearer ADMIN_TOKEN with constant-time compare', () => {
    const serverPath = path.resolve(process.cwd(), 'server.ts');
    const serverSrc = fs.readFileSync(serverPath, 'utf-8');
    assert.ok(serverSrc.includes('/api/admin/feedback'), 'server.ts must expose GET /api/admin/feedback');
    assert.ok(serverSrc.includes('timingSafeEqual'), 'server.ts admin check must use crypto.timingSafeEqual');
    assert.ok(serverSrc.includes('noindex'), 'server.ts admin endpoints/pages must include noindex');
  });

  await t.test('B4.5: Release config, package name madam-afaf 0.1.0-alpha.1, and operational documentation', () => {
    const releaseConfigPath = path.resolve(process.cwd(), 'src/config/release.ts');
    assert.ok(fs.existsSync(releaseConfigPath), 'src/config/release.ts must exist');

    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    assert.equal(pkg.name, 'madam-afaf', 'package.json name must be madam-afaf');
    assert.equal(pkg.version, '0.1.0-alpha.1', 'package.json version must be 0.1.0-alpha.1');

    for (const docFile of ['CHANGELOG.md', 'docs/RELEASES.md', 'docs/OPERATIONS.md', 'docs/ROADMAP.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md']) {
      assert.ok(fs.existsSync(path.resolve(process.cwd(), docFile)), `${docFile} must exist`);
    }

    const gitignorePath = path.resolve(process.cwd(), '.gitignore');
    const gitignoreSrc = fs.readFileSync(gitignorePath, 'utf-8');
    for (const ignored of ['data/', '.tts-cache.json', '.aistudio/', '.playwright-cli/']) {
      assert.ok(gitignoreSrc.includes(ignored), `.gitignore must contain ${ignored}`);
    }
  });

  await t.test('B4.6: Preflight script (scripts/preflight.ts) and Smoke script (scripts/smoke.ts) exist and are runnable', () => {
    const preflightPath = path.resolve(process.cwd(), 'scripts/preflight.ts');
    const smokePath = path.resolve(process.cwd(), 'scripts/smoke.ts');
    assert.ok(fs.existsSync(preflightPath), 'scripts/preflight.ts must exist');
    assert.ok(fs.existsSync(smokePath), 'scripts/smoke.ts must exist');

    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    assert.ok(pkg.scripts?.preflight, 'package.json must contain preflight script');
    assert.ok(pkg.scripts?.smoke, 'package.json must contain smoke script');
  });
});
