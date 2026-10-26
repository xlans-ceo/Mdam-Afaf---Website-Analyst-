/**
 * Deterministic Token-Efficient & Platform-Aware Repair Prompt Builder (No LLM required)
 * Supports two repair modes:
 * 1. CMS / No-Repo mode ('cms_checklist') for WordPress/Elementor/Shopify/Wix/Squarespace/Webflow
 * 2. Code Repo Agent mode ('code_agent_prompt') for React/Next.js/Static HTML codebases
 * Also generates the Developer Markdown Handoff ("تقرير لمبرمج") with "المؤكد فقط" filtering (J2.3).
 */
import { Finding, SiteProfile, VerdictInfo } from '../types/contract';
import { buildPlatformAwareRepairPack, getPlatformLabelAr } from './platform-adapter';

export interface BuiltRepairPrompts {
  repairMode: 'cms_checklist' | 'code_agent_prompt';
  masterPrompt: string;
  confirmedOnlyMasterPrompt: string;
  developerMarkdownHandoff: string;
  confirmedOnlyDeveloperMarkdownHandoff: string;
  cmsChecklistItems: string[];
  individualPrompts: Record<string, string>;
}

/**
 * Estimates LLM token count (~4 chars per token for technical prompts).
 */
export function estimatePromptTokens(promptText: string): number {
  if (!promptText) return 0;
  return Math.max(1, Math.ceil(promptText.trim().length / 4));
}

function sortFindingsByPriority(findings: Finding[]): Finding[] {
  const severityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    improvement: 4
  };

  const confidenceRank: Record<string, number> = {
    confirmed: 0,
    likely: 1,
    suspected: 2,
    unverified: 3
  };

  return [...findings].sort((a, b) => {
    const confDiff = (confidenceRank[a.confidence] ?? 2) - (confidenceRank[b.confidence] ?? 2);
    if (confDiff !== 0) return confDiff;
    return (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3);
  });
}

export function buildDeveloperMarkdownHandoff(
  params: {
    requestedUrl: string;
    finalUrl?: string;
    scanId?: string;
    startedAt?: string;
    siteProfile?: SiteProfile;
    verdict?: VerdictInfo;
    findings: Finding[];
  },
  options?: { confirmedOnly?: boolean }
): string {
  const confirmedOnly = Boolean(options?.confirmedOnly);
  const sorted = sortFindingsByPriority(params.findings).filter(
    f => f.ruleId !== 'RC002' && (!confirmedOnly || f.confidence === 'confirmed')
  );
  const stackLabel = getPlatformLabelAr(params.siteProfile);
  const targetUrl = params.finalUrl || params.requestedUrl;
  const verdictLabel = params.verdict?.labelAr || 'مراجعة فنية للموقع';

  const lines: string[] = [
    `# تقرير تسليم فني للمبرمج — مدام عفاف`,
    ``,
    `- **الموقع:** ${targetUrl}`,
    `- **المنصة المكتشفة:** ${stackLabel}`,
    `- **الخلاصة:** ${verdictLabel}`,
    `- **نطاق الملاحظات المعروضة:** ${confirmedOnly ? 'المؤكد فقط بالدليل المباشر' : 'كل الملاحظات المرصودة'} (${sorted.length})`,
    ``,
    `## 1. ملخص الأولويات`,
  ];

  if (params.verdict?.summaryLinesAr) {
    lines.push(`- ${params.verdict.summaryLinesAr[0]}`);
    lines.push(`- ${params.verdict.summaryLinesAr[1]}`);
  }

  if (sorted.length === 0) {
    lines.push(``, `لا توجد ملاحظات مطابقة للفلتر الحالي.`);
  } else {
    lines.push(``, `## 2. الملاحظات المرتبة بالأولوية (مع المكان والدليل وخطوات الإصلاح)`);
    sorted.forEach((f, idx) => {
      const title = f.titleAr || f.title;
      const wherePage = f.where?.pageUrl || f.url;
      const whereSection = f.where?.sectionAr || 'المحتوى الرئيسي';
      const whereText = f.where?.visibleText ? ` | النص الظاهر: «${f.where.visibleText}»` : '';
      const whereSelector = f.where?.selector ? `\n- **المحدد البرمجي (Selector):** \`${f.where.selector}\`` : '';
      const firstEv = f.evidence?.[0]?.value || f.evidence?.[0]?.ref || f.where?.snippet || '';

      lines.push(
        ``,
        `### ${idx + 1}. [${f.ruleId}] ${title}`,
        `- **الخطورة / الثقة:** ${f.severity.toUpperCase()} / ${f.confidence.toUpperCase()} (${f.category})`,
        `- **الصفحة:** ${wherePage}`,
        `- **المكان:** ${whereSection}${whereText}${whereSelector}`,
        `- **اللي شفته:** ${f.observed}`,
        ...(f.expected ? [`- **المفروض:** ${f.expected}`] : []),
        ...(firstEv ? [`- **الدليل المرصود:**\n\`\`\`html\n${firstEv.slice(0, 220)}\n\`\`\``] : []),
        `- **خطوة الإصلاح المطلوبة:** ${f.recommendedFix}`
      );
    });

    lines.push(
      ``,
      `## 3. قائمة التحقق قبل التسليم (Acceptance Checks)`,
      ...sorted.map((f) => {
        const title = f.titleAr || f.title;
        const step = f.steps?.[0] || 'أعد فحص العنصر وتأكد من زوال المشكلة.';
        return `- [ ] **[${f.ruleId}] ${title}:** ${step}`;
      })
    );
  }

  return lines.join('\n').trim();
}

export function buildRepairPrompts(result: {
  requestedUrl: string;
  finalUrl?: string;
  scanId?: string;
  startedAt?: string;
  purpose?: string;
  keyJourney?: string;
  siteProfile?: SiteProfile;
  verdict?: VerdictInfo;
  findings: Finding[];
  toolOverride?: string;
}): BuiltRepairPrompts {
  const { requestedUrl, purpose, keyJourney, siteProfile, findings, toolOverride } = result;
  const sortedFindings = sortFindingsByPriority(findings);
  const confirmedFindings = sortedFindings.filter(f => f.confidence === 'confirmed');

  const fullPack = buildPlatformAwareRepairPack({
    requestedUrl,
    purpose,
    keyJourney,
    profile: siteProfile,
    findings: sortedFindings,
    toolOverride
  });

  const confirmedPack = buildPlatformAwareRepairPack({
    requestedUrl,
    purpose,
    keyJourney,
    profile: siteProfile,
    findings: confirmedFindings,
    toolOverride
  });

  const developerMarkdownHandoff = buildDeveloperMarkdownHandoff(result, { confirmedOnly: false });
  const confirmedOnlyDeveloperMarkdownHandoff = buildDeveloperMarkdownHandoff(result, { confirmedOnly: true });

  return {
    repairMode: fullPack.repairMode,
    masterPrompt: fullPack.masterPrompt,
    confirmedOnlyMasterPrompt: confirmedPack.masterPrompt,
    developerMarkdownHandoff,
    confirmedOnlyDeveloperMarkdownHandoff,
    cmsChecklistItems: fullPack.cmsChecklistItems,
    individualPrompts: fullPack.individualPrompts
  };
}
