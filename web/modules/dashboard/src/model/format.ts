/**
 * Locale formatting for the module dashboards.
 *
 * WHY one place: every dashboard cell writes numbers, clock times and ages in
 * the viewer's language (Turkish decimal comma, `%62`), and a site's day is
 * the site's own: a plan date read in the browser's zone would be yesterday's
 * or tomorrow's plan for a site in another time zone.
 */
import type { SupportedLocale } from '@aquaculture/shared-ui';

const INTL_LOCALE: Readonly<Record<SupportedLocale, string>> = { en: 'en-GB', tr: 'tr-TR' };

export function intlLocale(locale: SupportedLocale): string {
  return INTL_LOCALE[locale];
}

/** A number with exactly `digits` decimals in the viewer's notation. */
export function formatDecimal(value: number, digits: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** The wall-clock time of `at` (hh:mm), in the viewer's zone. */
export function formatClock(at: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

/** How long ago `at` was, relative to `now` ("47 min ago" / "47 dk önce"). */
export function formatAge(at: Date, now: Date, locale: SupportedLocale): string {
  const seconds = Math.round((at.getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: 'auto',
    style: 'short',
  });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

/**
 * The calendar date (YYYY-MM-DD) `at` falls on in `timeZone` — a site's local
 * day, which its feeding day plans are keyed by. An unknown or absent zone
 * reads as UTC, the platform's default for a site without one.
 */
export function localDateIn(at: Date, timeZone: string | null | undefined): string {
  const zone = timeZone ?? 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
  } catch {
    return localDateIn(at, 'UTC');
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
