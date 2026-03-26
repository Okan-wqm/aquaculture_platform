/**
 * React hook for resolving $t: translation keys in SCADA widgets.
 *
 * Usage:
 *   const { t } = useTranslation(translations, 'tr');
 *   const label = t('$t:pump_status');  // "Pompa Durumu"
 *   const plain = t('Static Label');     // "Static Label" (passthrough)
 *
 * Architecture: The hook memoizes the resolver function so that
 * widget components can call t() inline without triggering re-renders.
 * The resolver is recreated only when the translations object or
 * active language changes.
 *
 * The hook does NOT manage language state — that responsibility belongs
 * to the ScadaRuntime or a parent context provider. This keeps the hook
 * simple and testable.
 */

import { useCallback, useMemo } from 'react';
import {
  resolveLabel,
  isTranslationKey,
  extractTranslationKey,
  resolveTranslation,
  type ViewTranslations,
} from './ViewTranslations';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseTranslationResult {
  /** Resolve a label string — handles both $t: keys and plain text. */
  t: (label: string) => string;
  /** The currently active language code. */
  language: string;
  /** Check if a string is a translation key without resolving it. */
  isKey: (label: string) => boolean;
  /** Resolve a key directly (without the $t: prefix). */
  resolveKey: (key: string) => string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTranslation(
  translations: ViewTranslations | null | undefined,
  language: string = 'en',
): UseTranslationResult {
  const t = useCallback(
    (label: string): string => resolveLabel(label, translations, language),
    [translations, language],
  );

  const isKey = useCallback(
    (label: string): boolean => isTranslationKey(label),
    [],
  );

  const resolveKey = useCallback(
    (key: string): string => {
      if (!translations) return key;
      return resolveTranslation(translations, key, language);
    },
    [translations, language],
  );

  return useMemo(
    () => ({ t, language, isKey, resolveKey }),
    [t, language, isKey, resolveKey],
  );
}
