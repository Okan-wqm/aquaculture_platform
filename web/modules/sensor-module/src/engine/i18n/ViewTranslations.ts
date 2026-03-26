/**
 * Runtime language switching for operator-facing labels in SCADA views.
 * Widget labels, button texts, and status messages can have translations
 * stored alongside the SCADA package.
 *
 * Convention: Labels starting with '$t:' are translation keys.
 * Example: '$t:pump_status' resolves to "Pump Status" (en) or
 * "Pompa Durumu" (tr) based on the active language.
 *
 * Architecture: Translations are a simple Record<lang, Record<key, text>>
 * stored in the package JSON. The useTranslation hook resolves keys
 * at render time. No external i18n library needed — this is intentionally
 * lightweight for SCADA runtime where bundle size and startup time matter.
 *
 * The $t: prefix convention was chosen because:
 *  1. It is visually distinct in the builder UI
 *  2. It does not conflict with any valid label text
 *  3. It can be detected with a simple startsWith check (O(1))
 *  4. It mirrors the common i18n $t() function naming convention
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Container for all view translations within a SCADA package.
 * Stored at the package level, not per-screen, because operators
 * expect consistent language across all screens.
 */
export interface ViewTranslations {
  /** ISO 639-1 language code used when no user preference is set. */
  defaultLanguage: string;
  /**
   * Nested map: language code -> translation key -> translated text.
   * Example: { en: { pump_status: 'Pump Status' }, tr: { pump_status: 'Pompa Durumu' } }
   */
  languages: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix that marks a label string as a translation key. */
export const TRANSLATION_PREFIX = '$t:';

// ---------------------------------------------------------------------------
// Pure Functions
// ---------------------------------------------------------------------------

/**
 * Check whether a label string is a translation key.
 * Returns true for strings like '$t:pump_status'.
 */
export function isTranslationKey(label: string): boolean {
  return typeof label === 'string' && label.startsWith(TRANSLATION_PREFIX);
}

/**
 * Extract the translation key from a prefixed label string.
 * '$t:pump_status' -> 'pump_status'
 */
export function extractTranslationKey(label: string): string {
  return label.slice(TRANSLATION_PREFIX.length);
}

/**
 * Resolve a translation key to its translated text.
 * Falls back through: requested language -> default language -> key itself.
 *
 * This three-tier fallback ensures the UI always shows something meaningful:
 *  1. Exact match in the requested language
 *  2. Match in the package's default language (partial translation scenario)
 *  3. The raw key name (no translation available at all)
 */
export function resolveTranslation(
  translations: ViewTranslations,
  key: string,
  language: string,
): string {
  // Tier 1: exact match in requested language
  const langDict = translations.languages[language];
  if (langDict && key in langDict) {
    return langDict[key];
  }

  // Tier 2: fallback to default language
  if (language !== translations.defaultLanguage) {
    const defaultDict = translations.languages[translations.defaultLanguage];
    if (defaultDict && key in defaultDict) {
      return defaultDict[key];
    }
  }

  // Tier 3: return the raw key as-is
  return key;
}

/**
 * Resolve a label string that may or may not be a translation key.
 * If the label starts with '$t:', resolve it. Otherwise return as-is.
 * This is the primary entry point for widget renderers.
 */
export function resolveLabel(
  label: string,
  translations: ViewTranslations | null | undefined,
  language: string,
): string {
  if (!translations || !isTranslationKey(label)) {
    return label;
  }
  const key = extractTranslationKey(label);
  return resolveTranslation(translations, key, language);
}

/**
 * Create an empty ViewTranslations object with the given default language.
 */
export function createEmptyTranslations(defaultLanguage: string = 'en'): ViewTranslations {
  return {
    defaultLanguage,
    languages: { [defaultLanguage]: {} },
  };
}

/**
 * Get all unique translation keys across all languages.
 * Used by the translations editor to show a unified key list.
 */
export function getAllTranslationKeys(translations: ViewTranslations): string[] {
  const keys = new Set<string>();
  for (const dict of Object.values(translations.languages)) {
    for (const key of Object.keys(dict)) {
      keys.add(key);
    }
  }
  return Array.from(keys).sort();
}

/**
 * Get all language codes defined in the translations.
 */
export function getLanguageCodes(translations: ViewTranslations): string[] {
  return Object.keys(translations.languages).sort();
}
