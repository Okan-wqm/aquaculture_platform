/**
 * I18n Module Exports
 *
 * @see FE-HIGH-020, FE-HIGH-089
 */

export { I18nProvider, useI18n } from './I18nProvider';
export type { I18nProviderProps, I18nContextValue, SupportedLocale, MessageKey } from './I18nProvider';
export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isSupportedLocale,
  getStoredLocale,
  persistLocale,
  detectBrowserLocale,
  resolveInitialLocale,
  applyDocumentLocale,
} from './localePreference';

// Locale message maps (for testing or direct access)
export { en } from './locales/en';
export { tr } from './locales/tr';
