/**
 * E-Commerce Classifier & Large Catalog Preflight Detection
 * Distinguishes standard sites, small/medium e-commerce, and unsupported large e-commerce catalogs.
 */

export interface EcommerceDetectionResult {
  isEcommerce: boolean;
  confidence: number; // 0 to 1
  signals: string[];
  isLargeStore: boolean;
  largeStoreReasonAr?: string;
  largeStoreReasonEn?: string;
  detectedCategoriesCount: number;
  detectedProductUrlsCount: number;
  sitemapUrlsCount?: number;
}

export interface LargeStoreThresholds {
  categoryThreshold: number; // default 20
  productUrlThreshold: number; // default 500
  sitemapUrlThreshold: number; // default 1000
}

export const DEFAULT_THRESHOLDS: LargeStoreThresholds = {
  categoryThreshold: 20,
  productUrlThreshold: 500,
  sitemapUrlThreshold: 1000
};

/**
 * Analyzes page HTML and discovered link graph to classify e-commerce presence
 */
export function detectEcommerceSignals(
  html: string, 
  discoveredLinks: string[] = [], 
  thresholds: LargeStoreThresholds = DEFAULT_THRESHOLDS
): EcommerceDetectionResult {
  const signals: string[] = [];
  let score = 0;

  const lowerHtml = html.toLowerCase();

  // 1. Schema.org / JSON-LD / Microdata structured data
  const hasProductSchema = 
    lowerHtml.includes('"@type":"product"') || 
    lowerHtml.includes('"@type": "product"') ||
    lowerHtml.includes('itemtype="https://schema.org/product"') ||
    lowerHtml.includes('itemtype="http://schema.org/product"') ||
    lowerHtml.includes('"@type":"productgroup"') ||
    lowerHtml.includes('"@type": "productgroup"');

  if (hasProductSchema) {
    signals.push('Structured Product/ProductGroup schema detected');
    score += 45;
  }

  // 2. Add-to-cart or buy buttons
  const cartButtonPattern = /(add to cart|add to bag|buy now|أضف للسلة|إضافة إلى السلة|أضف إلى عربة التسوق|اشتري الآن|شراء الآن)/i;
  if (cartButtonPattern.test(html)) {
    signals.push('Add-to-cart / checkout action controls found');
    score += 30;
  }

  // 3. Cart link or mini-cart
  const cartNavPattern = /(href=["'][^"']*(cart|checkout|basket|عربة-التسوق|السلة)[^"']*["'])/i;
  if (cartNavPattern.test(html)) {
    signals.push('Shopping cart / checkout navigation link found');
    score += 20;
  }

  // 4. Currency / Price indicators with numbers
  const pricePattern = /(\$\s*\d+|\d+\s*ج\.م|\d+\s*egp|\d+\s*sar|\d+\s*aed|\d+\s*usd|\d+\s*eur|le\s*\d+|سعر\s*:\s*\d+)/i;
  if (pricePattern.test(html)) {
    signals.push('Price and currency formatting detected');
    score += 15;
  }

  // 5. Route patterns across discovered links
  const categoryUrls = new Set<string>();
  const productUrls = new Set<string>();

  for (const link of discoveredLinks) {
    const lower = link.toLowerCase();
    if (lower.includes('/category/') || lower.includes('/categories/') || 
        lower.includes('/collection/') || lower.includes('/collections/') ||
        lower.includes('/تصنيف/') || lower.includes('/قسم/')) {
      categoryUrls.add(link);
    }
    if (lower.includes('/product/') || lower.includes('/products/') ||
        lower.includes('/item/') || lower.includes('/items/') ||
        lower.includes('/منتج/') || lower.includes('/goods/')) {
      productUrls.add(link);
    }
  }

  if (categoryUrls.size > 0 || productUrls.size > 0) {
    signals.push(`E-commerce URL structures (${categoryUrls.size} categories, ${productUrls.size} products)`);
    score += 25;
  }

  const confidence = Math.min(1.0, score / 100);
  const isEcommerce = confidence >= 0.45;

  // 6. Preflight Large-Store Check
  let isLargeStore = false;
  let largeStoreReasonAr: string | undefined;
  let largeStoreReasonEn: string | undefined;

  if (isEcommerce) {
    if (categoryUrls.size > thresholds.categoryThreshold) {
      isLargeStore = true;
      largeStoreReasonEn = `Exceeded category threshold: ${categoryUrls.size} > ${thresholds.categoryThreshold}`;
    } else if (productUrls.size > thresholds.productUrlThreshold) {
      isLargeStore = true;
      largeStoreReasonEn = `Exceeded product URL threshold: ${productUrls.size} > ${thresholds.productUrlThreshold}`;
    }

    if (isLargeStore) {
      largeStoreReasonAr = 
        'الموقع ده باين إنه متجر إلكتروني كبير وفيه تصنيفات ومنتجات كتير. حاليًا بنركز على المواقع والمتاجر الصغيرة والمتوسطة علشان نقدر نراجعها بدقة. دعم المتاجر الكبيرة هييجي في إصدار لاحق.';
    }
  }

  return {
    isEcommerce,
    confidence,
    signals,
    isLargeStore,
    largeStoreReasonAr,
    largeStoreReasonEn,
    detectedCategoriesCount: categoryUrls.size,
    detectedProductUrlsCount: productUrls.size
  };
}
