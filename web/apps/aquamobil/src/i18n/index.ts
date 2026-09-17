/**
 * AquaMobil i18n modülü (P-28, Faz 6) — shared-ui i18n API'sinin kod kopyası
 * (aquamobil bağımsız PWA; shared-ui import edemez — tenant-query-keys emsali).
 */
export { I18nProvider, useI18n } from './I18nProvider';
export type {
  I18nProviderProps,
  I18nContextValue,
  SupportedLocale,
  MessageKey,
} from './I18nProvider';
export { en } from './locales/en';
export { tr } from './locales/tr';
