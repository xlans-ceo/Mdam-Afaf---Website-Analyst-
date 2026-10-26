/**
 * Step 3: Site Profiling (buildSiteProfile)
 * Extracts platform, builder, language, direction, siteType, primary conversion path,
 * and market/language signals before running checks.
 */
import {
  BuilderKind,
  ConversionKind,
  PlatformKind,
  SiteProfile,
  SiteTypeKind
} from '../types/contract';
import { detectEcommerceSignals } from './ecommerce-detector';
import { detectAiBuilder } from '../knowledge/ai-builders';

export interface SiteProfilerInput {
  url: string;
  html: string;
  headers?: Headers | Record<string, string> | null;
}

function getHeaderValue(
  headers: Headers | Record<string, string> | null | undefined,
  key: string
): string {
  if (!headers) return '';
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(key) || '';
  }
  const rec = headers as Record<string, string>;
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return v || '';
  }
  return '';
}

export function buildSiteProfile(input: SiteProfilerInput): SiteProfile {
  const { html, headers } = input;
  const signals: string[] = [];

  // 1. Platform & Builder detection from deterministic markup/header signals
  let platform: PlatformKind = 'unknown';
  let builder: BuilderKind = 'none';
  let version: string | undefined;
  let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
  let confidenceScore = 0.5;

  const detectedAiBuilder = detectAiBuilder(input.url, html);

  const generatorMatches = Array.from(
    html.matchAll(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["'][^>]*>/gi)
  ).map(m => m[1].trim());
  const generatorMatchesAlt = Array.from(
    html.matchAll(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']generator["'][^>]*>/gi)
  ).map(m => m[1].trim());
  const allGenerators = [...generatorMatches, ...generatorMatchesAlt];

  const hasWpContent = /\/wp-content\/|\/wp-includes\//i.test(html);
  const hasWpGen = allGenerators.some(g => /wordpress/i.test(g));
  const hasElementorGen = allGenerators.some(g => /elementor/i.test(g));
  const hasElementorClasses = /class=["'][^"']*elementor-/i.test(html) || /elementor-section|elementor-widget/i.test(html);

  if (detectedAiBuilder) {
    platform = 'ai_builder';
    builder = detectedAiBuilder.entry.id;
    confidenceLevel = detectedAiBuilder.confidence;
    confidenceScore = detectedAiBuilder.confidence === 'high' ? 0.96 : 0.85;
    signals.push(detectedAiBuilder.signalText);
    if (/<div\s+id=["'](?:root|app)["']/i.test(html)) {
      signals.push('Client-only SPA shell (<div id="root"></div>)');
    }
  } else if (hasWpContent || hasWpGen || hasElementorGen || hasElementorClasses) {
    platform = 'wordpress';
    confidenceLevel = 'high';
    confidenceScore = 0.96;
    if (hasWpGen) {
      const wpGen = allGenerators.find(g => /wordpress/i.test(g));
      if (wpGen) {
        signals.push(`generator: ${wpGen}`);
        version = wpGen;
      }
    }
    if (hasWpContent) signals.push('/wp-content/ asset paths');

    if (hasElementorGen || hasElementorClasses) {
      builder = 'elementor';
      const elGen = allGenerators.find(g => /elementor/i.test(g));
      if (elGen) {
        signals.push(`generator: ${elGen}`);
        version = version ? `${version} | ${elGen}` : elGen;
      } else {
        signals.push('elementor-* CSS classes');
      }
    } else if (/et_pb_|divi/i.test(html)) {
      builder = 'divi';
      signals.push('Divi builder classes');
    } else if (/wpb_|vc_row/i.test(html)) {
      builder = 'wpbakery';
      signals.push('WPBakery classes');
    } else if (/wp-block-/i.test(html)) {
      builder = 'gutenberg';
      signals.push('Gutenberg wp-block-* classes');
    }
  } else if (/cdn\.shopify\.com|Shopify\.theme/i.test(html) || getHeaderValue(headers, 'x-shopid')) {
    platform = 'shopify';
    confidenceLevel = 'high';
    confidenceScore = 0.96;
    signals.push('Shopify CDN / theme markers');
  } else if (/static\.parastorage\.com|wix\.com/i.test(html)) {
    platform = 'wix';
    confidenceLevel = 'high';
    confidenceScore = 0.95;
    signals.push('Wix static.parastorage.com marker');
  } else if (/squarespace\.com|Static\.SQUARESPACE_CONTEXT/i.test(html)) {
    platform = 'squarespace';
    confidenceLevel = 'high';
    confidenceScore = 0.95;
    signals.push('Squarespace context marker');
  } else if (/data-wf-site|webflow\.js/i.test(html)) {
    platform = 'webflow';
    confidenceLevel = 'high';
    confidenceScore = 0.95;
    signals.push('Webflow data-wf-site marker');
  } else if (/__NEXT_DATA__|\/_next\/static\//i.test(html)) {
    platform = 'nextjs';
    confidenceLevel = 'high';
    confidenceScore = 0.94;
    signals.push('Next.js /_next/ build markers');
  } else if (
    (/<div\s+id=["'](?:root|app)["'][^>]*>\s*(?:<noscript>[\s\S]*?<\/noscript>)?\s*<\/div>/i.test(html) ||
      (/<div\s+id=["'](?:root|app)["']/i.test(html) && /<script[^>]+type=["']module["']/i.test(html))) &&
    (stripTagsToVisibleText(html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')).length < 250 ||
      /\/assets\/index-[a-zA-Z0-9_-]+\.js/i.test(html))
  ) {
    platform = 'spa';
    confidenceLevel = 'high';
    confidenceScore = 0.92;
    signals.push('Client-only SPA shell (<div id="root"></div>)');
    signals.push('Modern JavaScript bundle loader (<script type="module">)');
  } else if (/<html/i.test(html) && /<body/i.test(html)) {
    platform = 'static_html';
    confidenceLevel = 'low';
    confidenceScore = 0.5;
    signals.push('Basic HTML document structure');
  }

  // Detect Tailwind CSS explicitly so we never suggest Tailwind unless present
  const hasTailwind =
    /tailwindcss/i.test(html) ||
    /class=["'][^"']*(?:\bflex\b|\bgrid\b)[^"']*(?:\bpx-\d|\bpy-\d|\btext-(?:xs|sm|base|lg|xl)\b|\brounded-(?:md|lg|xl|2xl|full)\b)/i.test(
      html
    );
  if (hasTailwind) {
    signals.push('Tailwind CSS utility classes detected');
  }

  const isCodeRepoPlatform =
    platform === 'nextjs' ||
    platform === 'spa' ||
    platform === 'ai_builder' ||
    platform === 'static_html';

  // 2. Language & Direction
  const htmlTagMatch = html.match(/<html([^>]*)>/i);
  const htmlAttrs = htmlTagMatch ? htmlTagMatch[1] : '';
  const langMatch = htmlAttrs.match(/lang=["']([^"']+)["']/i);
  const dirMatch = htmlAttrs.match(/dir=["']([^"']+)["']/i);

  const visibleText = stripTagsToVisibleText(html);
  const arabicChars = (visibleText.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (visibleText.match(/[A-Za-z]/g) || []).length;
  const totalAlpha = arabicChars + latinChars;
  const arabicRatio = totalAlpha > 0 ? Number((arabicChars / totalAlpha).toFixed(2)) : 0;

  const declaredLang = langMatch ? langMatch[1].trim().toLowerCase() : '';
  const language = declaredLang || (arabicRatio >= 0.4 ? 'ar' : 'en');
  const declaredDir = dirMatch ? dirMatch[1].trim().toLowerCase() : '';
  const direction: 'rtl' | 'ltr' | 'auto' =
    declaredDir === 'rtl' || declaredDir === 'ltr'
      ? (declaredDir as 'rtl' | 'ltr')
      : arabicRatio >= 0.4
      ? 'rtl'
      : 'ltr';

  // 3. Site Type classification from deterministic content signals + detectEcommerceSignals (G3.8)
  let siteType: SiteTypeKind = 'unknown';
  let siteTypeReason = 'تم التحديد من محتوى وهيكل الصفحة';

  const extractedUrls = Array.from(html.matchAll(/\bhref=["']([^"']+)["']/gi)).map(m => m[1]);
  const hasCartElement =
    /أضف إلى السلة|اضف للسلة|سلة التسوق|سلة المشتريات|add to cart|إتمام الطلب/i.test(visibleText) ||
    platform === 'shopify' ||
    /class=["'][^"']*(?:add_to_cart_button|cart|woocommerce-cart)/i.test(html);

  const ecommerceSignals = detectEcommerceSignals(html, extractedUrls);

  if (ecommerceSignals.signals.length > 0) {
    for (const sig of ecommerceSignals.signals) {
      if (!signals.includes(sig)) signals.push(sig);
    }
  }

  const hasActiveCartVisible =
    hasCartElement || ecommerceSignals.isEcommerce;
  const hasManufacturingSignal =
    /مصنع|تصنيع|تصدير|نصدر|خطوط إنتاج|منتجاتنا الصناعية|خامات|طاقة إنتاجية|توريد|manufacturer|factory|export|industrial|production/i.test(
      visibleText
    );
  const hasB2bServicesSignal =
    /خدماتنا|استشارات|حلول أعمال|شريكك|مقاولات|شحن|تخليص جمركي|برمجة|تسويق|agency|consulting|b2b|solutions/i.test(
      visibleText
    );
  const hasPortfolioSignal =
    /أعمالي|معرض الأعمال|سابقة أعمالنا|portfolio|case studies|my work/i.test(visibleText);
  const hasBlogSignal = /مقالات|مدونة|اقرأ المزيد|كتب بواسطة|blog|articles/i.test(visibleText);

  if (hasManufacturingSignal && !hasCartElement) {
    siteType = 'b2b_manufacturer';
    siteTypeReason = 'وجود كلمات مفتاحية للتصنيع والتوريد والتصدير (B2B Manufacturer)';
  } else if (hasActiveCartVisible) {
    siteType = 'ecommerce';
    siteTypeReason = 'وجود إشارات سلة شراء أو متجر إلكتروني فعالة في الصفحة';
  } else if (hasManufacturingSignal) {
    siteType = 'b2b_manufacturer';
    siteTypeReason = 'وجود كلمات مفتاحية للتصنيع والتوريد والتصدير (B2B Manufacturer)';
  } else if (hasB2bServicesSignal) {
    siteType = 'b2b_services';
    siteTypeReason = 'وجود إشارات خدمات شركات وأعمال (B2B Services)';
  } else if (hasPortfolioSignal) {
    siteType = 'portfolio';
    siteTypeReason = 'وجود معرض وسابقة أعمال (Portfolio)';
  } else if (hasBlogSignal && !hasB2bServicesSignal) {
    siteType = 'blog';
    siteTypeReason = 'هيكل مقالات ومدونة';
  } else if (visibleText.length > 80) {
    siteType = 'corporate';
    siteTypeReason = 'موقع تعريفي لشركة أو مؤسسة';
  }

  // 4. Primary conversion path & top-of-page visibility
  const topSlice = html.slice(0, Math.max(2500, Math.floor(html.length * 0.4)));
  let convType: ConversionKind = 'none';
  let inTopOfPage = false;
  let convEvidence: string | undefined;

  const waMatch = html.match(/(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com)\/[^\s"'<>]+/i);
  const telMatch = html.match(/href=["'](tel:[^"']+)["']/i);
  const formMatch = html.match(/<form\b[^>]*>/i);

  if (waMatch) {
    convType = 'whatsapp';
    inTopOfPage = /(?:wa\.me|api\.whatsapp\.com)/i.test(topSlice);
    convEvidence = waMatch[0].slice(0, 80);
  } else if (hasActiveCartVisible) {
    convType = 'cart';
    inTopOfPage = /add-to-cart|cart|سلة/i.test(topSlice);
    convEvidence = 'Cart / Checkout action';
  } else if (telMatch) {
    convType = 'phone';
    inTopOfPage = /href=["']tel:/i.test(topSlice);
    convEvidence = telMatch[1];
  } else if (formMatch) {
    convType = 'form';
    inTopOfPage = /<form\b/i.test(topSlice);
    convEvidence = formMatch[0].slice(0, 80);
  }

  // 5. Markets & Alternate Language detection
  const marketKeywords = [
    'مصر',
    'السعودية',
    'الإمارات',
    'الكويت',
    'قطر',
    'عمان',
    'البحرين',
    'أفريقيا',
    'أوروبا',
    'الخليج',
    'الشرق الأوسط',
    'العالم',
    'Egypt',
    'Saudi',
    'KSA',
    'UAE',
    'GCC',
    'Africa',
    'Europe'
  ];
  const countriesOrRegions = marketKeywords.filter(kw =>
    new RegExp(kw, 'i').test(visibleText)
  );
  const hasExportClaims =
    /تصدير|نصدر|التصدير|أسواق عالمية|جميع أنحاء العالم|دول العالم|export|worldwide|international markets/i.test(
      visibleText
    );

  // Check if a real alternate language version exists (different from the actual content language):
  const effectiveContentLang =
    arabicRatio >= 0.4 ? 'ar' : (language || 'ar').split('-')[0].toLowerCase();

  const hreflangMatches = Array.from(
    html.matchAll(/<link[^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi)
  ).filter(m => {
    const hLang = (m[1] || '').trim().toLowerCase();
    const hHref = (m[2] || '').trim();
    if (!hLang || hLang === 'x-default' || hLang.startsWith(effectiveContentLang)) {
      return false;
    }
    return Boolean(hHref && hHref !== '#' && !hHref.toLowerCase().startsWith('javascript:'));
  });

  const realLangSwitchMatches = Array.from(
    html.matchAll(/<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi)
  ).filter(m => {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
    const href = hrefMatch ? hrefMatch[1].trim() : '';
    const isForeignForAr =
      effectiveContentLang === 'ar'
        ? /^(?:en|english|fr|french|de|es|ru|zh)$/i.test(text) || /\/(?:en|fr|de)\/|lang=(?:en|fr|de)/i.test(href)
        : /^(?:ar|عربي|العربية)$/i.test(text) || /\/ar\/|lang=ar/i.test(href);
    const isRealDest = Boolean(href && href !== '#' && !href.toLowerCase().startsWith('javascript:'));
    return isForeignForAr && isRealDest;
  });

  const hasAlternateLanguage = hreflangMatches.length > 0 || realLangSwitchMatches.length > 0;
  const alternateLangEvidence =
    hreflangMatches[0]?.[0]?.slice(0, 100) ||
    realLangSwitchMatches[0]?.[0]?.slice(0, 100) ||
    undefined;

  return {
    type: siteType === 'ecommerce' ? 'ecommerce' : 'standard',
    confidence: confidenceScore,
    signals,
    platform,
    builder,
    version,
    confidenceLevel,
    platformConfidence: confidenceLevel,
    hasTailwind,
    isCodeRepoPlatform,
    language,
    direction,
    arabicRatio,
    siteType,
    siteTypeReason,
    primaryConversion: {
      type: convType,
      inTopOfPage,
      evidence: convEvidence
    },
    markets: {
      countriesOrRegions,
      hasExportClaims,
      hasAlternateLanguage,
      alternateLangEvidence
    }
  };
}

export function stripTagsToVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
