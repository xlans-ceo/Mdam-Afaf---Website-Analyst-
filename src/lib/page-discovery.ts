/**
 * Section 6.4: Page Discovery (max 10 pages per scan)
 * Sources: Homepage -> Header/Nav -> sitemap.xml (1 level, <=200 URLs) -> WordPress /wp-json/wp/v2/pages
 * Respects robots.txt (skipped pages go to NOT_MEASURED).
 */
import { SCAN_LIMITS } from '../config/limits.server';
import {
  classifyUrlSlot,
  getRegistrableDomain,
  isSameRegistrableDomain,
  normalizeUrl
} from './domain-parser';
import { safeFetchHtmlWithSsrf } from './ssrf-validator';
import { PageInfo, SiteProfile } from '../types/contract';

const EXCLUDED_PATH_SEGMENTS =
  /\/(cart|checkout|my-account|account|wp-admin|admin|login|wp-login\.php|signin|sign-in|register|search|feed|rss|comments|author|tag|category\/[^/]+\/page|page\/\d+|wp-json|xmlrpc\.php)(\/|$|\?)/i;

const EXCLUDED_EXTENSIONS =
  /\.(pdf|jpg|jpeg|png|webp|gif|svg|ico|mp4|webm|mp3|wav|zip|rar|tar|gz|css|js|map|xml|json|woff|woff2|ttf|eot)(\?|$)/i;

export interface DiscoveredCandidate {
  url: string;
  source: 'homepage' | 'nav' | 'sitemap' | 'wp_api' | 'body_link';
  priority: number;
  pageType: PageInfo['pageType'];
  label?: string;
}

export interface RobotsPolicy {
  disallowedPrefixes: string[];
  allowedPrefixes: string[];
  rawSnippet?: string;
}

export function parseRobotsTxt(robotsText: string): RobotsPolicy {
  const lines = (robotsText || '').split(/\r?\n/);
  let appliesToUs = false;
  let inUserAgentRun = false;
  let currentGroupAgents: string[] = [];
  const disallowedPrefixes: string[] = [];
  const allowedPrefixes: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [directiveRaw, ...valueParts] = line.split(':');
    if (!directiveRaw || valueParts.length === 0) continue;
    const directive = directiveRaw.trim().toLowerCase();
    const val = valueParts.join(':').trim();

    if (directive === 'user-agent') {
      if (!inUserAgentRun) {
        currentGroupAgents = [];
        inUserAgentRun = true;
      }
      currentGroupAgents.push(val.toLowerCase());
      appliesToUs = currentGroupAgents.some(
        ua => ua === '*' || ua.includes('madamafafbot')
      );
    } else if (directive === 'disallow') {
      inUserAgentRun = false;
      if (appliesToUs && val) {
        disallowedPrefixes.push(val);
      }
    } else if (directive === 'allow') {
      inUserAgentRun = false;
      if (appliesToUs && val) {
        allowedPrefixes.push(val);
      }
    } else {
      inUserAgentRun = false;
    }
  }

  return {
    disallowedPrefixes,
    allowedPrefixes,
    rawSnippet: robotsText ? robotsText.slice(0, 300) : undefined
  };
}

