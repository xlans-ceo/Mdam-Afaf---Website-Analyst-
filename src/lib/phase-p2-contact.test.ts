import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEVELOPER_CONTACT } from '../config/limits';
import { MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT } from './ai-consultant';
import { buildSiteProfile } from './site-profiler';
import { runHonestChecks } from './honest-checks';

test('PHASE P2: Developer Contact & WhatsApp Separation Suite', async (t) => {
  await t.test('P2.1: Product own WhatsApp number is completely absent from all source code', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const oldNumbers = ['01140226705', '201140226705'];

    function scanFiles(dir: string): string[] {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js'))) {
          // Exclude this test file itself from the literal search
          if (entry.name === 'phase-p2-contact.test.ts') continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const num of oldNumbers) {
            if (content.includes(num)) {
              results.push(`${entry.name} contains old number: ${num}`);
            }
          }
        }
      }
      return results;
    }

    const violations = scanFiles(srcDir);
    assert.deepEqual(violations, [], `No source file should contain the old developer phone number. Found: ${violations.join(', ')}`);

    // Verify WhatsAppSupport component file is removed
    const whatsappSupportPath = path.resolve(srcDir, 'components/WhatsAppSupport.tsx');
    assert.equal(fs.existsSync(whatsappSupportPath), false, 'WhatsAppSupport.tsx must be completely deleted');
  });

  await t.test('P2.2: App.tsx footer and ReportView.tsx menu link directly to LinkedIn profile', () => {
    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
    const reportSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ReportView.tsx'), 'utf-8');

    // Expected LinkedIn URL
    const expectedUrl = 'https://www.linkedin.com/in/mo7amadsultan/';
    assert.equal(DEVELOPER_CONTACT.LINKEDIN_URL, expectedUrl);

    // App footer check
    assert.ok(appSrc.includes('data-testid="footer-linkedin-link"'), 'App footer must contain data-testid="footer-linkedin-link"');
    assert.ok(!appSrc.includes('data-testid="footer-whatsapp-link"'), 'App footer must not contain data-testid="footer-whatsapp-link"');
    assert.ok(appSrc.includes(expectedUrl), 'App footer must reference LinkedIn profile URL');
    assert.ok(appSrc.includes('rel="noopener noreferrer"'), 'App footer must include rel="noopener noreferrer"');
    assert.ok(appSrc.includes('target="_blank"'), 'App footer must open in new tab target="_blank"');

    // ReportView menu check
    assert.ok(reportSrc.includes('data-testid="menu-linkedin-link"'), 'ReportView menu must contain data-testid="menu-linkedin-link"');
    assert.ok(!reportSrc.includes('data-testid="menu-whatsapp-link"'), 'ReportView menu must not contain data-testid="menu-whatsapp-link"');
    assert.ok(reportSrc.includes(expectedUrl), 'ReportView menu must reference LinkedIn profile URL');
  });

  await t.test('P2.3: AI consultant prompts and fallback messages direct to LinkedIn and Mohamed Sultan', () => {
    assert.ok(
      MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('https://www.linkedin.com/in/mo7amadsultan/'),
      'AI consultant prompt must include the LinkedIn URL'
    );
    assert.ok(
      MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('محمد سلطان'),
      'AI consultant prompt must reference Mohamed Sultan'
    );
    assert.ok(
      !MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('01140226705'),
      'AI consultant prompt must NOT contain old WhatsApp number'
    );
  });

  await t.test('P2.4: Scanned website WhatsApp conversion detection remains 100% functional', () => {
    // Verify that scanned sites with wa.me links are still accurately classified as having WhatsApp primary conversion
    const sampleHtml = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head><title>شركة تجريبية</title></head>
      <body>
        <header>
          <a href="https://wa.me/201011112222">تواصل واتساب لطلب المنتجات</a>
        </header>
        <main>
          <h1>أفضل خدمات المقاولات</h1>
        </main>
      </body>
      </html>
    `;

    const profile = buildSiteProfile({
      html: sampleHtml,
      url: 'https://test-company.com',
      headers: {}
    });
    assert.equal(profile.primaryConversion?.type, 'whatsapp', 'Scanned site WhatsApp detection must be preserved');
    assert.equal(profile.primaryConversion?.inTopOfPage, true, 'WhatsApp link in header must be detected near top');

    // Verify RC007 rule still detects invalid wa.me formats on scanned sites (missing country code)
    const invalidWaHtml = `
      <!DOCTYPE html>
      <html lang="ar">
      <head><title>موقع مع واتساب محلي</title></head>
      <body>
        <a href="https://wa.me/01012345678">واتساب بدون كود الدولة</a>
      </body>
      </html>
    `;

    const out = runHonestChecks({
      html: invalidWaHtml,
      url: 'https://test-invalid-wa.com',
      status: 200,
      headers: {},
      ttfbMs: 100
    });

    const rc007Finding = out.findings.find(f => f.ruleId === 'RC007');
    assert.ok(rc007Finding, 'RC007 must still trigger on scanned site wa.me without country code');
  });
});
