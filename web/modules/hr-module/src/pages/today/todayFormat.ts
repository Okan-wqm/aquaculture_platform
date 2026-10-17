/**
 * Locale-aware formatting for the Today page.
 *
 * WHY not shared-ui's formatTime: it pins Europe/Istanbul, while this page
 * computes "today" and shift starts in the browser's own zone (formatDateISO /
 * getWeekMonday); a clock-in must be shown in that same zone or a late arrival
 * would read as on time. Both locales render a 24-hour clock (en-GB, tr-TR).
 */
import type { SupportedLocale } from '@aquaculture/shared-ui';

const INTL_LOCALE: Record<SupportedLocale, string> = { en: 'en-GB', tr: 'tr-TR' };

/** A timestamp as local `HH:mm`. */
export function formatClock(timestamp: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

/**
 * A calendar day sent as a GraphQL DateTime, as a short day and month.
 *
 * WHY UTC: hr-service exposes `date` columns (a leave's start / end) through
 * the DateTime scalar as the stored day at UTC midnight (DateColumnTransformer),
 * e.g. `2026-10-12T00:00:00.000Z`. Read in UTC that is the stored day; read in
 * the browser's zone it would turn into the previous day west of UTC.
 */
export function formatCalendarDay(dateTime: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(dateTime));
}

export function formatCount(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale]).format(value);
}

/** Up to two initials for the roster's name square. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
