/**
 * Step 6: Platform-Aware Fixes & Repair Prompt Adapter
 * Generates platform-specific fix instructions keyed by platform + builder.
 * Rules:
 * - Never suggest Tailwind classes unless profile.hasTailwind === true.
 * - Never suggest overflow-x: hidden (it hides the problem instead of fixing layout).
 * - Never say "enable SSL" when the site is already served over https://.
 * - Produces two repair modes:
 *   (a) 'cms_checklist' for WordPress/Elementor/Shopify/Wix/Squarespace/Webflow
 *   (b) 'code_agent_prompt' for Next.js/React/Static HTML codebases
 */
import { Finding, SiteProfile } from '../types/contract';
import {
  DEFAULT_BUILDER_HEADERS_NOTE_AR,
  getVerifiedAiBuilderById,
} from '../knowledge/ai-builders';

export type PlatformAdapterKey =
  | 'wordpress+elementor'
  | 'wordpress'
  | 'shopify'
  | 'wix'
  | 'squarespace'
  | 'webflow'
  | 'ai_builder'
  | 'static_html'
  | 'react_next'
  | 'unknown';

export function resolvePlatformAdapterKey(
  profile?: SiteProfile | PlatformAdapterKey | string
): PlatformAdapterKey {
  if (!profile) return 'unknown';
  if (typeof profile === 'string') {
    if (profile === 'wordpress+elementor') return 'wordpress+elementor';
    if (profile === 'wordpress') return 'wordpress';
    if (profile === 'shopify') return 'shopify';
    if (profile === 'wix') return 'wix';
    if (profile === 'squarespace') return 'squarespace';
    if (profile === 'webflow') return 'webflow';
    if (profile === 'ai_builder') return 'ai_builder';
    if (profile === 'nextjs' || profile === 'spa' || profile === 'react_next') return 'react_next';
    if (profile === 'static_html') return 'static_html';
    return 'unknown';
  }
  if (!profile.platform) return 'unknown';
  if (profile.platform === 'wordpress' && profile.builder === 'elementor') {
    return 'wordpress+elementor';
  }
  if (profile.platform === 'wordpress') return 'wordpress';
  if (profile.platform === 'shopify') return 'shopify';
  if (profile.platform === 'wix') return 'wix';
  if (profile.platform === 'squarespace') return 'squarespace';
  if (profile.platform === 'webflow') return 'webflow';
  if (profile.platform === 'ai_builder') return 'ai_builder';
  if (profile.platform === 'nextjs' || profile.platform === 'spa') return 'react_next';
  if (profile.platform === 'static_html') return 'static_html';
  return 'unknown';
}

export function getPlatformLabelAr(profile?: SiteProfile): string {
  if (!profile) return 'لم نتمكن من تحديد التقنية المستخدمة';

  if (profile.platform === 'ai_builder') {
    const verifiedBuilder = getVerifiedAiBuilderById(profile.builder);
    if (verifiedBuilder) {
      return verifiedBuilder.nameAr;
    }
  }

  // Rule P2b.4: Show platform ONLY with confidence >= medium and >= 2 independent signals
  const hasAdequateSignals = Array.isArray(profile.signals) && profile.signals.length >= 2;
  const isConfidenceOk = profile.confidenceLevel === 'high' || profile.confidenceLevel === 'medium';
  if (!hasAdequateSignals || !isConfidenceOk) {
    return 'لم نتمكن من تحديد التقنية المستخدمة';
  }

  // Rule P2b.4: Never show "Static HTML" or "Server HTML" as a technology
  if (profile.platform === 'static_html' || profile.platform === 'custom' || profile.platform === 'unknown') {
    return 'لم نتمكن من تحديد التقنية المستخدمة';
  }

  const key = resolvePlatformAdapterKey(profile);
  switch (key) {
    case 'wordpress+elementor':
      return 'ووردبريس + إليمينتور (WordPress + Elementor)';
    case 'wordpress':
      return 'ووردبريس (WordPress)';
    case 'shopify':
      return 'شوبيفاي (Shopify)';
    case 'wix':
      return 'ويكس (Wix)';
    case 'squarespace':
      return 'سكوير سبيس (Squarespace)';
    case 'webflow':
      return 'ويب فلو (Webflow)';
    case 'ai_builder': {
      const verifiedBuilder = getVerifiedAiBuilderById(profile.builder);
      return verifiedBuilder ? verifiedBuilder.nameAr : 'لم نتمكن من تحديد التقنية المستخدمة';
    }
    case 'react_next':
      return 'تطبيق ويب برمجي (React / Next.js)';
    case 'static_html':
    default:
      return 'لم نتمكن من تحديد التقنية المستخدمة';
  }
}

