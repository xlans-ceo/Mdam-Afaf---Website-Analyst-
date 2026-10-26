/**
 * Step 2: Finding Invariants & Hard Consistency Rules (normalizeFinding)
 * Enforced deterministically in code, never by prompt.
 */
import {
  Category,
  Confidence,
  Evidence,
  Finding,
  FindingMethod,
  Kind,
  Severity,
  TaxonomyCategory
} from '../types/contract';
import { SCAN_LIMITS } from '../config/limits';
import { computeFindingFingerprint } from './fingerprint';

export { computeFindingFingerprint };

const FIXED_TAXONOMY: Set<TaxonomyCategory> = new Set([
  'security',
  'accessibility',
  'seo',
  'links',
  'content',
  'performance',
  'responsive'
]);

export function mapToTaxonomyCategory(cat: Category, ruleId?: string): TaxonomyCategory {
  if (ruleId === 'R010') return 'security';
  if (FIXED_TAXONOMY.has(cat as TaxonomyCategory)) {
    return cat as TaxonomyCategory;
  }
  switch (cat) {
    case 'navigation':
    case 'interaction':
      return 'links';
    case 'forms':
      return 'accessibility';
    case 'images':
      return 'performance';
    case 'console':
    case 'requirement_gap':
    default:
      return 'content';
  }
}

function normalizeEvidenceList(evidence: Evidence[] | undefined): Evidence[] {
  if (!Array.isArray(evidence)) return [];
  const cleaned: Evidence[] = [];
  for (const item of evidence) {
    if (!item) continue;
    const rawVal = (item.value ?? item.ref ?? '').trim();
    if (!rawVal) continue;
    cleaned.push({
      ...item,
      value: rawVal,
      ref: rawVal
    });
  }
  return cleaned;
}

/**
 * Enforces all Finding Invariants:
 * 1. No evidence -> returns null (finding is dropped).
 * 2. high/critical require confidence === 'confirmed', else downgraded to 'medium'.
 * 3. kind === 'confirmed_defect' requires confidence === 'confirmed'; else becomes 'suspected_issue'.
 * 4. method === 'llm_judgment':
 *    - confidence capped at 'likely'
 *    - severity capped at 'low'
 *    - requires a verbatim quote / snippet in evidence
 *    - needsHumanDecision forced to true
 * 5. method === 'static_html' cannot make a rendered-layout claim (mobile overflow R005, LCP R013)
 *    above confidence 'likely' and severity 'medium'.
 * 6. Category normalized to the fixed 7-category taxonomy.
 */
export function normalizeFinding(raw: Finding): Finding | null {
  const evidence = normalizeEvidenceList(raw.evidence);
  if (evidence.length === 0) {
    return null;
  }

  const method: FindingMethod =
    raw.method ||
    (raw.source === 'lighthouse'
      ? 'psi'
      : raw.source === 'playwright'
      ? 'rendered'
      : 'static_html');

  let confidence: Confidence = raw.confidence || 'likely';
  let severity: Severity = raw.severity || 'low';
  let kind: Kind = raw.kind || 'suspected_issue';
  let needsHumanDecision = Boolean(raw.needsHumanDecision);
  const category = mapToTaxonomyCategory(raw.category, raw.ruleId);

  // Rule 4: llm_judgment invariants
  if (method === 'llm_judgment') {
    const hasQuoteEvidence = evidence.some(
      e =>
        (e.type === 'quote' || e.type === 'snippet' || e.type === 'text' || e.type === 'dom_snippet') &&
        (e.value || e.ref).trim().length >= 3
    );
    if (!hasQuoteEvidence) {
      return null;
    }
    if (confidence === 'confirmed') {
      confidence = 'likely';
    }
    if (severity === 'critical' || severity === 'high' || severity === 'medium') {
      severity = 'low';
    }
    needsHumanDecision = true;
  }

  // Rule 5: static_html cannot claim rendered-layout or rendered-interaction defects (mobile overflow, LCP, JS language switcher) as confirmed
  const isRenderedLayoutOrBehaviorClaim =
    raw.ruleId === 'R005' ||
    raw.ruleId === 'R003_LANG' ||
    (category === 'responsive' && /overflow|scrollWidth|عرض ثابت|بيخرج بره/i.test(`${raw.title} ${raw.observed}`)) ||
    (raw.ruleId === 'R013' && /LCP|Largest Contentful Paint/i.test(`${raw.title} ${raw.observed}`));

  if (method === 'static_html' && isRenderedLayoutOrBehaviorClaim) {
    if (confidence === 'confirmed') {
      confidence = 'likely';
    }
    if (severity === 'critical' || severity === 'high') {
      severity = 'medium';
    }
  }

  // Rule 2: high/critical require confirmed; otherwise downgrade to medium
  if ((severity === 'critical' || severity === 'high') && confidence !== 'confirmed') {
    severity = 'medium';
  }

  // Rule 3: confirmed_defect requires confirmed; otherwise suspected_issue
  if (kind === 'confirmed_defect' && confidence !== 'confirmed') {
    kind = 'suspected_issue';
  }

  // Rule 6 (A4): affectsVerdict is true only when confidence === 'confirmed', kind !== 'recommendation', and not explicitly disabled
  const affectsVerdict =
    confidence === 'confirmed' &&
    kind !== 'recommendation' &&
    !needsHumanDecision &&
    (raw.affectsVerdict !== undefined ? Boolean(raw.affectsVerdict) : kind === 'confirmed_defect');

  return {
    ...raw,
    category,
    method,
    confidence,
    severity,
    kind,
    needsHumanDecision,
    affectsVerdict,
    evidence
  };
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  improvement: 4
};

const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 0,
  likely: 1,
  suspected: 2,
  unverified: 3
};

export function sortFindingsDeterministically(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4);
    if (sevDiff !== 0) return sevDiff;
    return (CONFIDENCE_RANK[a.confidence] ?? 3) - (CONFIDENCE_RANK[b.confidence] ?? 3);
  });
}

/**
 * Normalizes a list of findings, filters out any invalid/evidenceless items,
 * and caps displayed findings per category at MAX_FINDINGS_DISPLAYED_PER_CATEGORY (5),
 * returning both the capped list and overflow counts per category.
 */
export function normalizeAndCapFindings(
  rawFindings: Finding[],
  maxPerCategory: number = SCAN_LIMITS.MAX_FINDINGS_DISPLAYED_PER_CATEGORY
): {
  findings: Finding[];
  allNormalized: Finding[];
  overflowCountsByCategory: Partial<Record<TaxonomyCategory, number>>;
} {
  const normalized = rawFindings
    .map(f => normalizeFinding(f))
    .filter((f): f is Finding => f !== null);

  const sorted = sortFindingsDeterministically(normalized);
  const countsByCat: Partial<Record<TaxonomyCategory, number>> = {};
  const overflowCountsByCategory: Partial<Record<TaxonomyCategory, number>> = {};
  const capped: Finding[] = [];

  for (const item of sorted) {
    const cat = mapToTaxonomyCategory(item.category, item.ruleId);
    const current = countsByCat[cat] ?? 0;
    if (current < maxPerCategory) {
      capped.push(item);
      countsByCat[cat] = current + 1;
    } else {
      overflowCountsByCategory[cat] = (overflowCountsByCategory[cat] ?? 0) + 1;
    }
  }

  return {
    findings: capped,
    allNormalized: sorted,
    overflowCountsByCategory
  };
}


