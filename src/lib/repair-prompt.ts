/**
 * Repair Prompt Generator
 * Synthesizes actionable, minimal-impact engineering prompts for AI code assistants or human developers,
 * adhering to strict non-regression and preservation guidelines.
 */
import { Finding, ScanJob } from '../types/index';

export interface GeneratedRepairPrompts {
  masterPrompt: string;
  individualPrompts: Record<string, string>;
}

export function generateRepairPrompts(job: {
  url: string;
  websitePurpose?: string;
  mainJourney?: string;
  findings: Finding[];
}): GeneratedRepairPrompts {
  const { url, websitePurpose, mainJourney, findings } = job;

  // Filter to actionable findings (critical, high, medium, low)
  const actionableFindings = findings.filter(f => f.severity !== 'improvement' || f.statusType === 'confirmed_defect');
  const prioritized = actionableFindings.sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3, improvement: 4 };
    return rank[a.severity] - rank[b.severity];
  });

  // 1. Generate Individual Prompts
  const individualPrompts: Record<string, string> = {};

  for (const f of findings) {
    individualPrompts[f.id] = `### أمر إصلاح محدد: ${f.title} (${f.titleAr})

**الموقع:** ${f.affectedUrl}
**مستوى الأهمية:** ${f.severity.toUpperCase()} | **الحالة:** ${f.statusType}

**1. المشكلة المرصودة (Observed Behavior):**
${f.observedBehavior}
${f.explanationAr ? `*شرح مدام عفاف:* ${f.explanationAr}` : ''}

${f.expectedBehavior ? `**2. السلوك المتوقع (Expected Behavior):**\n${f.expectedBehavior}\n` : ''}
${f.reproductionStepsAr && f.reproductionStepsAr.length > 0 ? `**3. خطوات إعادة إنتاج المشكلة:**\n${f.reproductionStepsAr.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}\n` : ''}
**4. التعديل الهندسي المطلوب (Recommended Fix):**
${f.recommendedFixEn || f.recommendedFixAr}
${f.recommendedFixAr ? `*بالتفصيل:* ${f.recommendedFixAr}` : ''}

${f.technicalDetails?.selector ? `- المستهدف (Selector): \`${f.technicalDetails.selector}\`` : ''}
${f.technicalDetails?.httpStatus ? `- كود الاستجابة: ${f.technicalDetails.httpStatus}` : ''}

**تعليمات التنفيذ للمطور أو الذكاء الاصطناعي:**
1. افحص الملف المسؤول عن العنصر ده أولاً قبل إجراء أي تعديل.
2. التزم بالتعديل الجراحي الأدنى (Minimal Targeted Fix) دون تغيير التصميم أو إعادة بناء الشفرة.
3. لا تقم بحذف أي وظائف أخرى أو كسر المسارات القائمة.
4. اختبر التغيير وتأكد من حل المشكلة دون أي أخطاء جانبية (No regressions).
5. وضّح في تقريرك النهائي أسماء الملفات التي تم تعديلها.`;
  }

  // 2. Generate Master Prompt
  let masterPrompt = `# خطة وأوامر الإصلاح الفني للموقع (تقرير مدام عفاف)

**الموقع المستهدف:** ${url}
${websitePurpose ? `**غرض الموقع:** ${websitePurpose}\n` : ''}${mainJourney ? `**رحلة المستخدم الأساسية:** ${mainJourney}\n` : ''}
---

## تعليمات عامة ملزمة لأداة البرمجة (Engineering Guidelines):
- **قاعدة التدخل الجراحي الأدنى:** قم بإصلاح المشاكل المحددة فقط دون إعادة تصميم الموقع أو إعادة هيكلة المجلدات.
- **الحفاظ على البنية الحالية:** حافظ على إطار العمل (Framework)، مكتبات التنسيق، مسارات التوجيه، ونظام التصميم الحالي.
- **ممنوع الاعتماديات غير الضرورية:** لا تثبت أي حزم npm جديدة ما لم تكن ضرورية للغاية للإصلاح.
- **فحص الانحدار (Regression Check):** بعد كل تعديل، تأكد من استمرار عمل المكونات المرتبطة بشكل سليم.
- **تقرير النتائج:** اذكر قائمة بالملفات التي قمت بتعديلها والحل الذي نفذته لكل مشكلة.

---

## المشاكل ذات الأولوية المطلوب إصلاحها (${prioritized.length} مشكلة):
`;

  if (prioritized.length === 0) {
    masterPrompt += `\nلم يتم العثور على أخطاء برمجية حرجة في الصفحات التي تم فحصها! الموقع يعمل بشكل متزن.\n`;
  } else {
    prioritized.forEach((f, idx) => {
      masterPrompt += `
### [${idx + 1}] ${f.title} (${f.severity.toUpperCase()})
- **الرابط المتأثر:** ${f.affectedUrl}
- **التصنيف:** ${f.category} | **درجة التأكيد:** ${f.confidence}
- **الملاحظة:** ${f.observedBehavior}
- **الشرح البسيط:** ${f.explanationAr}
${f.expectedBehavior ? `- **المطلوب:** ${f.expectedBehavior}` : ''}
${f.technicalDetails?.selector ? `- **المحدد التقني (Selector):** \`${f.technicalDetails.selector}\`` : ''}
- **طريقة الإصلاح المقترحة:** ${f.recommendedFixAr}
`;
    });
  }

  masterPrompt += `
---
*تم إنشاء هذا التقرير تلقائيًا بناءً على فحص فعلي دقيق بواسطة أداة مراجعة المواقع "مدام عفاف".*
`;

  return {
    masterPrompt: masterPrompt.trim(),
    individualPrompts
  };
}