export function getPlatformAwareFix(
  ruleId: string,
  profile?: SiteProfile | PlatformAdapterKey | string,
  options?: { isHttps?: boolean } | string
): string {
  const key = resolvePlatformAdapterKey(profile);
  const isWP = key === 'wordpress+elementor' || key === 'wordpress';
  const isElementor = key === 'wordpress+elementor';
  const siteProfileObj = typeof profile === 'object' && profile !== null ? profile : undefined;
  const hasTailwind = Boolean(siteProfileObj?.hasTailwind);
  const isHttps =
    typeof options === 'object' && options !== null ? (options.isHttps ?? true) : true;

  switch (ruleId) {
    case 'R001': {
      if (isWP) {
        return 'من لوحة تحكم ووردبريس → القوائم (Menus) أو الصفحات، صلّح الرابط المكسور أو اعمل تحويل 301 (Redirection) للصفحة البديلة الشغالة.';
      }
      return 'صلّح مسار الرابط المكسور في الكود أو ضيف تحويل 301 (Permanent Redirect) للصفحة الصحيحة.';
    }

    case 'R007': {
      if (isWP) {
        return 'تأكد إن قالب ووردبريس أو ملف header.php بيحتوي على وسم <meta name="viewport" content="width=device-width, initial-scale=1"> جوة <head>.';
      }
      return 'ضيف وسم <meta name="viewport" content="width=device-width, initial-scale=1.0"> جوة <head> عشان الصفحة تتظبط على عرض شاشة الموبايل.';
    }

    case 'R008': {
      if (isWP) {
        return 'من إعدادات إضافة السيو (Yoast SEO أو Rank Math) أو إعدادات الصفحة في ووردبريس، اكتب عنوان واضح ومميز للصفحة (SEO Title) بين 30 و60 حرف.';
      }
      if (key === 'shopify') {
        return 'من Online Store → Preferences أو إعدادات Search engine listing جوة الصفحة في شوبيفاي، اكتب Page title واضح.';
      }
      return 'ضيف وسم <title> واضح ومميز جوة <head> بيوصف محتوى الصفحة واسم البراند (بين 30 و60 حرف).';
    }

    case 'R009': {
      if (isWP) {
        return 'افتح الصفحة في ووردبريس وانزل لصندوق Yoast SEO أو Rank Math واكتب وصف جذاب وواضح (Meta Description) بين 110 و155 حرف يلخص نشاط الصفحة.';
      }
      if (key === 'shopify') {
        return 'من إعدادات Search engine listing في أسفل صفحة المنتج أو الصفحة في شوبيفاي، اكتب Meta description واضح بين 110 و155 حرف.';
      }
      if (key === 'wix' || key === 'squarespace' || key === 'webflow') {
        return 'من إعدادات SEO Settings الخاصة بالصفحة في لوحة تحكم المنصة، اكتب Meta Description واضح بين 110 و155 حرف.';
      }
      return 'ضيف وسم <meta name="description" content="..."> جوة <head> بوصف واضح ومختصر للصفحة (بين 110 و155 حرف).';
    }

    case 'RC010': {
      if (isElementor) {
        return 'من محرر Elementor اضغط على العنوان الرئيسي في أول الصفحة وغيّر HTML Tag من H2/div إلى H1 (بحيث يكون فيه H1 واحد بس في الصفحة).';
      }
      if (isWP) {
        return 'تأكد إن عنوان الصفحة الرئيسي متعلم بوسم <h1> واحد واضح في أعلى المحتوى جوة محرر ووردبريس.';
      }
      return 'خلي العنوان الرئيسي للصفحة جوه وسم <h1> واحد واضح يعبّر عن موضوع الصفحة الأساسي.';
    }

    case 'R010': {
      if (key === 'ai_builder') {
        const verifiedBuilder = getVerifiedAiBuilderById(siteProfileObj?.builder);
        return verifiedBuilder?.headersNoteAr || DEFAULT_BUILDER_HEADERS_NOTE_AR;
      }
      const httpsPrefix = isHttps
        ? ''
        : 'أولاً فعّل شهادة HTTPS على الدومين، ثم ';
      if (isWP) {
        return `${httpsPrefix}من إعدادات الاستضافة (Cloudflare أو ملف .htaccess في ووردبريس) ضيف هيدرز الحماية: Strict-Transport-Security و X-Content-Type-Options: nosniff و X-Frame-Options: SAMEORIGIN.`;
      }
      if (key === 'shopify' || key === 'wix' || key === 'squarespace' || key === 'webflow') {
        return `${httpsPrefix}راجع إعدادات الدومين وCloudflare أمام المنصة لتفعيل HSTS وهيدرز حماية المتصفح القياسية.`;
      }
      return `${httpsPrefix}ضيف هيدرز Strict-Transport-Security و X-Content-Type-Options: nosniff في إعدادات السيرفر أو Vercel/Cloudflare headers.`;
    }

    case 'R005': {
      if (isElementor) {
        return 'من محرر Elementor افتح وضع الموبايل (Responsive Mode) على الحاوية العريضة، وغيّر الـ Width من قيمة ثابتة بالبيكسل (px) إلى 100% أو استعمل max-width: 100% في Elementor → Site Settings → Custom CSS.';
      }
      if (isWP) {
        return 'من مظهر ووردبريس → تخصيص → تنسيقات CSS إضافية، استبدل العرض الثابت بالبيكسل بـ width: 100%; max-width: 100%; مع box-sizing: border-box.';
      }
      if (hasTailwind) {
        return 'استبدل العرض الثابت بالبيكسل بكلاسات مرنة مثل w-full و max-w-full عشان العنصر يتجاوب مع شاشة الموبايل 390px.';
      }
      return 'استبدل العرض الثابت (width: ...px) بـ width: 100%; max-width: 100%; و box-sizing: border-box عشان ميعملش سكرول أفقي على الموبايل.';
    }

    case 'R011': {
      if (isElementor) {
        return 'في إعدادات الفورم جوه Elementor فعّل إظهار الـ Label لكل حقل، أو ضيف اسم واضح في خانة Label بدل الاعتماد على الـ Placeholder لوحده.';
      }
      if (isWP) {
        return 'في إعدادات إضافة الفورم (Contact Form 7 / WPForms)، اربط كل خانة إدخال بوسم <label> واضح أو خاصية aria-label.';
      }
      return 'اربط كل خانة إدخال في الفورم بوسم <label for="..."> ثابت وواضح أو ضيف خاصية aria-label توصف وظيفة الحقل.';
    }

    case 'R012': {
      if (isWP) {
        return 'افتح مكتبة الوسائط (Media Library) في ووردبريس أو إعدادات الصورة جوة Elementor واكتب وصف حقيقي ومميز لكل صورة في خانة "النص البديل (Alt Text)".';
      }
      if (key === 'shopify') {
        return 'من Products أو Online Store → Themes في شوبيفاي، اضغط على كل صورة واكتب وصف واضح في خانة Edit alt text.';
      }
      return 'ضيف خاصية alt="وصف دقيق للصورة" على كل وسم <img> بيعرض محتوى مهم للزائر.';
    }

    case 'RC005': {
      if (isWP) {
        return 'عندك إضافة سيو أو قالب بيكرر اسم الموقع كـ Alt Text لكل الصور تلقائياً. ادخل مكتبة الوسائط (Media Library) أو إعدادات الصور في Elementor واكتب وصف حقيقي لكل منتج أو صورة بدل التكرار.';
      }
      return 'غيّر نصوص alt المتكررة على الصور بحيث كل صورة توصف محتواها الفعلي (اسم المنتج أو المرحلة) بدل تكرار نفس الجملة.';
    }

    case 'R013': {
      if (isWP) {
        return 'في Elementor حط صورة غلاف (Poster) لأي فيديو في أول الصفحة مع ضبط preload="metadata"، وحوّل الصور الكبيرة لصيغة WebP.';
      }
      return 'حط خاصية poster="..." و preload="metadata" للفيديو، واضغط الصور الكبيرة لصيغة WebP مع تفعيل loading="lazy" للصور تحت أول شاشة.';
    }

    case 'R023_TTFB':
    case 'PSI_LCP':
    case 'PSI_CLS':
    case 'PSI_TBT':
    case 'PSI_SCORE': {
      if (isWP) {
        return 'فعّل إضافة كاش قوية في ووردبريس (مثل WP Rocket أو LiteSpeed Cache)، واضغط صور أول شاشة لصيغة WebP، وقلل الإضافات والـ Scripts غير الضرورية.';
      }
      return 'فعّل الكاش على السيرفر/CDN، واضغط صور أول شاشة لصيغة WebP مع تحديد أبعاد width/height صريحة، وقلل ملفات JavaScript الثقيلة في بداية التحميل.';
    }

    case 'R003_LANG': {
      if (isWP) {
        return 'زرار تغيير اللغة (EN) واخد علامة (#) ومش مربوط بصفحة. لو النسخة الإنجليزي لسه مخلصتش، اخفيه مؤقتاً من القايمة (المظهر → قوائم) أو اربطه برابط الصفحة الإنجليزية الفعلي في WPML / Polylang.';
      }
      return 'اربط زرار اللغة برابط النسخة الإنجليزية الفعلي، أو اخفيه لحد ما تجهز الترجمة عشان الزائر ميدوسش على رابط فاضي.';
    }

    case 'R003_SOCIAL': {
      if (isWP) {
        return 'افتح الهيدر أو الفوتر في Elementor وحط روابط صفحات السوشيال ميديا الحقيقية بدل علامة (#)، أو امسح الأيقونات اللي ملهاش حساب شغال.';
      }
      return 'حط روابط حسابات السوشيال ميديا الفعلية في href بدل علامة (#) أو اخفي الأيقونات غير المستخدمة.';
    }

    case 'R003': {
      if (isWP) {
        return 'راجع القوائم والأزرار في ووردبريس/Elementor وحط الروابط الحقيقية للصفحات بدل علامة (#).';
      }
      return 'استبدل href="#" برابط الصفحة الفعلي أو استخدم عنصر <button type="button"> لو الزرار بيفتح نافذة تفاعلية.';
    }

    case 'RC001': {
      return 'وحّد كتابة اسم العلامة التجارية بنفس الحروف والهمزات في عنوان الموقع (Title) واللوجو والفوتر والمتن عشان تقوي الهوية والسيو.';
    }

    case 'RC002': {
      return 'لو ده إيميل الشركة الرسمي على دومين شقيق تمام، أما لو منسي من قالب قديم عدّله لإيميل رسمي على نفس دومين الموقع.';
    }

    case 'RC004': {
      if (isWP) {
        return 'من ووردبريس → أعضاء → حسابك الشخصي، غيّر "الاسم المعروض علناً" من admin لاسم الشركة الرسمي عشان ميظهرش في معاينة الروابط ومحركات البحث.';
      }
      return 'امسح القيم الافتراضية المنسيه (مثل اسم الكاتب admin أو النصوص التجريبية) وحط اسم الشركة الرسمي.';
    }

    case 'RC006':
    case 'RC007': {
      if (isWP) {
        return 'من إعدادات الحماية في ووردبريس (Wordfence أو .htaccess) اقفل استعراض قائمة المستخدمين العامة عبر /wp-json/wp/v2/users وملف xmlrpc.php لو مش بتستخدمه.';
      }
      return 'اقفل نقطة الـ API العامة أو ملف الإعدادات المكشوف من إعدادات السيرفر عشان تمنع جمع بيانات الحسابات.';
    }

    case 'RC008': {
      if (isElementor || isWP) {
        return 'في الهيدر أو أول بانر (Hero Section) في Elementor، ضيف زرار واضح ومباشر للتواصل (واتساب / اتصال / طلب عرض سعر) عشان الزائر ميضطرش ينزل لآخر الصفحة.';
      }
      return 'ضيف زرار تواصل أو إجراء واضح (CTA) في الهيدر أو أول شاشة يظهر للزائر أول ما يفتح الموقع.';
    }

    case 'RC009': {
      if (isWP) {
        return 'بما إن الموقع بيتكلم عن التصدير أو الأسواق الدولية، جهّز صفحة أو نسخة إنجليزية شغالة (مثلاً عبر Polylang أو WPML) واربطها بزرار لغة شغال في الهيدر.';
      }
      return 'ضيف نسخة أو صفحة تعريفية باللغة الإنجليزية لعملاء التصدير واربطها بوسم hreflang وزرار لغة شغال في الهيدر.';
    }

    default:
      return typeof options === 'string' && options.trim()
        ? options.trim()
        : 'راجع العنصر المذكور في الدليل وطبق التعديل المناسب لمنصة موقعك.';
  }
}

