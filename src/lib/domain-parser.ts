/**
 * Domain Parser & URL Normalization
 * Respects Public Suffix List rules for registrable domains (via tldts with allowPrivateDomains: true
 * plus explicit multi-tenant hosting suffix overrides), strips tracking parameters,
 * and separates meaningful content routes from interaction states.
 */
import { getDomain } from 'tldts';

// Multi-tenant hosting suffixes where each subdomain belongs to a separate tenant/site owner
export const PRIVATE_HOSTING_SUFFIXES = [
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'github.io',
  'gitlab.io',
  'web.app',
  'firebaseapp.com',
  'onrender.com',
  'fly.dev',
  'railway.app',
  'herokuapp.com',
  'workers.dev',
  'run.app',
  'ngrok-free.app',
  'ngrok.io',
  'glitch.me',
  'surge.sh'
] as const;

// Known marketing and tracking query parameters to strip
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'ref', 'source', 'affiliate_id',
  'zanpid', 'igshid', 'yclid'
]);

// Known UI interaction query parameters that do NOT represent new meaningful pages
const INTERACTION_PARAMS = new Set([
  'sort', 'order', 'orderby', 'direction',
  'color', 'colour', 'size', 'variant', 'sku',
  'filter', 'filters', 'tag', 'tags',
  'min_price', 'max_price', 'price_min', 'price_max',
  'view', 'display', 'layout', 'grid', 'list',
  'page', 'p', 'offset', 'limit', 'per_page',
  'tab', 'section', 'modal', 'popup'
]);

/**
 * Extracts the registrable domain (e.g. example.com from www.example.com,
 * company.com.eg from www.shop.company.com.eg, or tenant1.vercel.app from preview.tenant1.vercel.app).
 */
export function getRegistrableDomain(hostnameOrUrl: string): string {
  let hostname = (hostnameOrUrl || '').trim().toLowerCase();
  if (!hostname) return '';

  if (hostname.includes('://')) {
    try {
      const parsed = new URL(hostname);
      hostname = parsed.hostname.toLowerCase();
    } catch {
      hostname = hostname.replace(/^https?:\/\//, '').split('/')[0].split('?')[0].split(':')[0];
    }
  } else {
    hostname = hostname.split('/')[0].split('?')[0].split(':')[0];
  }

  hostname = hostname.replace(/\.$/, '').replace(/^www\./, '');

  // Handle localhost and raw IPs
  if (hostname === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) {
    return hostname;
  }

  // Explicit private hosting suffix overrides so tenant1.vercel.app and tenant2.vercel.app never collide
  for (const suffix of PRIVATE_HOSTING_SUFFIXES) {
    if (hostname === suffix) {
      return suffix;
    }
    if (hostname.endsWith(`.${suffix}`)) {
      const prefix = hostname.slice(0, -(suffix.length + 1));
      const prefixParts = prefix.split('.').filter(Boolean);
      if (prefixParts.length >= 1) {
        const tenantLabel = prefixParts[prefixParts.length - 1];
        return `${tenantLabel}.${suffix}`;
      }
    }
  }

  const tldtsDomain = getDomain(hostname, { allowPrivateDomains: true });
  if (tldtsDomain) {
    return tldtsDomain.toLowerCase();
  }

  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return hostname;
  }

  return parts.slice(-2).join('.');
}

/**
 * Normalizes a URL:
 * - standardizes protocol and lowercase hostname
 * - strips default ports (:80, :443)
 * - removes tracking parameters
 * - preserves canonical path and routing query params
 * - removes hash/fragment
 */
export function normalizeUrl(rawUrl: string): string {
  let trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    trimmed = 'https://' + trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';

    // Remove default ports
    if ((parsed.protocol === 'http:' && parsed.port === '80') ||
        (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }

    // Clean query parameters: remove tracking params
    const keysToRemove: string[] = [];
    parsed.searchParams.forEach((_, key) => {
      const lower = key.toLowerCase();
      if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
        keysToRemove.push(key);
      }
    });
    for (const key of keysToRemove) {
      parsed.searchParams.delete(key);
    }

    // Sort query parameters for canonical consistency
    parsed.searchParams.sort();

    // Standardize trailing slash on non-root paths (remove trailing slash unless it's just '/')
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Checks if target URL belongs to the same registrable domain or approved canonical redirect
 */
export function isSameRegistrableDomain(targetUrl: string, baseDomain: string): boolean {
  try {
    const targetDomain = getRegistrableDomain(targetUrl);
    const normalizedBase = getRegistrableDomain(baseDomain);
    return targetDomain === normalizedBase;
  } catch {
    return false;
  }
}

/**
 * Determines whether a URL destination represents an interaction state or a distinct meaningful page.
 * Product filters, sorting, variant selections, tabs, and pagination states within the same listing
 * are classified as interaction states and DO NOT consume additional meaningful page slots.
 */
export function classifyUrlSlot(url: string, canonicalUrl?: string): {
  isMeaningfulPage: boolean;
  isInteractionState: boolean;
  canonicalKey: string;
  reason: string;
} {
  try {
    const parsed = new URL(url);
    const cleanBase = `${parsed.origin}${parsed.pathname}`;

    // If a canonical URL is provided and differs only in query params/fragments, map to canonical
    if (canonicalUrl) {
      try {
        const parsedCanonical = new URL(canonicalUrl);
        if (parsedCanonical.origin === parsed.origin && parsedCanonical.pathname === parsed.pathname) {
          return {
            isMeaningfulPage: false,
            isInteractionState: true,
            canonicalKey: `${parsedCanonical.origin}${parsedCanonical.pathname}`,
            reason: 'Matches canonical URL structure'
          };
        }
      } catch {
        // ignore invalid canonical
      }
    }

    // Check query params for interaction-state indicators
    let hasInteractionParam = false;
    parsed.searchParams.forEach((_, key) => {
      if (INTERACTION_PARAMS.has(key.toLowerCase())) {
        hasInteractionParam = true;
      }
    });

    if (hasInteractionParam) {
      return {
        isMeaningfulPage: false,
        isInteractionState: true,
        canonicalKey: cleanBase,
        reason: 'URL contains filter, sort, variant, or pagination parameters'
      };
    }

    // Detect hash-only or modal states
    if (parsed.pathname === '/' && parsed.search === '' && parsed.hash) {
      return {
        isMeaningfulPage: false,
        isInteractionState: true,
        canonicalKey: cleanBase,
        reason: 'Anchor jump / section state'
      };
    }

    return {
      isMeaningfulPage: true,
      isInteractionState: false,
      canonicalKey: parsed.search ? `${cleanBase}?${parsed.searchParams.toString()}` : cleanBase,
      reason: 'Distinct content page route'
    };
  } catch {
    return {
      isMeaningfulPage: false,
      isInteractionState: false,
      canonicalKey: url,
      reason: 'Invalid URL'
    };
  }
}
