// Display formatters. All Turkish-locale, all tolerant of null so callers never
// render `undefined`; the em dash is the single "no value" glyph everywhere.
export const EMPTY = '—';

const numberFormat = new Intl.NumberFormat('tr-TR');
const percentFormat = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 0 });
const relativeFormat = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });

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

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return EMPTY;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} sn`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) {
    return `${minutes} dk ${rest} sn`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} sa ${minutes % 60} dk`;
}

export function parseIso(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Relative wording ("3 dakika önce", "2 gün sonra") from an ISO string against `now`. */
export function formatRelative(value: string | null | undefined, now: number): string {
  const date = parseIso(value);
  if (date === null) {
    return EMPTY;
  }
  const deltaSeconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) {
    return deltaSeconds <= 0 ? 'az önce' : 'birkaç saniye içinde';
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
    return '[serileştirilemedi]';
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
    return '[serileştirilemedi]';
  }
}
