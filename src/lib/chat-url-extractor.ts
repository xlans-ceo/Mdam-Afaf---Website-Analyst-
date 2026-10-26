import { parse as parseTld } from 'tldts';
import { getRegistrableDomain } from './domain-parser';

/**
 * File extensions that must never be mistaken for website domains when mentioned in text.
 */
const BANNED_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
  'avif',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'lock',
  'log',
  'sql',
  'db',
  'sqlite',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'wasm',
  'map',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'avi',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'rar',
  '7z',
  'tar',
  'gz',
  'exe',
  'dll',
  'dmg',
  'apk',
  'ipa'
]);

/**
 * Extensions that are valid ICANN TLDs (.zip, .mov, .md, .sh, .py, .rs, .go, .php)
 * but represent files when typed as bare 2-part tokens without http(s):// in chat.
 */
const BARE_FILENAME_TLDS = new Set([
  'zip',
  'mov',
  'md',
  'sh',
  'py',
  'rs',
  'go',
  'rb',
  'php',
  'java',
  'c',
  'cpp',
  'cs',
  'kt',
  'swift'
]);

const ZERO_WIDTH_AND_BIDI_REGEX = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const LEADING_PUNCTUATION_REGEX = /^[.,!?;:،؛؟"'«»()[\]{}<>/\\]+/;
const TRAILING_PUNCTUATION_REGEX = /[.,!?;:،؛؟"'«»()[\]{}<>]+$/;

export function stripSurroundingPunctuation(token: string): string {
  return token
    .replace(ZERO_WIDTH_AND_BIDI_REGEX, '')
    .trim()
    .replace(LEADING_PUNCTUATION_REGEX, '')
    .replace(TRAILING_PUNCTUATION_REGEX, '')
    .trim();
}

/**
 * Converts spoken domain suffixes from voice input (e.g., "elabyad-eg دوت كوم" or "example dot com")
 * into standard dot-separated domains before tokenizing.
 */
function normalizeSpokenDomains(input: string): string {
  return input
    .replace(ZERO_WIDTH_AND_BIDI_REGEX, '')
    .replace(
      /\b([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])\s+(?:دوت|نقطة|dot)\s+(?:كوم|com)\s+(?:دوت|نقطة|dot)\s+(?:اي\s*جي|إي\s*جي|eg)(?=$|[\s.,!?;:،؛؟"'«»()[\]{}])/gi,
      '$1.com.eg'
    )
    .replace(
      /\b([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])\s+(?:دوت|نقطة|dot)\s+(?:كوم|com)(?=$|[\s.,!?;:،؛؟"'«»()[\]{}])/gi,
      '$1.com'
    )
    .replace(
      /\b([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])\s+(?:دوت|نقطة|dot)\s+(?:نت|net)(?=$|[\s.,!?;:،؛؟"'«»()[\]{}])/gi,
      '$1.net'
    )
    .replace(
      /\b([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])\s+(?:دوت|نقطة|dot)\s+(?:اورج|أورج|org)(?=$|[\s.,!?;:،؛؟"'«»()[\]{}])/gi,
      '$1.org'
    )
    .replace(
      /\b([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])\s+(?:دوت|نقطة|dot)\s+(?:اي\s*جي|إي\s*جي|eg)(?=$|[\s.,!?;:،؛؟"'«»()[\]{}])/gi,
      '$1.eg'
    );
}

export function validateAndNormalizeCandidateUrl(
  rawUrl: string,
  hasExplicitProtocol = true
): string | null {
  try {
    const cleanedRaw = rawUrl.replace(ZERO_WIDTH_AND_BIDI_REGEX, '').trim();
    const parsed = new URL(cleanedRaw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('.')) return null;
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return null;

    const lastLabel = parts[parts.length - 1];
    if (lastLabel.length < 2) return null;
    if (host === 'localhost' || host.endsWith('.local')) return null;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
    if (host.startsWith('[') || host.includes(':')) return null;

    // Reject version-like tokens (e.g. v2.0.0)
    if (parts.every(p => /^v?\d+$/i.test(p))) return null;

    // Reject non-domain file extensions
    if (BANNED_FILE_EXTENSIONS.has(lastLabel)) return null;
    if (!hasExplicitProtocol && BARE_FILENAME_TLDS.has(lastLabel)) {
      return null;
    }

    // Verify with tldts that the suffix is a known ICANN TLD (or `.test` in unit tests when explicit http/https)
    const tldInfo = parseTld(host);
    if (!tldInfo.isIcann && !(hasExplicitProtocol && lastLabel === 'test')) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export interface ExtractedChatUrlResult {
  url: string | null;
  allUrls: string[];
  registrableDomain: string | null;
}

/**
 * Extracts all valid public website URLs from a free-text Arabic/English chat or voice message.
 */
export function extractChatUrl(message: string): ExtractedChatUrlResult {
  if (!message || typeof message !== 'string') {
    return { url: null, allUrls: [], registrableDomain: null };
  }

  const normalizedMessage = normalizeSpokenDomains(message.trim());
  const seen = new Set<string>();
  const allUrls: string[] = [];

  const addIfValid = (candidateUrl: string) => {
    if (!seen.has(candidateUrl)) {
      seen.add(candidateUrl);
      allUrls.push(candidateUrl);
    }
  };

  // 1. Check for explicit http:// or https:// URLs
  const explicitUrlRegex = /(https?:\/\/[^\s"'<>،؛؟«»()[\]{}]+)/gi;
  for (const match of normalizedMessage.matchAll(explicitUrlRegex)) {
    const candidate = stripSurroundingPunctuation(match[1]);
    const validated = validateAndNormalizeCandidateUrl(candidate, true);
    if (validated) {
      addIfValid(validated);
    }
  }

  // 2. Check for bare domain names (e.g. "example.com", "www.mysite.com/store", "vodafone.com.eg")
  const tokens = normalizedMessage.split(/[\s،؛؟"'«»<>()[\]{}]+/);
  for (const rawToken of tokens) {
    const token = stripSurroundingPunctuation(rawToken);
    if (!token || token.includes('@')) continue;

    if (
      /^(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z0-9-]+)*(?:\/[^\s]*)?$/i.test(
        token
      )
    ) {
      const hasExplicitProtocol = /^https?:\/\//i.test(token);
      const withProtocol = hasExplicitProtocol ? token : `https://${token}`;
      const validated = validateAndNormalizeCandidateUrl(withProtocol, hasExplicitProtocol);
      if (validated) {
        addIfValid(validated);
      }
    }
  }

  const primaryUrl = allUrls[0] ?? null;
  const registrableDomain = primaryUrl ? getRegistrableDomain(primaryUrl) || null : null;

  return {
    url: primaryUrl,
    allUrls,
    registrableDomain
  };
}

export function extractUrlFromMessage(message: string): string | null {
  return extractChatUrl(message).url;
}