export function isDisallowedByRobots(urlOrPath: string, policy: RobotsPolicy): boolean {
  if (!policy.disallowedPrefixes.length) return false;
  let pathWithQuery = urlOrPath;
  try {
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      const parsed = new URL(urlOrPath);
      pathWithQuery = `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    pathWithQuery = urlOrPath;
  }

  let matchedDisallowLen = -1;
  for (const rule of policy.disallowedPrefixes) {
    const cleanRule = rule.replace(/\*+$/, '');
    if (rule === '/' || (cleanRule && pathWithQuery.startsWith(cleanRule))) {
      matchedDisallowLen = Math.max(matchedDisallowLen, cleanRule.length || 1);
    }
  }

  if (matchedDisallowLen < 0) return false;

  let matchedAllowLen = -1;
  for (const rule of policy.allowedPrefixes || []) {
    const cleanRule = rule.replace(/\*+$/, '');
    if (cleanRule && pathWithQuery.startsWith(cleanRule)) {
      matchedAllowLen = Math.max(matchedAllowLen, cleanRule.length);
    }
  }

  return matchedDisallowLen > matchedAllowLen;
}

export function classifyCandidatePriority(
  urlStr: string,
  linkText: string,
  source: DiscoveredCandidate['source']
): { priority: number; pageType: PageInfo['pageType'] } {
  let decodedPath = '';
  try {
    const u = new URL(urlStr);
    decodedPath = decodeURIComponent(u.pathname).toLowerCase();
  } catch {
    decodedPath = urlStr.toLowerCase();
  }
  const combined = `${decodedPath} ${linkText.toLowerCase()}`;

  if (decodedPath === '/' || decodedPath === '') {
    return { priority: 0, pageType: 'home' };
  }
  if (/contact|اتصل|تواصل|فروعنا|عنواننا/i.test(combined)) {
    return { priority: 1, pageType: 'contact' };
  }
  if (/about|من-نحن|عن-الشركة|عن-المصنع|قصتنا|who-we-are/i.test(combined)) {
    return { priority: 2, pageType: 'content' };
  }
  if (/products|services|shop|catalog|منتجات|خدمات|كتالوج|الأصناف|تصدير/i.test(combined)) {
    return { priority: 3, pageType: 'listing' };
  }
  if (/product\/|item\/|service\/|project\/|منتج\//i.test(decodedPath)) {
    return { priority: 4, pageType: 'product' };
  }
  if (/privacy|terms|policy|سياسة|الشروط|الأحكام/i.test(combined)) {
    return { priority: 5, pageType: 'content' };
  }
  if (/^\/(en|ar|fr)(\/|$)/i.test(decodedPath)) {
    return { priority: 6, pageType: 'content' };
  }
  if (source === 'nav') {
    return { priority: 7, pageType: 'content' };
  }
  return { priority: 8, pageType: 'other' };
}

export function isEligibleInternalUrl(
  rawHref: string,
  baseUrl: string,
  registrableDomain: string,
  onInteractionState?: () => void
): string | null {
  const trimmed = (rawHref || '').trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.toLowerCase().startsWith('javascript:') ||
    trimmed.toLowerCase().startsWith('mailto:') ||
    trimmed.toLowerCase().startsWith('tel:') ||
    /wa\.me|api\.whatsapp\.com/i.test(trimmed)
  ) {
    if (trimmed.startsWith('#') && trimmed.length > 1 && onInteractionState) {
      onInteractionState();
    }
    return null;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    if (!isSameRegistrableDomain(resolved.toString(), registrableDomain)) {
      return null;
    }
    const decodedPath = decodeURIComponent(resolved.pathname);
    if (EXCLUDED_PATH_SEGMENTS.test(decodedPath) || EXCLUDED_EXTENSIONS.test(decodedPath)) {
      return null;
    }
    // G3.8: Filters, sort, variants, pagination and tracking params never consume page slots
    const slot = classifyUrlSlot(resolved.toString());
    if (!slot.isMeaningfulPage) {
      if (slot.isInteractionState && onInteractionState) {
        onInteractionState();
      }
      return null;
    }
    return slot.canonicalKey || normalizeUrl(resolved.toString());
  } catch {
    return null;
  }
}

function extractAnchorPairs(htmlFragment: string): { href: string; text: string }[] {
  const pairs: { href: string; text: string }[] = [];
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of htmlFragment.matchAll(anchorRegex)) {
    const attrs = m[1] || '';
    const inner = (m[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i);
    if (hrefMatch && hrefMatch[1]) {
      pairs.push({ href: hrefMatch[1].trim(), text: inner });
    }
  }
  return pairs;
}

export async function discoverSitePages(params: {
  rootUrl: string;
  rootHtml: string;
  profile?: SiteProfile;
  maxPages?: number;
  allowLocalFixtures?: boolean;
  onRequestMade?: () => boolean;
  remainingMs?: () => number;
  signal?: AbortSignal;
}): Promise<{
  selectedUrls: DiscoveredCandidate[];
  discoveredNotScanned?: string[];
  skippedByRobots: string[];
  robotsPolicy: RobotsPolicy;
  interactionStatesCount: number;
  robotsTxtPresent: boolean;
  sitemapXmlPresent: boolean;
}> {
  const {
    rootUrl,
    rootHtml,
    profile,
    maxPages = SCAN_LIMITS.MAX_PAGES_PER_SCAN,
    allowLocalFixtures = false,
    onRequestMade,
    remainingMs = () => SCAN_LIMITS.SCAN_TIMEOUT_S * 1000,
    signal
  } = params;

  const canMakeRequest = () => {
    if (signal?.aborted || remainingMs() <= 0) return false;
    return onRequestMade ? onRequestMade() : true;
  };
  const registrableDomain = getRegistrableDomain(rootUrl);
  const normalizedRoot = normalizeUrl(rootUrl);
  const origin = new URL(normalizedRoot).origin;

  // 1. Fetch robots.txt (1 request)
  let robotsPolicy: RobotsPolicy = { disallowedPrefixes: [], allowedPrefixes: [] };
  let robotsTxtPresent = false;
  if (canMakeRequest()) {
    try {
      const robotsRes = await safeFetchHtmlWithSsrf(`${origin}/robots.txt`, {
        timeoutMs: Math.min(4000, Math.max(1, remainingMs())),
        maxRedirects: 2,
        maxBytes: 128 * 1024,
        allowLocalFixtures,
        signal
      });
      if (robotsRes.ok && robotsRes.status === 200 && robotsRes.html) {
        const trimmedRobots = robotsRes.html.trim();
        if (trimmedRobots.length > 0 && !/^<!doctype html|^<html/i.test(trimmedRobots)) {
          robotsTxtPresent = true;
          robotsPolicy = parseRobotsTxt(robotsRes.html);
        }
      }
    } catch {
      // ignore missing robots.txt
    }
  }


  const candidateMap = new Map<string, DiscoveredCandidate>();
  const skippedByRobots: string[] = [];
  let interactionStatesCount = 0;
  const onInteraction = () => {
    interactionStatesCount++;
  };

  // Always add homepage first
  candidateMap.set(normalizedRoot, {
    url: normalizedRoot,
    source: 'homepage',
    priority: 0,
    pageType: 'home',
    label: 'الصفحة الرئيسية'
  });

  const addCandidate = (
    rawHref: string,
    text: string,
    source: DiscoveredCandidate['source']
  ) => {
    const eligible = isEligibleInternalUrl(rawHref, normalizedRoot, registrableDomain, onInteraction);
    if (!eligible) return;

    if (isDisallowedByRobots(eligible, robotsPolicy)) {
      if (!skippedByRobots.includes(eligible)) {
        skippedByRobots.push(eligible);
      }
      return;
    }

    const { priority, pageType } = classifyCandidatePriority(eligible, text, source);
    const existing = candidateMap.get(eligible);
    if (!existing || priority < existing.priority) {
      candidateMap.set(eligible, {
        url: eligible,
        source,
        priority,
        pageType,
        label: text || undefined
      });
    }
  };

  // 2. Extract header / nav links first, then body links from rootHtml
  const safeHtml = rootHtml || '';
  const navBlocks = Array.from(
    safeHtml.matchAll(/<(header|nav)\b[^>]*>([\s\S]*?)<\/\1>/gi)
  ).map(m => m[2] || '');

  for (const block of navBlocks) {
    for (const pair of extractAnchorPairs(block)) {
      addCandidate(pair.href, pair.text, 'nav');
    }
  }

  for (const pair of extractAnchorPairs(safeHtml)) {
    addCandidate(pair.href, pair.text, 'body_link');
  }

  // 3. Fetch sitemap.xml (1 level, <=200 URLs; if sitemapindex, fetch at most 1 child sitemap)
  let sitemapXmlPresent = false;
  if (canMakeRequest()) {
    try {
      const sitemapRes = await safeFetchHtmlWithSsrf(`${origin}/sitemap.xml`, {
        timeoutMs: Math.min(4500, Math.max(1, remainingMs())),
        maxRedirects: 2,
        maxBytes: 512 * 1024,
        allowLocalFixtures,
        signal
      });
      if (sitemapRes.ok && sitemapRes.status === 200 && sitemapRes.html) {
        if (/<urlset|<sitemapindex|<loc>/i.test(sitemapRes.html)) {
          sitemapXmlPresent = true;
        }
        const discoveryTargetCap = Math.max(maxPages, SCAN_LIMITS.MAX_PAGES_PER_SCAN);
        if (candidateMap.size < discoveryTargetCap) {
          const locMatches = Array.from(
            sitemapRes.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)
          ).slice(0, SCAN_LIMITS.MAX_SITEMAP_URLS);

          const xmlChildLocs: string[] = [];
          for (const m of locMatches) {
            const locUrl = m[1]?.trim();
            if (!locUrl) continue;
            if (/\.xml(\?|$)/i.test(locUrl)) {
              xmlChildLocs.push(locUrl);
            } else {
              addCandidate(locUrl, '', 'sitemap');
            }
          }

          // G3.9: If sitemap.xml is a sitemap index (or yielded child .xml sitemaps), fetch at most 1 child sitemap
          if (
            xmlChildLocs.length > 0 &&
            candidateMap.size < discoveryTargetCap &&
            canMakeRequest()
          ) {
            const preferredChild =
              xmlChildLocs.find(u => /page/i.test(u)) || xmlChildLocs[0];
            if (preferredChild && isSameRegistrableDomain(preferredChild, registrableDomain)) {
              const childRes = await safeFetchHtmlWithSsrf(preferredChild, {
                timeoutMs: Math.min(4000, Math.max(1, remainingMs())),
                maxRedirects: 2,
                maxBytes: 512 * 1024,
                allowLocalFixtures,
                signal
              });
              if (childRes.ok && childRes.status === 200 && childRes.html) {
                const childLocs = Array.from(
                  childRes.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)
                ).slice(0, SCAN_LIMITS.MAX_SITEMAP_URLS);
                for (const cm of childLocs) {
                  const cUrl = cm[1]?.trim();
                  if (cUrl && !/\.xml(\?|$)/i.test(cUrl)) {
                    addCandidate(cUrl, '', 'sitemap');
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore sitemap errors
    }
  }

  // 4. WordPress pages API (/wp-json/wp/v2/pages?per_page=15) if platform === 'wordpress' and we still need pages
  if (
    profile?.platform === 'wordpress' &&
    candidateMap.size < Math.max(maxPages, SCAN_LIMITS.MAX_PAGES_PER_SCAN) &&
    canMakeRequest()
  ) {
    try {
      const wpPagesRes = await safeFetchHtmlWithSsrf(
        `${origin}/wp-json/wp/v2/pages?per_page=15&_fields=link,title`,
        {
          timeoutMs: Math.min(4500, Math.max(1, remainingMs())),
          maxRedirects: 2,
          maxBytes: 256 * 1024,
          allowLocalFixtures,
          signal
        }
      );

      if (wpPagesRes.ok && wpPagesRes.status === 200 && wpPagesRes.html) {
        const parsed = JSON.parse(wpPagesRes.html);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item.link === 'string') {
              const titleRendered = item.title?.rendered || '';
              addCandidate(item.link, titleRendered, 'wp_api');
            }
          }
        }
      }
    } catch {
      // ignore wp-json errors
    }
  }

  // Sort candidates by priority and cap detail/product pages to max 2 so we get a balanced sample
  const sorted = Array.from(candidateMap.values()).sort((a, b) => a.priority - b.priority);
  const selectedUrls: DiscoveredCandidate[] = [];
  const discoveredNotScanned: string[] = [];
  let detailCount = 0;

  for (const cand of sorted) {
    if (selectedUrls.length < maxPages) {
      if (cand.pageType === 'product') {
        if (detailCount >= 2) {
          if (discoveredNotScanned.length < SCAN_LIMITS.MAX_PAGES_PER_SCAN) {
            discoveredNotScanned.push(cand.url);
          }
          continue;
        }
        detailCount++;
      }
      selectedUrls.push(cand);
    } else if (discoveredNotScanned.length < SCAN_LIMITS.MAX_PAGES_PER_SCAN) {
      discoveredNotScanned.push(cand.url);
    }
  }

  return {
    selectedUrls,
    discoveredNotScanned,
    skippedByRobots,
    robotsPolicy,
    interactionStatesCount,
    robotsTxtPresent,
    sitemapXmlPresent
  };
}
