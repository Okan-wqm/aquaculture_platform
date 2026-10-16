/**
 * Number, percent and month formatting for the finance console tables, in the
 * reader's locale (`useI18n().locale`).
 *
 * WHY here and not shared-ui's formatNumber/formatPercent: those default to
 * tr-TR and take a BCP-47 tag; the console tables follow the user's language,
 * and the design writes a variance with a true minus sign (U+2212) and an
 * explicit plus, which Intl spells differently per locale.
 */
import type { SupportedLocale } from '@aquaculture/shared-ui';

import type { LocalizedText } from './localizedText';

const INTL_LOCALE: Record<SupportedLocale, string> = { en: 'en-GB', tr: 'tr-TR' };

/** `4,200` / `4.200` — a whole amount, grouped. */
export function formatWhole(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 0 }).format(value);
}

/** `64.5` / `64,5` — one decimal, as the design's unit costs and outputs. */
export function formatOneDecimal(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/** `49%` / `%49` — a ratio (0.49) as a whole percent. */
export function formatRatio(ratio: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(ratio);
}

/** `+339` / `−40` — a signed whole amount with the typographic minus. */
export function formatSignedWhole(value: number, locale: SupportedLocale): string {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return `${sign}${formatWhole(Math.abs(rounded), locale)}`;
}

/** `₺47,840` / `₺47.840` — an amount in `currency` (ISO 4217) with its narrow symbol. */
export function formatMoney(
  value: number,
  currency: string,
  locale: SupportedLocale,
  fractionDigits = 0,
): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * `₺` for TRY, `€` for EUR — the narrow symbol a reader of `locale` writes for
 * `currency` (ISO 4217). Turkish column headers name the unit by its symbol
 * ("bin ₺"), where English names it by its code ("TRY thousand").
 */
export function currencySymbol(currency: string, locale: SupportedLocale): string {
  const symbol = new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  })
    .formatToParts(0)
    .find((part) => part.type === 'currency');
  // Intl writes a currency part for every well-formed code (one it has no
  // symbol for is spelled as the code) and throws above on a malformed one, so
  // a missing part is a broken runtime, not a case to render.
  if (symbol === undefined) throw new Error(`currencySymbol: no symbol for ${currency}`);
  return symbol.value;
}

/** `October 2026` / `Ekim 2026`; `month` is 1–12. */
export function formatMonthYear(year: number, month: number, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** `October` / `Ekim`; `month` is 1–12. */
export function formatMonth(year: number, month: number, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

/** The sample text in the reader's language. */
export function localized(text: LocalizedText, locale: SupportedLocale): string {
  return text[locale];
}
