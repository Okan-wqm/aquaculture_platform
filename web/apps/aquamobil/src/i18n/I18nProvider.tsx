/**
 * AquaMobil I18n Provider (P-28 — mobil i18n, Faz 6).
 *
 * shared-ui `I18nProvider`ının kod kopyasıdır (tenant-query-keys.ts emsali):
 * aquamobil bağımsız bir Vite PWA'dır ve `@aquaculture/shared-ui` import
 * EDEMEZ. API'si (typed `t()` + MessageKey) bilinçli olarak birebir aynıdır —
 * shared-ui sağlayıcısında davranış değişirse burası da güncellenir.
 *
 * Tipli `t()` yalnız bilinen MessageKey kabul eder: yeni yüzeylerde hardcoded
 * string yapısal olarak imkânsızdır (FE-HIGH-020 deseni).
 */
import { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';

import { en, type MessageKey } from './locales/en';
import { tr } from './locales/tr';

export type SupportedLocale = 'en' | 'tr';

export interface I18nContextValue {
  locale: SupportedLocale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const MESSAGES: Record<SupportedLocale, Record<MessageKey, string>> = { en, tr };

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export interface I18nProviderProps {
  /** Aktif dil. Verilmezse tarayıcıdan sezilir; platform varsayılanı Türkçedir. */
  locale?: SupportedLocale;
  children: ReactNode;
}

function detectLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'tr';
  const browserLang = navigator.language?.split('-')[0]?.toLowerCase();
  if (browserLang === 'en') return 'en';
  return 'tr';
}

function interpolate(message: string, vars?: Record<string, string | number>): string {
  if (!vars) return message;
  let result = message;
  for (const [varName, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${varName}\\}`, 'g'), String(value));
  }
  return result;
}

export function I18nProvider({ locale: localeProp, children }: I18nProviderProps): ReactNode {
  const locale = localeProp ?? detectLocale();
  const messages = MESSAGES[locale] ?? MESSAGES.tr;

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>): string =>
      interpolate(messages[key] ?? en[key] ?? key, vars),
    [messages],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * i18n bağlamı. Sağlayıcı takılı değilse (test ortamı) İngilizce'ye düşer —
 * shared-ui hook'uyla aynı sözleşme.
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context) return context;
  return {
    locale: 'en',
    t: (key: MessageKey, vars?: Record<string, string | number>): string =>
      interpolate(en[key] ?? key, vars),
  };
}

export type { MessageKey } from './locales/en';
