import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('PHASE H4: UI Polish & Truthful Rendering Invariants Suite', () => {
  const rootDir = process.cwd();
  const reportViewPath = path.join(rootDir, 'src/components/ReportView.tsx');
  const appPath = path.join(rootDir, 'src/App.tsx');
  const indexCssPath = path.join(rootDir, 'src/index.css');

  test('H4.1: ReportView section order strictly matches Section 5 specification without duplicates', () => {
    const content = fs.readFileSync(reportViewPath, 'utf-8');

    const sectionIds = [
      'id="sec-profile"',
      'id="sec-ai-claims"',
      'id="sec-priorities"',
      'id="sec-findings"',
      'id="sec-passes"',
      'id="sec-decisions"',
      'id="sec-not-measured"',
      'id="sec-fix-pack"',
      'id="sec-rescan"'
    ];

    let lastPos = -1;
    for (const secId of sectionIds) {
      const firstIdx = content.indexOf(secId);
      const lastIdx = content.lastIndexOf(secId);
      assert.ok(firstIdx !== -1, `Missing section ${secId} in ReportView.tsx`);
      assert.equal(firstIdx, lastIdx, `Duplicate section ${secId} found in ReportView.tsx`);
      assert.ok(
        firstIdx > lastPos,
        `Section ${secId} is out of order (found at ${firstIdx}, expected after ${lastPos})`
      );
      lastPos = firstIdx;
    }
  });

  test('H4.2: Finding card anatomy includes all required Section 5 elements and progressive disclosure', () => {
    const content = fs.readFileSync(reportViewPath, 'utf-8');

    const requiredAnatomyMarkers = [
      'اللي شفته:',
      'المفروض:',
      'إزاي تتأكد بنفسك:',
      'الحل (',
      'الدليل (الكود المرصود)',
      'نسخ الحل',
      'الملاحظة دي صح؟',
      '👍 صح',
      '👎 لأ',
      'evidence-collapse evidence-block'
    ];

    for (const marker of requiredAnatomyMarkers) {
      assert.ok(
        content.includes(marker),
        `Finding card in ReportView.tsx is missing required marker: ${marker}`
      );
    }
  });

  test('H4.3: Locked design tokens and Print CSS rules are present in src/index.css', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');

    const requiredTokens = [
      '--bg: #FAF5EC',
      '--surface: #FFFFFF',
      '--surface-alt: #F1E9DB',
      '--ink: #231C16',
      '--ink-muted: #5E5348',
      '--border: #DDD2C0',
      '--border-strong: #8C7F6F',
      '--primary: #0B5D5E',
      '--primary-hover: #084647',
      '--on-primary: #FFFFFF',
      '--pen: #8E1B12',
      '--sev-critical-bg: #FDE8E6',
      '--sev-critical-fg: #8E1B12',
      '--sev-high-bg: #FDEDE6',
      '--sev-high-fg: #A8321A',
      '--sev-medium-bg: #FFF1D0',
      '--sev-medium-fg: #7A4F00',
      '--sev-low-bg: #E6EEF8',
      '--sev-low-fg: #1D4E89',
      '--pass-bg: #E4F3E8',
      '--pass-fg: #1F6B3A'
    ];

    for (const token of requiredTokens) {
      assert.ok(css.includes(token), `Missing or altered CSS token in src/index.css: ${token}`);
    }

    assert.ok(css.includes('size: A4'), 'Print CSS must specify A4 page size');
    assert.ok(css.includes('margin: 16mm'), 'Print CSS must specify 16mm margins');
    assert.ok(css.includes('break-inside: avoid'), 'Print CSS must avoid breaking inside cards/evidence');
    assert.ok(css.includes('break-after: avoid'), 'Print CSS must avoid breaking after headings');
    assert.ok(css.includes('print-color-adjust: exact'), 'Print CSS must preserve exact colors');
  });

  test('H4.4: Zero banned AI hype phrases in UI components and App.tsx supports /print route', () => {
    const componentsDir = path.join(rootDir, 'src/components');
    const files = fs
      .readdirSync(componentsDir)
      .filter(f => f.endsWith('.tsx'))
      .map(f => path.join(componentsDir, f));
    files.push(appPath);

    const bannedTerms = ['AI-powered', 'ثورة', 'ذكاء خارق', '100% دقة', '98/100'];

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf-8');
      for (const term of bannedTerms) {
        assert.ok(
          !code.includes(term),
          `Banned hype term "${term}" found in ${path.basename(file)}`
        );
      }
    }

    const appCode = fs.readFileSync(appPath, 'utf-8');
    assert.ok(
      appCode.includes("window.location.pathname.endsWith('/print')"),
      'App.tsx must pass initialPrintMode when URL ends with /print'
    );
  });
});
