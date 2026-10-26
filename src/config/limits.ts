/**
 * Pure, browser-safe scanner limits and policy constants.
 * Server-side environment variable overrides live in limits.server.ts.
 */
export const BOT_USER_AGENT = 'MadamAfafBot/2.0 (+https://madam-afaf.app)';

export const SCAN_LIMITS = {
  MAX_PAGES_PER_SCAN: 10,
  ECOMMERCE_MAX_PAGES: 10,
  DOMAIN_LOCK_HOURS: 10,
  MAX_REVIEWS_PER_DOMAIN_PER_WINDOW: 3,
  MAX_SCANS_PER_DOMAIN_PER_WINDOW: 5,
  MAX_REQUESTS_PER_SCAN: 45,
  REQUEST_TIMEOUT_S: 10,
  SCAN_TIMEOUT_S: 90,
  PSI_TIMEOUT_S: 25,
  DNS_TIMEOUT_MS: 3000,
  PAGE_CONCURRENCY: 3,
  IMAGE_HEAD_CONCURRENCY: 4,
  ALLOWED_PORTS: [80, 443, 8080, 8443] as readonly number[],
  MAX_HTML_BYTES: 3 * 1024 * 1024, // 3 MB
  MAX_REDIRECTS: 5,
  MAX_SCAN_ATTEMPTS_PER_IP_PER_HOUR: 20,
  MAX_CHAT_PER_IP_PER_HOUR: 30,
  MAX_TTS_PER_IP_PER_HOUR: 20,
  MAX_TRANSCRIBE_PER_IP_PER_HOUR: 20,
  MAX_CONCURRENT_SCANS_GLOBAL: 5,
  MAX_CONCURRENT_SCANS_PER_IP: 2,
  MAX_QUEUE_LENGTH: 10,
  REPORT_RETENTION_DAYS: 30,
  MAX_SAMPLED_IMAGES_HEAD: 15,
  MAX_FINDINGS_DISPLAYED_PER_CATEGORY: 5,
  MAX_SITEMAP_URLS: 200,
  MAX_PASSIVE_JS_FILES: 3,
  BOT_USER_AGENT,
  RULESET_VERSION: '2.1.0',
  HIGH_PROFILE_DOMAINS: [
    'google.com',
    'facebook.com',
    'instagram.com',
    'youtube.com',
    'amazon.com',
    'x.com',
    'wikipedia.org',
    'microsoft.com',
    'apple.com',
  ] as const,
} as const;

export const HIGH_PROFILE_DOMAINS = SCAN_LIMITS.HIGH_PROFILE_DOMAINS;

export const HIGH_PROFILE_NOTICE_AR =
  'الموقع ده بيحميه نظام ضد البوتات، والنتايج قد لا تمثل تجربة الزائر';

export const DEVELOPER_CONTACT = {
  LINKEDIN_URL: 'https://www.linkedin.com/in/mo7amadsultan/',
  DEVELOPER_NAME_AR: 'محمد سلطان',
  FULL_NAME_AR: 'م. محمد سلطان'
} as const;

export const OFFICIAL_LINKEDIN_URL = DEVELOPER_CONTACT.LINKEDIN_URL;

export const FEATURE_FLAGS = {
  SHOW_METHODOLOGY_PANEL: false,
  SHOW_MOCK_SAMPLE_BUTTONS: false,
  SHOW_LANDING_EXAMPLES: false,
  SHOW_VOICE_TEASER: false
} as const;

export function isHighProfileDomain(domainOrUrl?: string | null): boolean {
  if (!domainOrUrl) return false;
  let host = domainOrUrl.trim().toLowerCase();
  try {
    if (host.includes('://')) {
      host = new URL(host).hostname.toLowerCase();
    } else {
      host = host.split('/')[0].split(':')[0];
    }
  } catch {
    host = host.split('/')[0].split(':')[0];
  }
  host = host.replace(/^www\./, '');
  return HIGH_PROFILE_DOMAINS.some(
    (hp) => host === hp || host.endsWith(`.${hp}`)
  );
}


