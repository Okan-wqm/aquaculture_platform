/**
 * Locale preference — where the UI language comes from (FE-HIGH-089).
 *
 * Resolution order, first hit wins:
 *   1. the account's `preferredLanguage`, applied on sign-in by the shell
 *      (it follows the user across devices);
 *   2. the device preference this module stores, so the auth pages and a
 *      reload before the account loads already speak the user's language;
 *   3. the browser's language;
 *   4. Turkish — the platform's tenant-facing default.
 *
 * The same key and values are read by AquaMobil's mirror provider.
 */

export type SupportedLocale = 'en' | 'tr';

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['tr', 'en'];
export const DEFAULT_LOCALE: SupportedLocale = 'tr';
export const LOCALE_STORAGE_KEY = 'suderra.locale';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** The device preference, or null when none is stored or storage is unavailable. */
export function getStoredLocale(): SupportedLocale | null {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : null;
  } catch {
    // localStorage can be unavailable in private browsing or SSR-like tests.
    return null;
  }
}

export function persistLocale(locale: SupportedLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory selection still applies for this page lifetime.
  }
}

/** The browser's language when it is one the platform ships, else the default. */
export function detectBrowserLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  const language = navigator.language.split('-')[0]?.toLowerCase();
  return isSupportedLocale(language) ? language : DEFAULT_LOCALE;
}

/** Steps 2–4 of the resolution order; step 1 is the account, applied after sign-in. */
export function resolveInitialLocale(): SupportedLocale {
  return getStoredLocale() ?? detectBrowserLocale();
}

/** `<html lang>` follows the active locale so assistive technology and hyphenation do too. */
export function applyDocumentLocale(locale: SupportedLocale): void {
  document.documentElement.lang = locale;
}
