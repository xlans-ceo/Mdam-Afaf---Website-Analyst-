import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextFromScanResult, NO_SITE_SCANNED_PROMPT } from './chat-context';
import { computeFindingFingerprint } from './fingerprint';
import { SCAN_LIMITS } from '../config/limits';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const FORBIDDEN_SPECIFIERS = new Set([
  'fs',
  'path',
  'os',
  'child_process',
  'dotenv',
  '@google/genai',
  'express',
  'vite',
  'firebase',
  'firebase-admin'
]);

export function isForbiddenClientSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith('node:') || FORBIDDEN_SPECIFIERS.has(spec)) return true;
  if (spec.startsWith('firebase/') || spec.startsWith('@firebase/')) return true;
  if (spec.includes('firebase-applet-config')) return true;
  return false;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

export function extractValueImportSpecifiers(source: string): string[] {
  const cleaned = stripComments(source);
  const specifiers: string[] = [];

  // Match static import / export-from statements across lines
  const importExportRegex =
    /\b(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importExportRegex.exec(cleaned)) !== null) {
    const clause = (match[1] || '').trim();
    const spec = match[2] || match[3];
    if (!spec) continue;

    // Ignore pure type imports/exports: `import type ...` or `export type ...`
    if (/^type\b/.test(clause)) {
      continue;
    }

    // If named imports exist `{ a, type b }`, check if ALL named bindings are `type`
    if (clause.startsWith('{') && clause.endsWith('}')) {
      const inner = clause.slice(1, -1).trim();
      const parts = inner
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
      if (parts.length > 0 && parts.every(p => /^type\s+/.test(p))) {
        continue;
      }
    }

    specifiers.push(spec);
  }

  // Match dynamic imports: import('...')
  const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(cleaned)) !== null) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  let baseTarget: string;
  if (specifier.startsWith('.')) {
    baseTarget = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith('@/')) {
    baseTarget = path.resolve(ROOT_DIR, specifier.slice(2));
  } else {
    return null;
  }

  const candidates = [
    baseTarget,
    `${baseTarget}.ts`,
    `${baseTarget}.tsx`,
    `${baseTarget}.js`,
    `${baseTarget}.jsx`,
    path.join(baseTarget, 'index.ts'),
    path.join(baseTarget, 'index.tsx')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

export function scanClientImportGraph(entryFile: string): {
  visitedFiles: string[];
  violations: string[];
} {
  const visited = new Set<string>();
  const queue: string[] = [entryFile];
  const violations: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    if (current.endsWith('.css')) continue;

    const raw = fs.readFileSync(current, 'utf8');
    const codeOnly = stripComments(raw);
    const relPath = path.relative(ROOT_DIR, current);

    if (/\bprocess\./.test(codeOnly)) {
      violations.push(`${relPath}: references forbidden 'process.'`);
    }
    if (/\b__dirname\b/.test(codeOnly)) {
      violations.push(`${relPath}: references forbidden '__dirname'`);
    }

    const specs = extractValueImportSpecifiers(raw);
    for (const spec of specs) {
      if (isForbiddenClientSpecifier(spec)) {
        violations.push(`${relPath}: imports forbidden server module '${spec}'`);
        continue;
      }

      const resolved = resolveLocalModule(current, spec);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return {
    visitedFiles: Array.from(visited).map(f => path.relative(ROOT_DIR, f)),
    violations
  };
}

test('H1.5: Client bundle import graph from src/main.tsx has zero server/Node imports or process/dirname references', () => {
  const entry = path.resolve(ROOT_DIR, 'src/main.tsx');
  const { visitedFiles, violations } = scanClientImportGraph(entry);

  assert.ok(visitedFiles.length >= 10, `Expected to walk client graph, visited ${visitedFiles.length}`);
  assert.deepEqual(
    violations,
    [],
    `Client bundle guard found forbidden server dependencies:\n${violations.join('\n')}`
  );
});

test('H1.5: Guard detector catches forbidden node:*, dotenv, @google/genai, process., and __dirname', () => {
  const specs = extractValueImportSpecifiers(`
    import fs from 'node:fs';
    import type { Something } from 'node:path';
    import { GoogleGenAI } from '@google/genai';
    const lazy = () => import('./App.tsx');
  `);
  assert.deepEqual(specs, ['node:fs', '@google/genai', './App.tsx']);
});

test('H1.1 & H1.2 & H1.3: Browser-safe modules work without Node globals', () => {
  assert.equal(typeof NO_SITE_SCANNED_PROMPT, 'string');
  assert.ok(NO_SITE_SCANNED_PROMPT.includes('أنت لسه ما ضفتش موقع'));

  const ctx = buildContextFromScanResult(null);
  assert.equal(ctx, undefined);

  const fp = computeFindingFingerprint({
    id: 'f1',
    ruleId: 'R001',
    category: 'seo',
    severity: 'medium',
    confidence: 'confirmed',
    kind: 'confirmed_defect',
    title: 'Missing H1',
    url: 'https://example.com',
    occurrences: 1,
    observed: '0 H1',
    expected: '1 H1',
    steps: [],
    recommendedFix: 'Add H1',
    evidence: [{ type: 'snippet', value: '<title>Test</title>', ref: '<title>Test</title>' }],
    source: 'rule'
  });
  assert.equal(fp, 'R001::Missing H1::https://example.com');
  assert.equal(SCAN_LIMITS.MAX_PAGES_PER_SCAN, 10);
});
