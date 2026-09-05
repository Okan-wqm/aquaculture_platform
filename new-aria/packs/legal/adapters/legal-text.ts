// Legal Case Intelligence pack — mechanical text parsers.
//
// WHY: everything the inventory adapter "understands" about a file is a
// deterministic string function — dates, amounts, filename kind hints,
// version markers, RFC 822 headers. Keeping them in one dependency-free module
// makes each rule unit-testable and keeps the inventory module about fates,
// ids and artifacts instead of regexes.
//
// WHAT: classification tables (extension → fate / media type), date and
// amount extraction, kind guessing, stem normalisation, Jaccard, and a small
// RFC 822 parser (headers, address lists, Date header).
import { createHash } from 'node:crypto';

import type { LegalRecordKind } from './legal-records';

// ---------------------------------------------------------------------------
// Classification tables. Extension → fate is a closed table on purpose: a
// format not listed here is hashed and inventoried as `metadata_only` with
// kindGuess UNKNOWN, never silently skipped.
// ---------------------------------------------------------------------------
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.txt', '.md', '.csv', '.json', '.eml', '.html', '.htm']);
export const METADATA_ONLY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.msg',
]);
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.eml': 'message/rfc822',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.msg': 'application/vnd.ms-outlook',
};

// Filename tokens → kind guess. Token match (not substring) so `random` never
// hits `dom` and `kingdom` never becomes a DECISION. Confidence ≤ 0.6 always:
// a filename is a hint, and every guess stays a guess until a human confirms.
const KIND_TOKEN_RULES: ReadonlyArray<{ readonly tokens: ReadonlySet<string>; readonly kind: LegalRecordKind; readonly confidence: number }> = [
  { tokens: new Set(['dom', 'kjennelse', 'decision', 'judgment', 'judgement']), kind: 'DECISION', confidence: 0.5 },
  { tokens: new Set(['klage', 'anke', 'appeal']), kind: 'PROCEDURAL_STEP', confidence: 0.5 },
  { tokens: new Set(['faktura', 'invoice', 'krav']), kind: 'FINANCIAL_LOSS', confidence: 0.5 },
];

