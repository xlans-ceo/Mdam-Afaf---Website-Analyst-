export type AiBuilderId =
  | 'lovable'
  | 'replit'
  | 'base44'
  | 'bolt'
  | 'v0'
  | 'emergent'
  | 'ai-studio';

export interface AiBuilderEntry {
  id: AiBuilderId;
  nameEn: string;
  nameAr: string;
  hostSuffixes: string[];
  signals: string[];
  publishHintAr?: string;
  headersNoteAr?: string;
  source?: string;
  verifiedAt?: string;
  verified: boolean;
  needsReview?: boolean;
}

export const DEFAULT_BUILDER_HEADERS_NOTE_AR =
  'اطلب من الأداة تضيف الهيدرز في طبقة السيرفر/الـ middleware، وتأكد إن المعاينة بتاعتها لسه شغالة';

export const AI_BUILDERS: readonly AiBuilderEntry[] = [
  {
    id: 'lovable',
    nameEn: 'Lovable',
    nameAr: 'Lovable',
    hostSuffixes: ['lovable.app'],
    signals: ['gpteng.co', 'lovable.app', 'lovable.dev'],
    publishHintAr: 'اضغط Publish من أعلى يمين Lovable ثم Update لنشر التعديلات على الرابط المنشور.',
    headersNoteAr: DEFAULT_BUILDER_HEADERS_NOTE_AR,
    source: 'https://docs.lovable.dev/features/deploy',
    verifiedAt: '2026-10-25',
    verified: true,
    needsReview: false,
  },
  {
    id: 'replit',
    nameEn: 'Replit',
    nameAr: 'Replit',
    hostSuffixes: [],
    signals: [],
    verified: false,
    needsReview: true,
  },
  {
    id: 'base44',
    nameEn: 'Base44',
    nameAr: 'Base44',
    hostSuffixes: [],
    signals: [],
    verified: false,
    needsReview: true,
  },
  {
    id: 'bolt',
    nameEn: 'Bolt',
    nameAr: 'Bolt',
    hostSuffixes: [],
    signals: [],
    verified: false,
    needsReview: true,
  },
  {
    id: 'v0',
    nameEn: 'v0',
    nameAr: 'v0',
    hostSuffixes: [],
    signals: [],
    verified: false,
    needsReview: true,
  },
  {
    id: 'emergent',
    nameEn: 'Emergent',
    nameAr: 'Emergent',
    hostSuffixes: [],
    signals: [],
    verified: false,
    needsReview: true,
  },
  {
    id: 'ai-studio',
    nameEn: 'AI Studio',
    nameAr: 'AI Studio',
    hostSuffixes: [],
    signals: [],
    verified: false,
    needsReview: true,
  },
];

export interface DetectedAiBuilder {
  entry: AiBuilderEntry;
  confidence: 'high' | 'medium';
  matchedBy: 'host_suffix' | 'signal';
  signalText: string;
}

/**
 * Detects an AI builder ONLY from entries with verified === true.
 * Entries with verified === false never drive visible claims.
 */
export function detectAiBuilder(url: string, html: string): DetectedAiBuilder | null {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    hostname = '';
  }

  const lowerHtml = (html || '').toLowerCase();

  for (const entry of AI_BUILDERS) {
    if (!entry.verified) continue;

    for (const suffix of entry.hostSuffixes) {
      const normalizedSuffix = suffix.toLowerCase().replace(/^\./, '');
      if (
        hostname === normalizedSuffix ||
        hostname.endsWith(`.${normalizedSuffix}`)
      ) {
        return {
          entry,
          confidence: 'high',
          matchedBy: 'host_suffix',
          signalText: `Builder host suffix matched: ${normalizedSuffix} (${entry.nameEn})`,
        };
      }
    }

    for (const sig of entry.signals) {
      const normalizedSig = sig.toLowerCase();
      if (normalizedSig && lowerHtml.includes(normalizedSig)) {
        return {
          entry,
          confidence: 'medium',
          matchedBy: 'signal',
          signalText: `Builder HTML signal matched: ${normalizedSig} (${entry.nameEn})`,
        };
      }
    }
  }

  return null;
}

/**
 * Checks whether a URL's hostname belongs to a verified builder-hosted staging domain.
 */
export function isVerifiedBuilderHostedUrl(url: string): { isBuilderHosted: boolean; host: string; entry?: AiBuilderEntry } {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return { isBuilderHosted: false, host: '' };
  }

  for (const entry of AI_BUILDERS) {
    if (!entry.verified) continue;
    for (const suffix of entry.hostSuffixes) {
      const normalizedSuffix = suffix.toLowerCase().replace(/^\./, '');
      if (hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`)) {
        return { isBuilderHosted: true, host: hostname, entry };
      }
    }
  }

  return { isBuilderHosted: false, host: hostname };
}

export function getVerifiedAiBuilderById(id?: string | null): AiBuilderEntry | undefined {
  if (!id) return undefined;
  return AI_BUILDERS.find((b) => b.id === id && b.verified);
}