export function buildPlatformAwareRepairPack(params: {
  requestedUrl?: string;
  url?: string;
  purpose?: string;
  keyJourney?: string;
  profile?: SiteProfile;
  findings: Finding[];
  toolOverride?: string;
}): {
  repairMode: 'cms_checklist' | 'code_agent_prompt';
  masterPrompt: string;
  aiRepairPrompt: string;
  cmsChecklistItems: string[];
  individualPrompts: Record<string, string>;
} {
  const { purpose, keyJourney, profile, findings, toolOverride } = params;
  const requestedUrl = params.requestedUrl || params.url || '';
  const key = resolvePlatformAdapterKey(profile);
  const isCms =
    !toolOverride &&
    (key === 'wordpress+elementor' ||
      key === 'wordpress' ||
      key === 'shopify' ||
      key === 'wix' ||
      key === 'squarespace' ||
      key === 'webflow');

  const repairMode: 'cms_checklist' | 'code_agent_prompt' = isCms
    ? 'cms_checklist'
    : 'code_agent_prompt';

  const cmsChecklistItems = findings.map(
    (f, idx) =>
      `${idx + 1}. [${f.ruleId}] ${f.titleAr || f.title}: ${f.recommendedFix}`
  );

  const individualPrompts: Record<string, string> = {};
  for (const f of findings) {
    const firstEv = f.evidence?.[0]?.value || f.evidence?.[0]?.ref || '';
    individualPrompts[f.id] = isCms
      ? `خطوة إصلاح [${f.ruleId}] (${getPlatformLabelAr(profile)}):\nالمشكلة: ${f.titleAr || f.title}\nالدليل: ${firstEv}\nالحل خطوة بخطوة: ${f.recommendedFix}`
      : `## Targeted Defect Repair Prompt\nTarget: ${f.url} | Rule: [${f.ruleId}] ${f.title} (${f.severity.toUpperCase()} / ${f.category})\nObserved: ${f.observed}\nEvidence: ${firstEv}\nFix: ${f.recommendedFix}\nGuidelines: Inspect first, apply minimal targeted changes, never use overflow-x: hidden to mask layout issues${profile?.hasTailwind ? '' : ', do not use Tailwind classes unless already configured'}.`;
  }

  if (isCms) {
    const platformName = getPlatformLabelAr(profile);
    let masterPrompt = `# خطة إصلاح موقع (${requestedUrl}) — مخصصة لمنصة ${platformName}\nالموقع مبني على ${platformName}\n\n`;
    masterPrompt += `## خطوات تنفيذية مباشرة (بدون تعديل كود برمجي خارجي):\n`;
    masterPrompt += `- لو ملاحظة مش مناسبة للمنصة قول ليه بدل ما تفرضها.\n\n`;
    if (findings.length === 0) {
      masterPrompt += `- لا توجد مشاكل حرجة مرصودة.\n`;
    } else {
      findings.slice(0, 10).forEach((f, idx) => {
        const ev = f.evidence?.[0]?.value || f.evidence?.[0]?.ref || '';
        const loc = f.where?.sectionAr || f.location || f.url;
        const acceptance = f.expected || f.steps?.[0] || 'التحقق من زوال المشكلة بعد النشر.';
        masterPrompt += `${idx + 1}. **${f.titleAr || f.title}** [${f.ruleId} · ${f.severity.toUpperCase()}]\n`;
        masterPrompt += `   - المكان: ${loc}\n`;
        masterPrompt += `   - اللي شفته: ${f.observed}\n`;
        if (ev) masterPrompt += `   - الدليل: \`${ev.slice(0, 120)}\`\n`;
        masterPrompt += `   - خطوة الحل على ${platformName}: ${f.recommendedFix}\n`;
        masterPrompt += `   - معيار القبول: ${acceptance}\n\n`;
      });
    }
    masterPrompt += `## CSS مساعد اختياري (يوضع في Custom CSS عند الحاجة لتحسين تجاوب الصور والفيديو):\n`;
    masterPrompt += `\`\`\`css\nimg, video, iframe {\n  max-width: 100%;\n  height: auto;\n}\n\`\`\`\n\n## الخطوة التالية:\nلما تخلص: انشر التعديلات واكتب إيه اللي اتغير.\nأعد الاختبار واكتب إيه اللي اتغير.\n`;

    const trimmed = masterPrompt.trim();
    return {
      repairMode,
      masterPrompt: trimmed,
      aiRepairPrompt: trimmed,
      cmsChecklistItems,
      individualPrompts
    };
  }

  // Code repo / AI builder agent prompt mode
  const confirmedFindings = findings.filter(
    f => f.confidence === 'confirmed' || f.kind === 'confirmed_defect'
  );
  const suspectedFindings = findings.filter(
    f => f.confidence !== 'confirmed' && f.kind !== 'confirmed_defect'
  );

  const verifiedBuilder =
    profile?.platform === 'ai_builder'
      ? getVerifiedAiBuilderById(profile.builder)
      : undefined;
  const cleanToolOverride =
    toolOverride && toolOverride.trim() && toolOverride.trim() !== 'مش عارف'
      ? toolOverride.trim()
      : undefined;
  const toolName = cleanToolOverride || verifiedBuilder?.nameEn;
  const isBuilderHosted = Boolean(verifiedBuilder || cleanToolOverride);

  const stackOrToolLine = toolName
    ? `Tool: ${toolName}\nالموقع مبني على ${toolName}`
    : `Stack: ${getPlatformLabelAr(profile)}\nالموقع مبني على ${getPlatformLabelAr(profile)}`;

  let masterPrompt = `# Website Defect Repair Plan (Token-Optimized)
Target: ${requestedUrl}${purpose ? ` | Purpose: ${purpose}` : ''}${keyJourney ? ` | Journey: ${keyJourney}` : ''}
${stackOrToolLine}

## Mandatory Engineering Guidelines
- Inspect first; apply Minimal Targeted Changes only.
- Keep the existing design, layout, styling, and all unrelated features and functions intact.
- Preserve existing framework, routes, design system, and dependencies without adding unnecessary packages.
- لو ملاحظة مش مناسبة للمنصة قول ليه بدل ما تفرضها.
- Never use \`overflow-x: hidden\` to hide responsive layout bugs; fix the fixed-width container itself.${
    profile?.hasTailwind
      ? ''
      : '\n- Do NOT suggest or inject Tailwind CSS classes (Tailwind was not detected on this target).'
  }

## المشاكل المؤكدة (Prioritized Confirmed Findings - ${Math.min(confirmedFindings.length, 8)}):
`;

  if (confirmedFindings.length === 0) {
    masterPrompt += `\nNo high-severity confirmed defects detected.\n`;
  } else {
    confirmedFindings.slice(0, 8).forEach((f, idx) => {
      const ev = f.evidence?.[0]?.value || f.evidence?.[0]?.ref || '';
      const evidenceRef = ev ? ` | Evidence: \`${ev.slice(0, 90)}\`` : '';
      const loc = f.where?.sectionAr || f.location || f.url;
      const acceptance =
        f.expected ||
        f.steps?.[0] ||
        'التحقق من زوال المشكلة في الصفحة المنشورة بدون التأثير على باقي العناصر.';
      const fixText = isBuilderHosted
        ? (f.recommendedFix || '').replace(/cPanel|\.htaccess/gi, 'إعدادات المنصة')
        : f.recommendedFix;
      masterPrompt += `
${idx + 1}. [${f.severity.toUpperCase()}/${f.confidence.toUpperCase()}] ${f.title} (${f.ruleId} · ${f.category})
   - URL: ${f.url} (x${f.occurrences}) | Location: ${loc}
   - Issue: ${f.observed}${evidenceRef}
   - Fix: ${fixText}
   - معيار القبول (Acceptance): ${acceptance}`;
    });
  }

  if (suspectedFindings.length > 0) {
    masterPrompt += `\n\n## محتاج تحقق (Needs Verification - ${Math.min(suspectedFindings.length, 5)}):\n`;
    suspectedFindings.slice(0, 5).forEach((f, idx) => {
      masterPrompt += `
${idx + 1}. [${f.severity.toUpperCase()}/${f.confidence.toUpperCase()}] ${f.titleAr || f.title} (${f.ruleId})
   - Issue: ${f.observed}
   - Suggested verification: ${f.steps?.[0] || f.recommendedFix}`;
    });
  }

  masterPrompt += `\n\n## الخطوة التالية:\nلما تخلص: انشر التعديلات واكتب إيه اللي اتغير.\nأعد الاختبار واكتب إيه اللي اتغير.\n`;

  const trimmed = masterPrompt.trim();
  return {
    repairMode,
    masterPrompt: trimmed,
    aiRepairPrompt: trimmed,
    cmsChecklistItems,
    individualPrompts
  };
}
