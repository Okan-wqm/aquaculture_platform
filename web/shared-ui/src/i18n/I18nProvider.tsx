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

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { en, type MessageKey } from './locales/en';
import { tr } from './locales/tr';
import {
  applyDocumentLocale,
  persistLocale,
  resolveInitialLocale,
  type SupportedLocale,
} from './localePreference';

// ============================================================================
// Types
// ============================================================================

export type { SupportedLocale } from './localePreference';

export interface I18nContextValue {
  /** Current locale */
  locale: SupportedLocale;
  /** Translate a message key, with optional interpolation variables */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /**
   * Switch the UI language. Persists the device preference and updates
   * `<html lang>`; the shell also writes the account's `preferredLanguage`
   * through the settings page so the choice follows the user.
   */
  setLocale: (locale: SupportedLocale) => void;
}

// ============================================================================
// Message Maps
// ============================================================================

const MESSAGES: Record<SupportedLocale, Record<MessageKey, string>> = {
  en,
  tr,
};

function interpolate(message: string, vars?: Record<string, string | number>): string {
  if (!vars) return message;
  let result = message;
  for (const [varName, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${varName}\\}`, 'g'), String(value));
  }
  return result;
}

// ============================================================================
// Context
// ============================================================================

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

// ============================================================================
// Provider
// ============================================================================

export interface I18nProviderProps {
  /**
   * Pin the locale (tests, a subtree that must render in one language).
   * Without it the provider resolves the device preference, then the
   * browser, then Turkish, and `setLocale` switches it at runtime.
   */
  locale?: SupportedLocale;
  children: React.ReactNode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({ locale: pinnedLocale, children }) => {
  const [chosenLocale, setChosenLocale] = useState<SupportedLocale>(() => pinnedLocale ?? resolveInitialLocale());
  const locale = pinnedLocale ?? chosenLocale;
  const messages = MESSAGES[locale];

  // The document language follows the active locale — assistive technology
  // and hyphenation read it, and the static `<html lang>` is only the value
  // before hydration.
  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  const setLocale = useCallback((next: SupportedLocale) => {
    persistLocale(next);
    setChosenLocale(next);
  }, []);

  /**
   * Translation function: the current locale's message, or the English one
   * when the key is missing there, with `{variable}` interpolation.
   */
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>): string =>
      interpolate(messages[key] ?? en[key] ?? key, vars),
    [messages],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, t, setLocale }), [locale, t, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

// ============================================================================
// Hook
// ============================================================================

/**
 * Access the i18n context.
 *
 * Without a provider (tests, a remote rendered in isolation) it answers in
 * English from the message map and `setLocale` has nothing to switch.
 *
 * @example
 * const { t, locale } = useI18n();
 * return <h1>{t('login.title')}</h1>;
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);

  if (context) return context;

  return {
    locale: 'en',
    t: (key: MessageKey, vars?: Record<string, string | number>): string => interpolate(en[key] ?? key, vars),
    setLocale: () => undefined,
  };
}

// ============================================================================
// Re-exports
// ============================================================================

export type { MessageKey } from './locales/en';