// Version markers stripped from a stem before grouping. `(1)`-style copy
// markers are removed as a unit BEFORE tokenising so invoice numbers such as
// `faktura_2024-001` keep their digits and never collapse into one group.
const VERSION_WORD_MARKERS: ReadonlySet<string> = new Set(['final', 'kopi', 'copy', 'signert', 'signed', 'utkast', 'draft']);
const SIGNED_MARKERS: ReadonlySet<string> = new Set(['signert', 'signed']);
const VERSION_NUMBER_RE = /^v(\d+)$/;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, januar: 1, january: 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, mars: 3, march: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10, oct: 10, october: 10,
  nov: 11, november: 11,
  des: 12, desember: 12, dec: 12, december: 12,
};
const MONTH_ALTERNATION = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  .join('|');
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const DOT_DATE_RE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g;
const SLASH_DATE_RE = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g;
const DAY_MONTH_YEAR_RE = new RegExp(`(?<![\\d\\p{L}])(\\d{1,2})\\.?\\s+(${MONTH_ALTERNATION})\\.?,?\\s+(\\d{4})(?!\\d)`, 'giu');
const MONTH_DAY_YEAR_RE = new RegExp(`(?<!\\p{L})(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'giu');
// A month named with its year and no day ("i mars 2024", "March 2024"). Bare
// years are deliberately NOT matched: `faktura_2024-001` and every reference
// number in an archive would become a date, and a chronology full of invented
// entries is worse than one with gaps it declares.
const MONTH_YEAR_RE = new RegExp(`(?<![\\d\\p{L}])(${MONTH_ALTERNATION})\\.?\\s+(\\d{4})(?!\\d)`, 'giu');
const ISO_MONTH_RE = /(?<![\d-])(\d{4})-(\d{2})(?![\d-])/g;

// One combined amount regex so each span is consumed once (`kr 25 000,-` is
// one mention, not a prefix hit plus a `,-` suffix hit).
const NUMBER_SRC = '(?:\\d{1,3}(?:[ .,\\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const AMOUNT_RE = new RegExp(
  `(?<![\\p{L}\\d])(?:kr\\.?|nok|eur|usd|€|\\$)\\s?${NUMBER_SRC}(?:,-)?(?![\\d\\p{L}])` +
    `|(?<![\\d\\p{L}])${NUMBER_SRC}\\s?(?:kr\\.?|nok|eur|usd|€|\\$|,-)(?![\\d\\p{L}])`,
  'giu',
);

// The zone token is captured as ANY non-space run and classified afterwards:
// an optional alternation would let an unknown name (`CEST`) fall through
// unmatched and be read as UTC — a wrong time reported with day precision
// is exactly the silent drift a chronology cannot afford.
const RFC2822_DATE_RE = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(\S+))?)?/;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
export function sha256Hex(payload: string | Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

export function collapseWhitespace(text: string): string {
  return text.replace(/[\s ]+/g, ' ').trim();
}

export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** How exactly a mention pins a point in time. A day is never inferred from a month. */
export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';

export interface DatedMention {
  /** ISO 8601 truncated to the precision actually stated: 2024-03-12, 2024-03, 2024. */
  readonly value: string;
  readonly precision: DatePrecision;
}

/**
 * Every date a text states, with the precision it stated it at.
 *
 * Day-precision mentions win over a month mention covering the same month, so
 * "12. mars 2024" does not also produce a bare "2024-03" row. This is the
 * function the chronology uses; `extractDates` stays the day-only view the
 * document record carries.
 */
export function extractDatedMentions(text: string): DatedMention[] {
  const days = extractDates(text);
  const covered = new Set(days.map((day) => day.slice(0, 7)));
  const months: string[] = [];
  for (const match of text.matchAll(MONTH_YEAR_RE)) {
    const month = MONTHS[(match[1] ?? '').toLowerCase()];
    const year = Number(match[2]);
    if (month === undefined || !Number.isInteger(year)) continue;
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
  }
  for (const match of text.matchAll(ISO_MONTH_RE)) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;
    months.push(`${match[1]}-${String(month).padStart(2, '0')}`);
  }
  const monthMentions = uniqueSorted(months.filter((month) => !covered.has(month)));
  return [
    ...days.map((value): DatedMention => ({ value, precision: 'day' })),
    ...monthMentions.map((value): DatedMention => ({ value, precision: 'month' })),
  ].sort((a, b) => byteCompare(a.value, b.value));
}

export function extractDates(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ISO_DATE_RE)) {
    const value = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value) found.push(value);
  }
  for (const re of [DOT_DATE_RE, SLASH_DATE_RE]) {
    for (const match of text.matchAll(re)) {
      const value = isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
      if (value) found.push(value);
    }
  }
  for (const match of text.matchAll(DAY_MONTH_YEAR_RE)) {
    const month = MONTHS[(match[2] ?? '').toLowerCase()];
    const value = month === undefined ? null : isoDate(Number(match[3]), month, Number(match[1]));
    if (value) found.push(value);
  }
  for (const match of text.matchAll(MONTH_DAY_YEAR_RE)) {
    const month = MONTHS[(match[1] ?? '').toLowerCase()];
    const value = month === undefined ? null : isoDate(Number(match[3]), month, Number(match[2]));
    if (value) found.push(value);
  }
  return uniqueSorted(found);
}

/**
 * Reduces a stated amount to a comparable value: currency (when written) plus
 * the number in plain decimal form.
 *
 * "kr 1.250.000,50", "NOK 1 250 000,50" and "1250000,50 kr" are the same
 * amount written three ways, and a contradiction check that compared the
 * strings would report a disagreement between a document and itself. Grouping
 * separators are dropped, a decimal comma becomes a point, and the currency is
 * kept because 25 000 NOK and 25 000 EUR are NOT the same amount.
 */
export function normalizeAmount(raw: string): string {
  const lower = raw.toLowerCase().replace(/\u00a0/g, ' ');
  const currencyMatch = /(kr|nok|eur|usd|€|\$)/.exec(lower);
  const currency = currencyMatch === null ? '' : currencyMatch[1] === 'kr' ? 'nok' : (currencyMatch[1] ?? '');
  const digits = lower.replace(/[^\d.,]/g, '');
  // The last separator followed by exactly one or two digits is the decimal
  // point; every other separator groups thousands.
  const decimal = /[.,](\d{1,2})$/.exec(digits);
  const whole = (decimal === null ? digits : digits.slice(0, decimal.index)).replace(/[.,]/g, '');
  const fraction = decimal === null ? '' : `.${(decimal[1] ?? '').padEnd(2, '0')}`;
  const number = `${whole === '' ? '0' : whole}${fraction}`;
  return currency === '' ? number : `${currency} ${number}`;
}

export function extractAmounts(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(AMOUNT_RE)) {
    found.push(collapseWhitespace(match[0]));
  }
  return uniqueSorted(found);
}

export function guessKind(fileName: string): { readonly kind: LegalRecordKind | 'UNKNOWN'; readonly confidence: number } {
  const extension = extensionOf(fileName);
  if (extension === '.eml' || extension === '.msg') {
    return { kind: 'COMMUNICATION', confidence: 0.6 };
  }
  const tokens = new Set(tokensOf(stemOf(fileName)));
  for (const rule of KIND_TOKEN_RULES) {
    for (const token of tokens) {
      if (rule.tokens.has(token)) {
        return { kind: rule.kind, confidence: rule.confidence };
      }
    }
  }
  if (TEXT_EXTENSIONS.has(extension) || METADATA_ONLY_EXTENSIONS.has(extension)) {
    return { kind: 'DOCUMENT', confidence: 0.3 };
  }
  return { kind: 'UNKNOWN', confidence: 0 };
}

/** Stem with version/copy markers removed; falls back to the raw stem when nothing survives. */
export function normalizedStem(fileName: string): string {
  const raw = stemOf(fileName).toLowerCase();
  const withoutCopyMarker = raw.replace(/\(\d+\)/g, ' ');
  const kept = tokensOf(withoutCopyMarker).filter(
    (token) => !VERSION_WORD_MARKERS.has(token) && !VERSION_NUMBER_RE.test(token),
  );
  return kept.length > 0 ? kept.join(' ') : tokensOf(raw).join(' ') || raw;
}

export function versionNumberOf(fileName: string): number | null {
  for (const token of tokensOf(stemOf(fileName))) {
    const match = VERSION_NUMBER_RE.exec(token);
    if (match) return Number(match[1]);
  }
  return null;
}

export function isSignedName(fileName: string): boolean {
  return tokensOf(stemOf(fileName)).some((token) => SIGNED_MARKERS.has(token));
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  return intersection / union.size;
}

// ---------------------------------------------------------------------------
// RFC 822 mail parsing (headers only + body text). Deterministic, no library.
// ---------------------------------------------------------------------------
export interface ParsedEmail {
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
}

export function parseEmail(text: string): ParsedEmail {
  const lines = text.split(/\r?\n/);
  const headers = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;
  let index = 0;
  const flush = (): void => {
    if (current) {
      const list = headers.get(current.name) ?? [];
      list.push(current.value.trim());
      headers.set(current.name, list);
      current = null;
    }
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line === '') {
      index += 1;
      break;
    }
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    const match = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!match) {
      break;
    }
    flush();
    current = { name: (match[1] ?? '').toLowerCase(), value: match[2] ?? '' };
  }
  flush();
  return { headers, body: lines.slice(index).join('\n') };
}

export interface MailAddress {
  readonly displayName: string | null;
  readonly address: string;
}

export function parseAddressList(value: string): MailAddress[] {
  const parts: string[] = [];
  let depthAngle = 0;
  let inQuotes = false;
  let buffer = '';
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === '<') depthAngle += 1;
    else if (!inQuotes && char === '>') depthAngle = Math.max(0, depthAngle - 1);
    if (char === ',' && !inQuotes && depthAngle === 0) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  const result: MailAddress[] = [];
  for (const part of parts) {
    const withName = /^\s*(?:"([^"]*)"|([^<"]*?))\s*<([^>]+)>\s*$/.exec(part);
    if (withName) {
      const name = (withName[1] ?? withName[2] ?? '').trim();
      const address = (withName[3] ?? '').trim().toLowerCase();
      if (/^[^\s@<>]+@[^\s@<>]+$/.test(address)) {
        result.push({ displayName: name.length > 0 ? name : null, address });
      }
      continue;
    }
    const bare = part.trim().toLowerCase();
    if (/^[^\s@<>]+@[^\s@<>]+$/.test(bare)) {
      result.push({ displayName: null, address: bare });
    }
  }
  return result;
}

/** RFC 2822 `Date:` → ISO 8601 UTC. Numeric offsets and GMT/UTC/Z are honoured; anything else keeps the day only. */
export function parseRfc2822Date(value: string): { readonly iso: string; readonly precision: 'day' } | null {
  const match = RFC2822_DATE_RE.exec(value);
  if (!match) return null;
  const month = MONTHS[(match[2] ?? '').toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  const date = isoDate(year, month, day);
  if (!date) return null;
  if (match[4] === undefined) {
    return { iso: date, precision: 'day' };
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const zone = match[7] ?? '';
  let offsetMinutes = 0;
  if (/^[+-]\d{4}$/.test(zone)) {
    const sign = zone.startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  } else if (!/^(UTC?|GMT|Z)$/.test(zone)) {
    // Missing or named zone (CEST, EST, …): the instant is not knowable
    // without a table nobody in the corpus vouches for → keep the day only.
    return { iso: date, precision: 'day' };
  }
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return { iso: new Date(utcMillis).toISOString().replace(/\.000Z$/, 'Z'), precision: 'day' };
}

