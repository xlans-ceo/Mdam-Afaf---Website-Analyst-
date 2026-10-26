#!/usr/bin/env tsx
/**
 * CLI tool: scans a URL and prints findings in a Markdown table for HUMAN labeling.
 * The AI agent NEVER labels findings. Human developers inspect the URL and record TP/FP.
 * Usage: npm run gold:export -- <url>
 */
import { validateAndNormalizeUrl } from '../src/lib/url-gatekeeper';
import { getScannerProvider } from '../src/lib/providers/index';
import { Finding } from '../src/types/contract';

async function main() {
  const args = process.argv.slice(2);
  const targetUrl = args[0];

  if (!targetUrl) {
    console.error('Usage: npm run gold:export -- <url>');
    process.exit(1);
  }

  const val = validateAndNormalizeUrl(targetUrl);
  if (!val.ok || !val.normalizedUrl) {
    console.error(`Invalid URL: ${val.errorAr || 'Check input'}`);
    process.exit(1);
  }

  console.log(`\n🔍 Scanning URL: ${val.normalizedUrl} ...\n`);
  const provider = getScannerProvider('live');
  const scanId = `gold_${Date.now()}`;
  const result = await provider.runScan(scanId, { url: val.normalizedUrl, locale: 'ar-EG' }, () => {});

  const findings: Finding[] = result.findings || [];
  console.log(`### Gold Export for ${result.registrableDomain || val.normalizedUrl}\n`);
  console.log(`Total Findings: ${findings.length}\n`);

  console.log('| # | Finding ID | Rule ID | Category | Severity | Where / Location | Evidence (One-Liner) | Human Label (TP/FP) |');
  console.log('|---|---|---|---|---|---|---|---|');

  findings.forEach((f: Finding, idx: number) => {
    const whereStr = f.where?.pageUrl || f.url || f.location || '—';
    const firstEv = f.evidence && f.evidence[0] ? (f.evidence[0].value || f.evidence[0].ref || f.evidence[0].note || '') : '—';
    const cleanEv = String(firstEv).replace(/\r?\n/g, ' ').slice(0, 80);
    console.log(`| ${idx + 1} | \`${f.id}\` | \`${f.ruleId}\` | \`${f.category}\` | \`${f.severity}\` | \`${whereStr}\` | ${cleanEv} | _Human to fill_ |`);
  });

  console.log('\n> Instructions: Human reviewer fills the last column with TP (True Positive) or FP (False Positive) after manual inspection.\n');
}

main().catch(err => {
  console.error('Scan error:', err);
  process.exit(1);
});
