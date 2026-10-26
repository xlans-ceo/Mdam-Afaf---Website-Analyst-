/**
 * Bidi Unicode Isolates and Directional Layout Utilities (Section 4 & PHASE K1.3)
 *
 * Rules:
 * - Wrap every Latin/number run inside Arabic strings with Unicode isolates (U+2066..U+2069).
 * - "80/100" reads strictly 80/100, not 100/80 in RTL.
 * - Dates format as: "24 أكتوبر 2026 — 10:57 ص" (or "م").
 * - Avoid parentheses around standalone numbers.
 * - Titles like "(LCP = 4.2) ثانية" become "بطء ظهور المحتوى الرئيسي على الموبايل: 4.2 ثانية (LCP)".
 */

export const LRI = '\u2066'; // Left-to-Right Isolate
export const RLI = '\u2067'; // Right-to-Left Isolate
export const FSI = '\u2068'; // First Strong Isolate
export const PDI = '\u2069'; // Pop Directional Isolate

export function isolateLtr(text: string | number): string {
  if (text === null || text === undefined || text === '') return '';
  return `${LRI}${text}${PDI}`;
}

export function isolateRtl(text: string): string {
  if (!text) return '';
  return `${RLI}${text}${PDI}`;
}

export function isolateNumber(num: number | string): string {
  if (num === null || num === undefined) return '';
  return `${LRI}${num}${PDI}`;
}

export function formatScoreRatio(
  numerator: number | string,
  denominator: number | string = 100
): string {
  return `${LRI}${numerator}/${denominator}${PDI}`;
}

export function formatLcpTitleAr(lcpSec: string | number): string {
  return `بطء ظهور المحتوى الرئيسي على الموبايل: ${lcpSec} ثانية (LCP)`;
}

const ARABIC_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر'
];

export function formatBidiDate(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? '');

  const day = d.getDate();
  const monthName = ARABIC_MONTHS[d.getMonth()] || '';
  const year = d.getFullYear();

  let hours = d.getHours();
  const ampm = hours >= 12 ? 'م' : 'ص';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  const minutes = String(d.getMinutes()).padStart(2, '0');

  // Format: "24 أكتوبر 2026 — 10:57 ص"
  return `${isolateNumber(day)} ${monthName} ${isolateNumber(year)} — ${isolateNumber(`${hours}:${minutes}`)} ${ampm}`;
}
