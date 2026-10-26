/**
 * Section 6.1: Site Status Detection (Decided before any normal check)
 * If the state is not 'ok', normal checks STOP and a Status Report is returned
 * in plain Egyptian Arabic (what I saw, what it means, what to do, evidence).
 */
import { SiteStatusReport } from '../types/contract';
import { BOT_USER_AGENT } from '../config/limits.server';
import { getRegistrableDomain } from './domain-parser';
import { stripTagsToVisibleText } from './site-profiler';


export interface SiteStatusInput {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Headers | Record<string, string> | null;
  html: string;
  errorReasonAr?: string;
}

function readHeader(
  headers: Headers | Record<string, string> | null,
  name: string
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) || (headers as Headers).get(lower);
  }
  const rec = headers as Record<string, string>;
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

export function detectSiteStatus(input: SiteStatusInput): SiteStatusReport {
  const { requestedUrl, finalUrl, status, headers, html, errorReasonAr } = input;

  // 1. Check redirected_elsewhere first if a finalUrl was reached
  const requestedDomain = getRegistrableDomain(requestedUrl);
  const finalDomain = finalUrl ? getRegistrableDomain(finalUrl) : requestedDomain;
  if (
    requestedDomain &&
    finalDomain &&
    requestedDomain !== finalDomain &&
    requestedDomain !== 'localhost' &&
    finalDomain !== 'localhost'
  ) {
    return {
      state: 'redirected_elsewhere',
      redirectedToDomain: finalDomain,
      whatISawAr: `الموقع عمل تحويل تلقائي لدومين تاني مختلف: ${finalDomain}`,
      whatItMeansAr:
        'الرابط اللي كتبته بيودّي الزائر على نطاق تاني خالص غير النطاق الأصلي، وعشان قواعد الأمان مش هفحص الدومين الجديد تحت اسم القديم.',
      whatToDoAr: `لو الدومين الجديد (${finalDomain}) هو موقعك الفعلي، اكتبه من الأول وابدأ فحص جديد عليه مباشرة.`,
      evidence: [
        {
          type: 'header',
          value: `Redirected from ${requestedDomain} (${requestedUrl}) to ${finalDomain} (${finalUrl})`,
          ref: `Redirected from ${requestedDomain} to ${finalDomain}`
        }
      ]
    };
  }

  // 2. Network / DNS / TLS / Timeout failure (status === 0)
  if (status === 0) {
    return {
      state: 'unreachable',
      whatISawAr: `ما قدرتش أفتح الموقع من السيرفر. ده اللي شفته: ${
        errorReasonAr || 'فشل الاتصال أو انتهت مهلة الرد (Timeout / DNS / TLS).'
      }`,
      whatItMeansAr:
        'مش شرط معناه إن الموقع واقع عند كل الناس؛ ممكن يكون السيرفر متأخر في الرد، أو فيه مشكلة في شهادة الأمان (SSL/TLS)، أو إعدادات الـ DNS لسه مسمّعتش.',
      whatToDoAr:
        'اتأكد إن اسم الدومين مكتوب صح وإن شهادة الـ HTTPS شغالة، وجرب تفتح الموقع من متصفح خفي أو اسأل شركة الاستضافة.',
      evidence: [
        {
          type: 'header',
          value: `HTTP status: 0 | Error: ${errorReasonAr || 'Connection / DNS / TLS failure'}`,
          ref: errorReasonAr || 'Connection failure'
        }
      ]
    };
  }

  const contentType = (readHeader(headers, 'content-type') || '').toLowerCase();
  const retryAfter = readHeader(headers, 'retry-after');
  const serverHeader = readHeader(headers, 'server') || '';

  // 3. Auth wall: HTTP 401 or redirect to login path / consent interstitial
  let finalPathname = '';
  let finalHostname = '';
  try {
    const parsedFinal = new URL(finalUrl || requestedUrl);
    finalPathname = parsedFinal.pathname.toLowerCase();
    finalHostname = parsedFinal.hostname.toLowerCase();
  } catch {
    finalPathname = '';
    finalHostname = '';
  }

  if (
    status === 401 ||
    /\/(wp-login\.php|login|signin|sign-in|auth\/login|accounts\/login|servicelogin|session\/new)(\/|$)/i.test(finalPathname)
  ) {
    return {
      state: 'auth_wall',
      whatISawAr: `الموقع طلب تسجيل دخول الأول قبل ما يعرض الصفحة (HTTP ${status} — ${finalPathname || finalUrl}).`,
      whatItMeansAr:
        'الصفحة دي مقفولة بكلمة سر أو حساب مستخدم، وأنا بفحص الصفحات العامة بس من غير ما أدخل بيانات دخول.',
      whatToDoAr:
        'افحص رابط صفحة عامة مفتوحة للزوار، أو افتح الموقع للجمهور مؤقتاً وقت المراجعة.',
      evidence: [
        {
          type: 'header',
          value: `HTTP ${status} | Final URL: ${finalUrl}`,
          ref: `HTTP ${status} (${finalUrl})`
        }
      ]
    };
  }

  // 4. Non-HTML content type on 2xx
  if (
    contentType &&
    !contentType.includes('text/html') &&
    !contentType.includes('application/xhtml+xml')
  ) {
    return {
      state: 'non_html',
      whatISawAr: `الرابط ده رجّع ملف مش صفحة ويب (نوع الملف: ${contentType}).`,
      whatItMeansAr:
        'المراجعة مصممة لصفحات المواقع (HTML)، لكن الرابط ده بيشاور على ملف مباشر (زي PDF أو JSON أو صورة).',
      whatToDoAr: 'حط رابط الصفحة الرئيسية للموقع بدل رابط الملف المباشر.',
      evidence: [
        {
          type: 'header',
          value: `Content-Type: ${contentType}`,
          ref: `Content-Type: ${contentType}`
        }
      ]
    };
  }

  // Parse HTML safely for status markers
  const safeHtml = html || '';
  const titleMatch = safeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  const visibleText = stripTagsToVisibleText(safeHtml);
  const rawLower = safeHtml.toLowerCase();
  const combinedText = `${titleText} ${visibleText}`.toLowerCase();

  // 4b. Consent wall interstitial (e.g. consent.youtube.com / Before you continue)
  const isConsentInterstitial =
    finalHostname.startsWith('consent.') ||
    ((combinedText.includes('before you continue to') ||
      combinedText.includes('قبل المتابعة إلى')) &&
      visibleText.length < 1500);

  if (isConsentInterstitial) {
    return {
      state: 'blocked_by_protection',
      whatISawAr: `الموقع حوّل الفحص لصفحة موافقة إجبارية على ملفات الارتباط (Consent Wall — ${finalHostname || finalUrl}).`,
      whatItMeansAr:
        'السيرفر عرض شاشة موافقة مسبقة قبل الدخول للموقع الفعلي، فالكود المعروض هنا مش هو محتوى الموقع الحقيقي.',
      whatToDoAr:
        'دي بوابة موافقة تلقائية خاصة بالمنصة ومش عيب في موقعك.',
      evidence: [
        {
          type: 'header',
          value: `HTTP ${status} | Final URL: ${finalUrl} | Title: "${titleText}"`,
          ref: `Consent interstitial (${finalHostname || finalUrl})`
        }
      ]
    };
  }

  // 5. Blocked by protection (WAF / Cloudflare / Captcha / Bot protection)
  const protectionMarkers = [
    'just a moment...',
    'checking your browser',
    'attention required! | cloudflare',
    'cf-browser-verification',
    'cf-chl-bypass',
    'please enable cookies',
    'verify you are human',
    'are you a robot',
    'robot or human',
    'enter the characters you see below',
    'unusual traffic from your computer network',
    'ddos-guard',
    'sucuri website firewall',
    'access denied'
  ];
  const matchedProtection = protectionMarkers.find(
    m => combinedText.includes(m) || rawLower.includes(m)
  );

  if (
    ((status === 403 || status === 429 || status === 503) &&
      (matchedProtection || /cloudflare|sucuri|ddos-guard|akamai/i.test(serverHeader))) ||
    (matchedProtection && visibleText.length < 800)
  ) {
    return {
      state: 'blocked_by_protection',
      whatISawAr: `نظام الحماية على الموقع (Firewall / Bot Protection) وقف الفحص التلقائي (كود HTTP ${status}). مش معناها إن الموقع واقع.`,
      whatItMeansAr:
        'الموقع عليه جدار حماية (زي Cloudflare أو غيره) بيمنع أدوات الفحص الآلية تدخل الصفحة وتقرأ الكود.',
      whatToDoAr:
        `لو الموقع بتاعك، تقدر تسمح مؤقتاً بـ User-Agent: ${BOT_USER_AGENT} في إعدادات الحماية، أو تقلل مستوى Bot Fight Mode وقت الفحص.`,

      evidence: [
        {
          type: 'header',
          value: `HTTP ${status} | Server: ${serverHeader || 'unknown'} | Marker: ${
            matchedProtection || 'WAF challenge'
          } | Title: "${titleText}"`,
          ref: `HTTP ${status} (${matchedProtection || serverHeader})`
        }
      ]
    };
  }

  // 6. Parked or default server page
  const parkedMarkers = [
    'default web site page',
    'welcome to nginx',
    'index of /',
    'account suspended',
    'domain for sale',
    'this domain is for sale',
    'apache2 ubuntu default page',
    'apache2 debian default page',
    'cgi-sys/defaultwebpage.cgi',
    'parked free, courtesy of'
  ];
  const matchedParked = parkedMarkers.find(
    m => combinedText.includes(m) || rawLower.includes(m)
  );
  if (matchedParked && visibleText.length < 1500) {
    return {
      state: 'parked_or_default_page',
      whatISawAr: `الموقع بيعرض صفحة سيرفر افتراضية أو الدومين مركون: "${matchedParked}".`,
      whatItMeansAr:
        'الدومين مربوط بالسيرفر لكن ملفات الموقع الفعلي لسه ما اترفعتش أو الحساب موقوف مؤقتاً.',
      whatToDoAr:
        'ارفع ملفات الموقع في المجلد الرئيسي للاستضافة (public_html) أو راجع شركة الاستضافة لو الصفحة مكتوب فيها Account Suspended.',
      evidence: [
        {
          type: 'snippet',
          value: `Matched default/parked page marker: "${matchedParked}" | Title: "${titleText}"`,
          ref: matchedParked
        }
      ]
    };
  }

  // 7. Maintenance or Coming Soon
  const maintenancePhrases = [
    'تحت الصيانة',
    'قريباً',
    'قريبا',
    'قيد الإنشاء',
    'الموقع تحت الإنشاء',
    'سنعود قريباً',
    'maintenance mode',
    'under maintenance',
    'coming soon',
    'under construction',
    'briefly unavailable for scheduled maintenance'
  ];
  const matchedPhrase = maintenancePhrases.find(p =>
    combinedText.includes(p.toLowerCase())
  );
  const pluginMarkers = [
    'wp-maintenance-mode',
    'seedprod',
    'cmp-coming-soon',
    'under-construction-page',
    'wpmm-',
    'elementor-maintenance-mode'
  ];
  const matchedPlugin = pluginMarkers.find(m => rawLower.includes(m));
  const robotsMatch =
    safeHtml.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    safeHtml.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["'][^>]*>/i);
  const robotsMeta = (robotsMatch ? robotsMatch[1] : '').toLowerCase();
  const hasNoindex = robotsMeta.includes('noindex');
  const navBlocks = Array.from(
    safeHtml.matchAll(/<(nav|header)\b[^>]*>([\s\S]*?)<\/\1>/gi)
  ).map(m => m[2] || '');
  let navLinksCount = 0;
  for (const block of navBlocks) {
    const links = block.match(/<a\b[^>]*href=/gi);
    if (links) navLinksCount += links.length;
  }
  const headingMatches = safeHtml.match(/<h[12]\b[^>]*>/gi);
  const headingsCount = headingMatches ? headingMatches.length : 0;
  const isSparseSingleHeading =
    visibleText.length < 300 && headingsCount <= 2 && navLinksCount === 0;

  let maintenanceSignals: string[] = [];
  if (matchedPhrase) maintenanceSignals.push(`Phrase: "${matchedPhrase}"`);
  if (matchedPlugin) maintenanceSignals.push(`Plugin/Template marker: "${matchedPlugin}"`);
  if (hasNoindex) maintenanceSignals.push('meta robots="noindex"');
  if (isSparseSingleHeading) {
    maintenanceSignals.push(
      `Sparse text (${visibleText.length} chars), headings=${headingsCount}, navLinks=0`
    );
  }

  if (
    (status === 503 && (matchedPhrase || matchedPlugin || retryAfter)) ||
    maintenanceSignals.length >= 2
  ) {
    return {
      state: 'maintenance_or_coming_soon',
      whatISawAr: `الموقع حاليًا في وضع الصيانة أو "قريبًا" (Coming Soon).`,
      whatItMeansAr:
        'الصفحة المعروضة للزوار هي شاشة انتظار مؤقتة مش الموقع الكامل، فالحكم على السيو والمحتوى دلوقتي مش هيكون حقيقي.',
      whatToDoAr:
        'أول ما تفتح الموقع للزوار وتطفي وضع الصيانة (Maintenance Mode)، ابعتلي اللينك تاني أراجعه بالكامل.',
      evidence: [
        {
          type: 'snippet',
          value: `HTTP ${status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''} | Signals: ${maintenanceSignals.join(' + ')}`,
          ref: maintenanceSignals.join(' + ')
        }
      ]
    };
  }

  // 8. HTTP 403 / 429 without explicit WAF text is still blocked / rate-limited, never 'ok'
  if (status === 403 || status === 429) {
    return {
      state: 'blocked_by_protection',
      whatISawAr: `السيرفر رفض الفحص التلقائي بكود HTTP ${status}. مش معناها إن الموقع واقع.`,
      whatItMeansAr:
        'السيرفر أو جدار الحماية مانع طلبات الفحص الآلية أو حدد عدد الطلبات المسموحة.',
      whatToDoAr: `لو الموقع بتاعك، اسمح بـ User-Agent: ${BOT_USER_AGENT} في إعدادات السيرفر أو الحماية وجرب تاني.`,
      evidence: [
        {
          type: 'header',
          value: `HTTP ${status} on ${finalUrl || requestedUrl}`,
          ref: `HTTP ${status}`
        }
      ]
    };
  }

  // 9. Any other HTTP >= 400 (4xx or 5xx) on homepage is never 'ok'
  if (status >= 400) {
    return {
      state: 'unreachable',
      whatISawAr: `السيرفر رد بكود خطأ HTTP ${status} على الصفحة الرئيسية.`,
      whatItMeansAr:
        status === 404 || status === 410
          ? `الرابط اللي بعتّه مش موجود (${status}).`
          : status >= 500
          ? 'السيرفر بتاع الموقع فيه عطل داخلي حالياً ومش قادر يطلع الصفحة.'
          : `السيرفر رجّع كود خطأ HTTP ${status} ومنع عرض الصفحة بشكل طبيعي.`,
      whatToDoAr:
        status === 404 || status === 410
          ? 'اتأكد من مسار الرابط الصحيح للصفحة الرئيسية وجرب تاني.'
          : 'راجع سجل أخطاء السيرفر (Error Logs) أو إعدادات الاستضافة.',
      evidence: [
        {
          type: 'header',
          value: `HTTP ${status} on ${finalUrl || requestedUrl}`,
          ref: `HTTP ${status}`
        }
      ]
    };
  }

  // 10. Empty HTML body on 2xx/3xx -> empty_response (never 'ok')
  if (safeHtml.trim().length <= 20) {
    return {
      state: 'empty_response',
      whatISawAr: `السيرفر رد بكود HTTP ${status} لكن محتوى الصفحة فاضي تماماً.`,
      whatItMeansAr:
        'السيرفر استجاب للطلب بس مبعتش كود HTML كافي يتفحص (صفحة بيضا أو رد فاضي).',
      whatToDoAr:
        'افتح الرابط في المتصفح واتأكد إن السيرفر بيرجع كود الصفحة كامل ومفيش خطأ صامت في الباك إند.',
      evidence: [
        {
          type: 'header',
          value: `HTTP ${status} | Body length: ${safeHtml.trim().length} chars`,
          ref: `HTTP ${status} (empty body)`
        }
      ]
    };
  }

  return {
    state: 'ok',
    whatISawAr: 'الموقع فتح معايا بشكل طبيعي واستجاب بصفحة HTML.',
    whatItMeansAr: 'تقدر تعتمد على الفحص ده.',
    whatToDoAr: 'راجع تفاصيل التقرير تحت.',
    evidence: [
      {
        type: 'header',
        value: `HTTP ${status} on ${finalUrl || requestedUrl}`,
        ref: `HTTP ${status}`
      }
    ]
  };
}
