/**
 * Locale-aware formatting for the command log.
 *
 * WHY not shared-ui's formatDateTime: it pins Europe/Istanbul and a Turkish
 * locale, and drops seconds. A command trail is read against the operator's
 * own wall clock and, when two commands land in the same minute, by the
 * second. The locale's Intl tag comes from shared-ui (toIntlLocale), the one
 * owner of that map.
 */
import { toIntlLocale, type SupportedLocale } from '@aquaculture/shared-ui';

/** The design's minus sign (U+2212): a hyphen reads as a dash beside a figure. */
const MINUS_SIGN = '−';

/** An ISO timestamp as "16 Oct, 10:12:04" in the browser's zone. */
export function formatCommandTime(timestamp: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

/** A command value, up to three decimals ("42.5", "42,5", "−3.2"). */
export function formatCommandNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(toIntlLocale(locale), { maximumFractionDigits: 3 })
    .formatToParts(value)
    .map((part) => (part.type === 'minusSign' ? MINUS_SIGN : part.value))
    .join('');
}
