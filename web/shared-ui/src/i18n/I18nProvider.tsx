/**
 * I18n Provider
 *
 * Lightweight internationalization infrastructure for the Aquaculture Platform.
 * Uses React Context + a simple message map pattern (no heavy dependency like
 * react-intl or i18next required at this stage).
 *
 * FE-HIGH-020: All UI strings must be externalized. This provider makes
 * hardcoded strings STRUCTURALLY IMPOSSIBLE for pages that use the `useI18n()`
 * hook, because the hook returns a typed `t()` function that only accepts
 * known message keys.
 *
 * Migration plan:
 * - Sprint 2 (now): Infrastructure + LoginPage + ConsentBanner extraction
 * - Sprint 3+: Full extraction of remaining pages
 * - Future: If ICU message format (plurals, gender) is needed, swap
 *   this provider's internals for react-intl without changing the API.
 *
 * @see FE-HIGH-020, FE-HIGH-021, FE-HIGH-022, FE-HIGH-023
 */

import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { en, type MessageKey } from './locales/en';
import { tr } from './locales/tr';

// ============================================================================
// Types
// ============================================================================

export type SupportedLocale = 'en' | 'tr';

export interface I18nContextValue {
  /** Current locale */
  locale: SupportedLocale;
  /** Translate a message key, with optional interpolation variables */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

// ============================================================================
// Message Maps
// ============================================================================

const MESSAGES: Record<SupportedLocale, Record<MessageKey, string>> = {
  en,
  tr,
};

// ============================================================================
// Context
// ============================================================================

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

// ============================================================================
// Provider
// ============================================================================

export interface I18nProviderProps {
  /** The active locale. Default: auto-detect from navigator or fall back to 'tr'. */
  locale?: SupportedLocale;
  children: React.ReactNode;
}

/**
 * Detect the browser's preferred locale, falling back to Turkish.
 */
function detectLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'tr';

  const browserLang = navigator.language?.split('-')[0]?.toLowerCase();
  if (browserLang === 'en') return 'en';
  return 'tr'; // Default to Turkish for this platform
}

export const I18nProvider: React.FC<I18nProviderProps> = ({
  locale: localeProp,
  children,
}) => {
  const locale = localeProp ?? detectLocale();
  const messages = MESSAGES[locale] ?? MESSAGES.tr;

  /**
   * Translation function.
   * Looks up the key in the current locale's message map.
   * Supports simple variable interpolation: {variableName}.
   *
   * @param key - A typed message key (compile-time checked)
   * @param vars - Optional interpolation variables
   * @returns The translated string, or the key itself if not found
   */
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>): string => {
      let message = messages[key] ?? en[key] ?? key;

      // Simple interpolation: replace {varName} with the value
      if (vars) {
        for (const [varName, value] of Object.entries(vars)) {
          message = message.replace(new RegExp(`\\{${varName}\\}`, 'g'), String(value));
        }
      }

      return message;
    },
    [messages],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

// ============================================================================
// Hook
// ============================================================================

/**
 * Access the i18n context.
 *
 * Falls back to English messages if the provider is not mounted
 * (e.g., in tests or MFE contexts without I18nProvider).
 *
 * @example
 * const { t, locale } = useI18n();
 * return <h1>{t('login.title')}</h1>;
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);

  if (context) return context;

  // Fallback for environments without the provider
  return {
    locale: 'en',
    t: (key: MessageKey, vars?: Record<string, string | number>): string => {
      let message = en[key] ?? key;
      if (vars) {
        for (const [varName, value] of Object.entries(vars)) {
          message = message.replace(new RegExp(`\\{${varName}\\}`, 'g'), String(value));
        }
      }
      return message;
    },
  };
}

// ============================================================================
// Re-exports
// ============================================================================

export type { MessageKey } from './locales/en';
