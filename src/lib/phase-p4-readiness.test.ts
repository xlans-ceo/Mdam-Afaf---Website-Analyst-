import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('PHASE P4: Visual, Print & Final Production Readiness', () => {
  test('P4.1: Print stylesheet & /report/:id/print view enforce A4 16mm margins, expanded evidence, link URLs, page counters, and PDF filename title', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    assert.ok(css.includes('size: A4;'), 'Must define @page size: A4');
    assert.ok(css.includes('margin: 16mm;'), 'Must define @page margin: 16mm');
    assert.ok(css.includes('@bottom-center'), 'Must include progressive enhancement @bottom-center page counter in @page');
    assert.ok(css.includes('print-color-adjust: exact'), 'Must preserve colors in print');
    assert.ok(css.includes('.no-print'), 'Must hide .no-print elements');
    assert.ok(css.includes('.evidence-collapse'), 'Must expand .evidence-collapse in print');
    assert.ok(css.includes('break-inside: avoid'), 'Must prevent page breaks inside finding cards and evidence blocks');
    assert.ok(css.includes('break-after: avoid'), 'Must prevent page breaks immediately after headings');
    assert.ok(css.includes('attr(href)'), 'Must show URL after external link text in print');

    const reportViewSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/ReportView.tsx'),
      'utf8'
    );
    assert.ok(
      reportViewSrc.includes('document.title = `madam-afaf-${cleanDom}-${dateStr}`'),
      'ReportView must set document.title to madam-afaf-{domain}-{YYYYMMDD} in print mode'
    );
    assert.ok(
      reportViewSrc.includes('fonts.ready'),
      'ReportView must wait for document.fonts.ready before invoking window.print()'
    );

    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    assert.ok(
      appSrc.includes('mock_demo_wp_b2b_01') && appSrc.includes('mock_demo_spa_ai_01'),
      'App.tsx must support direct /report/mock_demo_.../print routing for sample reports'
    );
  });

  test('P4.2: Design system tokens in src/index.css match DESIGN.md and index.html enforces RTL Arabic', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    const designMd = fs.readFileSync(path.resolve(process.cwd(), 'DESIGN.md'), 'utf8');
    const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');

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
      assert.ok(css.includes(token), `src/index.css must contain locked token ${token}`);
    }

    assert.ok(
      designMd.includes('`--sticky-offset`: `3rem`'),
      'DESIGN.md must match src/index.css --sticky-offset value'
    );
    assert.ok(
      indexHtml.includes('lang="ar"') && indexHtml.includes('dir="rtl"'),
      'index.html must declare lang="ar" and dir="rtl"'
    );
  });

  test('P4.3: eval/GOLD_SET.md tracks all active and Phase P2b rules with honest NOT MEASURED YET status', () => {
    const goldSet = fs.readFileSync(path.resolve(process.cwd(), 'eval/GOLD_SET.md'), 'utf8');
    assert.ok(goldSet.includes('`RX001`'), 'GOLD_SET.md must include rule RX001');
    assert.ok(goldSet.includes('`RX002`'), 'GOLD_SET.md must include rule RX002');
    assert.ok(goldSet.includes('`R013_PERF_GROUPED`'), 'GOLD_SET.md must include rule R013_PERF_GROUPED');
    assert.ok(goldSet.includes('`SPA_H1_RECONCILED_INFO`'), 'GOLD_SET.md must include rule SPA_H1_RECONCILED_INFO');
    assert.ok(
      goldSet.includes('NOT MEASURED YET (n < 10)'),
      'GOLD_SET.md must never invent precision statistics before n >= 10 human evaluations'
    );
  });
});
