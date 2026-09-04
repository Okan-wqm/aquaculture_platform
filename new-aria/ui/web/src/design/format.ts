// Display formatters.
//
// WHY: the document is lang="en" and the console is read by engineers and
// lawyers in en-GB, so every number, percentage and relative phrase is formatted
// once here rather than per page. Every formatter tolerates null so a caller can
// never render `undefined`, and the em dash is the single "no value" glyph.
// WHAT: pure functions over Intl, plus small text helpers for hashes and JSON.
export const EMPTY = '—';

const LOCALE = 'en-GB';
const numberFormat = new Intl.NumberFormat(LOCALE);
const percentFormat = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 });
const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? EMPTY : numberFormat.format(value);
}

export function formatPercent(fraction: number | null | undefined): string {
  return fraction === null || fraction === undefined || Number.isNaN(fraction) ? EMPTY : percentFormat.format(fraction);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return EMPTY;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? 'B';
  return `${value >= 100 || unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1)} ${unit}`;
}

/** Durations read as `12s`, `4m 12s`, `2h 30m` — compact enough for a table cell. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return EMPTY;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return `${minutes}m ${restSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function parseIso(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Relative wording ("3 minutes ago", "in 2 days") from an ISO string against `now`. */
export function formatRelative(value: string | null | undefined, now: number): string {
  const date = parseIso(value);
  if (date === null) {
    return EMPTY;
  }
  const deltaSeconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) {
    return deltaSeconds <= 0 ? 'just now' : 'in a few seconds';
  }
  if (abs < 3600) {
    return relativeFormat.format(Math.round(deltaSeconds / 60), 'minute');
  }
  if (abs < 86400) {
    return relativeFormat.format(Math.round(deltaSeconds / 3600), 'hour');
  }
  if (abs < 86400 * 30) {
    return relativeFormat.format(Math.round(deltaSeconds / 86400), 'day');
  }
  if (abs < 86400 * 365) {
    return relativeFormat.format(Math.round(deltaSeconds / (86400 * 30)), 'month');
  }
  return relativeFormat.format(Math.round(deltaSeconds / (86400 * 365)), 'year');
}

/** Calendar day only (`4 Sep 2026`), for legal dates where the clock is noise. */
export function formatDay(value: string | null | undefined): string {
  const date = parseIso(value);
  if (date === null) {
    return EMPTY;
  }
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function shortHash(value: string | null | undefined, length = 12): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY;
  }
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function textOrEmpty(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EMPTY;
  }
  return String(value);
}

/** Compact one-line JSON for table cells; objects are never rendered as "[object Object]". */
export function compactJson(value: unknown, maxLength = 160): string {
  if (value === undefined) {
    return EMPTY;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return EMPTY;
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return '[unserialisable]';
  }
}

export function prettyJson(value: unknown): string {
  if (value === undefined) {
    return EMPTY;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? EMPTY : text;
  } catch {
    return '[unserialisable]';
  }
}
