import { formatBidiDate } from './bidi';

const LATN_LOCALE = 'ar-EG-u-nu-latn';

function sanitizeIndicDigits(input: string): string {
  return input.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  if (!Number.isFinite(value)) return '0';
  const formatted = new Intl.NumberFormat(LATN_LOCALE, {
    numberingSystem: 'latn',
    ...options,
  } as Intl.NumberFormatOptions).format(value);
  return sanitizeIndicDigits(formatted);
}

export function formatDate(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!options) {
    return formatBidiDate(value);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  const formatted = new Intl.DateTimeFormat(LATN_LOCALE, {
    numberingSystem: 'latn',
    ...options,
  } as Intl.DateTimeFormatOptions).format(date);
  return sanitizeIndicDigits(formatted);
}

export function formatTime(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  const defaultOptions: Intl.DateTimeFormatOptions = options || {
    hour: '2-digit',
    minute: '2-digit',
  };
  const formatted = new Intl.DateTimeFormat(LATN_LOCALE, {
    numberingSystem: 'latn',
    ...defaultOptions,
  } as Intl.DateTimeFormatOptions).format(date);
  return sanitizeIndicDigits(formatted);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) {
    return `${formatNumber(Math.round(ms))} مللي ثانية`;
  }
  const seconds = ms / 1000;
  return `${formatNumber(Number(seconds.toFixed(1)), { maximumFractionDigits: 1 })} ثانية`;
}

const GENERIC_PLACEHOLDER_TEXTS = new Set([
  'بدون نص ظاهر',
  'المحتوى الرئيسي',
  'المحتوى الرئيسي للصفحة',
  'أعلى الصفحة (لا يوجد نص مرئي محدد)',
  'الهيدر',
  'الفوتر',
  'القايمة',
  'رأس الصفحة (<head>)',
  'عنصر LCP الرئيسي',
  'أكبر عنصر مرئي في الشاشة (LCP)',
  'وصف الصفحة (meta description)'
]);

export function hasRealVisibleText(visibleText?: string): boolean {
  if (!visibleText) return false;
  const cleaned = visibleText
    .replace(/^«|»$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 2 || GENERIC_PLACEHOLDER_TEXTS.has(cleaned)) {
    return false;
  }
  if (/^استجابة السيرفر|^صورة كبيرة/i.test(cleaned)) {
    return false;
  }
  return true;
}

export function buildTextFragmentUrl(
  pageUrl?: string,
  visibleText?: string
): string | null {
  if (!pageUrl || !hasRealVisibleText(visibleText)) return null;
  const cleaned = visibleText!
    .replace(/^«|»$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const snippet = cleaned.slice(0, 80).trim();
  if (!snippet) return null;
  const baseUrl = pageUrl.split('#')[0];
  return `${baseUrl}#:~:text=${encodeURIComponent(snippet)}`;
}

