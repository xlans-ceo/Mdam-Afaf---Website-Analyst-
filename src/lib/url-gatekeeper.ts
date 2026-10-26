import { ChatContext, ChatMessage, NO_SITE_SCANNED_PROMPT } from './chat-context';
import { getRegistrableDomain } from './domain-parser';
import {
  extractChatUrl,
  extractUrlFromMessage,
  stripSurroundingPunctuation,
  validateAndNormalizeCandidateUrl
} from './chat-url-extractor';

export { extractChatUrl, extractUrlFromMessage };

export interface GatekeeperDecision {
  action: 'needs_url' | 'trigger_scan' | 'allow_chat';
  targetUrl?: string;
  replyAr?: string;
}

const NEEDS_URL_RESPONSES = [NO_SITE_SCANNED_PROMPT];

const QUESTION_OR_SERVICE_KEYWORDS = [
  'خدم',
  'شغل',
  'بتعمل',
  'بتقدم',
  'إزاي',
  'ازاي',
  'كيف',
  'ضفت',
  'أضيف',
  'اضيف',
  'أحط',
  'احط',
  'أفحص',
  'افحص',
  'تطوير',
  'برمج',
  'موقع',
  'مواقع',
  'متجر',
  'متاجر',
  'سيو',
  'seo',
  'سرع',
  'أداء',
  'lcp',
  'cls',
  'tbt',
  'جوجل',
  'شرك',
  'مصنع',
  'مصانع',
  'تصدير',
  'b2b',
  'أتمتة',
  'اتمتة',
  'ذكاء',
  'شات بوت',
  'chatbot',
  'سعر',
  'أسعار',
  'اسعار',
  'تكلف',
  'باقات',
  'تواصل',
  'واتس',
  'تليفون',
  'رقم',
  'محمد سلطان',
  'سلطان',
  'تعديل',
  'تصميم',
  'ووردبريس',
  'شوبيفاي',
  'ريأكت',
  'تطبيق',
  'مشروع',
  'استشار',
  'مراجع',
  'مين مدام',
  'مين انت',
  'عرفيني',
  'مساعد'
];

export function isServiceOrTechnicalQuestion(rawMessage: string): boolean {
  const lower = (rawMessage || '').toLowerCase().trim();
  if (!lower) return false;
  return QUESTION_OR_SERVICE_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Normalizes a user's URL input whether they typed "example.com", "www.example.com",
 * or "https://example.com". Returns null if empty or not a valid domain/URL.
 */
export function normalizeUserDomainOrUrl(rawInput: string): string | null {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const cleaned = stripSurroundingPunctuation(rawInput);
  if (!cleaned) return null;

  const extracted = extractUrlFromMessage(cleaned);
  if (extracted) return extracted;

  const hasExplicitProtocol = /^https?:\/\//i.test(cleaned);
  const withProtocol = hasExplicitProtocol ? cleaned : `https://${cleaned}`;
  return validateAndNormalizeCandidateUrl(withProtocol, hasExplicitProtocol);
}

export function validateAndNormalizeUrl(rawInput: string): {
  ok: boolean;
  normalizedUrl?: string;
  registrableDomain?: string;
  errorAr?: string;
} {
  const normalizedUrl = normalizeUserDomainOrUrl(rawInput);
  if (!normalizedUrl) {
    return {
      ok: false,
      errorAr: 'حط اسم موقع صحيح (مثلاً example.com أو https://example.com) عشان نبدأ الفحص.'
    };
  }
  const registrableDomain = getRegistrableDomain(normalizedUrl);
  if (!registrableDomain) {
    return {
      ok: false,
      errorAr: 'النطاق غير صالح للفحص.'
    };
  }
  return {
    ok: true,
    normalizedUrl,
    registrableDomain
  };
}

/**
 * Enforces Madam Afaf's chat routing rule:
 * - If the user message contains a new URL, trigger a live scan first.
 * - If a website is already scanned (`context` has domain/url), allow chat grounded in that scan report.
 * - If no website is scanned yet (`!hasScannedSite`):
 *   - On the very first interaction only (when no prior assistant reply/guidance was given AND the user
 *     is only sending a general greeting rather than asking about services/SEO/development/how-to),
 *     return the one-time guidance message (`needs_url`).
 *   - After the first interaction OR whenever the user asks about services, Madam Afaf's work,
 *     how to add a site, web development, e-commerce, SEO, or programming, return `allow_chat`
 *     so Gemini API responds naturally without repeating the static message.
 */
export function evaluateChatGatekeeper(
  userMessage: string,
  context?: ChatContext,
  history?: ChatMessage[]
): GatekeeperDecision {
  const extractedUrl = extractUrlFromMessage(userMessage);

  if (extractedUrl) {
    const currentUrl = context?.url ? validateAndNormalizeCandidateUrl(context.url, true) : null;
    const isSameAlreadyScanned =
      currentUrl &&
      new URL(currentUrl).hostname.replace(/^www\./, '') ===
        new URL(extractedUrl).hostname.replace(/^www\./, '') &&
      Boolean(context?.findingsSummary);

    if (!isSameAlreadyScanned) {
      return {
        action: 'trigger_scan',
        targetUrl: extractedUrl,
        replyAr: `ثواني بس هراجع الموقع (${new URL(extractedUrl).hostname}) وأجيلك بالدليل...`
      };
    }
  }

  const hasScannedSite = Boolean(context?.domain || context?.url);
  if (hasScannedSite) {
    return {
      action: 'allow_chat'
    };
  }

  // No scanned site yet:
  // 1. If the user asks about our services, Madam Afaf's work, how to add a site, web dev, e-commerce, SEO, or programming -> allow AI chat immediately
  if (isServiceOrTechnicalQuestion(userMessage)) {
    return {
      action: 'allow_chat'
    };
  }

  // 2. Check if the one-time guidance message was already shown in chat history or if this is after the first turn
  const safeHistory = Array.isArray(history) ? history : [];
  const userTurnsCount = safeHistory.filter(m => m.role === 'user').length;
  const alreadySawGuidancePrompt = safeHistory.some(
    m => m.role === 'assistant' && m.content && m.content.includes('ابعتلي لينك الموقع')
  );

  if (alreadySawGuidancePrompt || userTurnsCount >= 2) {
    return {
      action: 'allow_chat'
    };
  }

  // First general greeting with no scanned site and no prior guidance -> return the one-time guidance prompt
  return {
    action: 'needs_url',
    replyAr: NEEDS_URL_RESPONSES[0]
  };
}
