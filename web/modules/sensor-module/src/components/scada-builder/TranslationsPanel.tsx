/**
 * Editor panel for managing SCADA view translations.
 * Provides a table-based interface for adding, editing, and removing
 * translation keys and their values across multiple languages.
 *
 * Architecture: The panel operates on a ViewTranslations object and
 * emits changes via onTranslationsChange. It does not manage its own
 * persistence — the parent component (package settings) is responsible
 * for storing translations in the SCADA package JSON.
 *
 * Designed for the PropertiesPanel package-scoped section or as a
 * standalone panel in the package settings area.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Languages,
  Search,
  Globe,
} from 'lucide-react';
import {
  type ViewTranslations,
  createEmptyTranslations,
  getAllTranslationKeys,
  getLanguageCodes,
  TRANSLATION_PREFIX,
} from '../../engine/i18n/ViewTranslations';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranslationsPanelProps {
  translations: ViewTranslations | null;
  onTranslationsChange: (translations: ViewTranslations) => void;
}

// ---------------------------------------------------------------------------
// Language labels for common codes
// ---------------------------------------------------------------------------

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  tr: 'Turkish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  ar: 'Arabic',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TranslationsPanel: React.FC<TranslationsPanelProps> = ({
  translations: translationsProp,
  onTranslationsChange,
}) => {
  const translations = translationsProp ?? createEmptyTranslations();
  const [search, setSearch] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newLangCode, setNewLangCode] = useState('');

  const allKeys = useMemo(() => getAllTranslationKeys(translations), [translations]);
  const languages = useMemo(() => getLanguageCodes(translations), [translations]);

  // Filtered keys
  const filteredKeys = useMemo(() => {
    const term = search.toLowerCase();
    return term ? allKeys.filter((k) => k.toLowerCase().includes(term)) : allKeys;
  }, [allKeys, search]);

  // Add a new translation key
  const handleAddKey = useCallback(() => {
    if (!newKey.trim() || allKeys.includes(newKey.trim())) return;

    const updated: ViewTranslations = {
      ...translations,
      languages: { ...translations.languages },
    };

    // Add empty entry for the key in all languages
    for (const lang of languages) {
      updated.languages[lang] = { ...updated.languages[lang], [newKey.trim()]: '' };
    }

    onTranslationsChange(updated);
    setNewKey('');
  }, [newKey, allKeys, translations, languages, onTranslationsChange]);

  // Remove a translation key from all languages
  const handleRemoveKey = useCallback(
    (key: string) => {
      const updated: ViewTranslations = {
        ...translations,
        languages: { ...translations.languages },
      };

      for (const lang of languages) {
        const dict = { ...updated.languages[lang] };
        delete dict[key];
        updated.languages[lang] = dict;
      }

      onTranslationsChange(updated);
    },
    [translations, languages, onTranslationsChange],
  );

  // Update a translation value
  const handleUpdateValue = useCallback(
    (key: string, lang: string, value: string) => {
      const updated: ViewTranslations = {
        ...translations,
        languages: {
          ...translations.languages,
          [lang]: { ...translations.languages[lang], [key]: value },
        },
      };
      onTranslationsChange(updated);
    },
    [translations, onTranslationsChange],
  );

  // Add a new language
  const handleAddLanguage = useCallback(() => {
    const code = newLangCode.trim().toLowerCase();
    if (!code || languages.includes(code)) return;

    // Initialize with empty translations for all existing keys
    const langDict: Record<string, string> = {};
    for (const key of allKeys) {
      langDict[key] = '';
    }

    const updated: ViewTranslations = {
      ...translations,
      languages: { ...translations.languages, [code]: langDict },
    };

    onTranslationsChange(updated);
    setNewLangCode('');
  }, [newLangCode, languages, allKeys, translations, onTranslationsChange]);

  // Remove a language
  const handleRemoveLanguage = useCallback(
    (lang: string) => {
      // Cannot remove default language
      if (lang === translations.defaultLanguage) return;

      const updated: ViewTranslations = {
        ...translations,
        languages: { ...translations.languages },
      };
      delete updated.languages[lang];
      onTranslationsChange(updated);
    },
    [translations, onTranslationsChange],
  );

  // Change default language
  const handleSetDefaultLanguage = useCallback(
    (lang: string) => {
      onTranslationsChange({ ...translations, defaultLanguage: lang });
    },
    [translations, onTranslationsChange],
  );

  return (
    <div className="space-y-3" data-testid="translations-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Languages className="w-4 h-4 text-cyan-600" />
          <h4 className="text-sm font-medium text-gray-700">Translations</h4>
          <span className="text-[11px] text-gray-400">
            ({allKeys.length} keys, {languages.length} languages)
          </span>
        </div>
      </div>

      {/* Hint */}
      <div className="text-[11px] text-gray-500 bg-gray-50 px-3 py-2 rounded-lg">
        Use <code className="text-cyan-700 bg-cyan-50 px-1 rounded">{TRANSLATION_PREFIX}key</code>{' '}
        in widget labels to enable runtime translation.
      </div>

      {/* Languages */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1.5">Languages</label>
        <div className="flex flex-wrap gap-1.5">
          {languages.map((lang) => (
            <div
              key={lang}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs border ${
                lang === translations.defaultLanguage
                  ? 'border-cyan-300 bg-cyan-50 text-cyan-700'
                  : 'border-gray-200 text-gray-600'
              }`}
            >
              <Globe className="w-3 h-3" />
              <span className="font-medium">{lang.toUpperCase()}</span>
              <span className="text-[10px] text-gray-400">
                {LANGUAGE_LABELS[lang] || ''}
              </span>
              {lang === translations.defaultLanguage ? (
                <span className="text-[9px] font-semibold text-cyan-600">DEFAULT</span>
              ) : (
                <>
                  <button
                    onClick={() => handleSetDefaultLanguage(lang)}
                    className="text-[9px] text-gray-400 hover:text-cyan-600"
                    title="Set as default"
                  >
                    set default
                  </button>
                  <button
                    onClick={() => handleRemoveLanguage(lang)}
                    className="ml-0.5 text-gray-400 hover:text-red-500"
                    title="Remove language"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={newLangCode}
              onChange={(e) => setNewLangCode(e.target.value)}
              placeholder="lang code"
              className="w-16 px-1.5 py-1 text-xs border border-gray-200 rounded"
              maxLength={5}
            />
            <button
              onClick={handleAddLanguage}
              disabled={!newLangCode.trim()}
              className="p-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 disabled:opacity-40"
              title="Add language"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search keys..."
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500"
        />
      </div>

      {/* Add key */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddKey();
          }}
          placeholder="New translation key"
          className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500"
          data-testid="translation-new-key"
        />
        <button
          onClick={handleAddKey}
          disabled={!newKey.trim()}
          className="p-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:bg-gray-200 disabled:text-gray-400"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Translation table */}
      {filteredKeys.length === 0 ? (
        <div className="text-center py-6 text-xs text-gray-400">
          {allKeys.length === 0
            ? 'No translation keys defined yet.'
            : 'No keys match the search filter.'}
        </div>
      ) : (
        <div className="max-h-[350px] overflow-auto border border-gray-200 rounded-lg">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 z-10">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-500 border-b border-gray-200">
                  Key
                </th>
                {languages.map((lang) => (
                  <th
                    key={lang}
                    className="text-left px-2 py-2 font-medium text-gray-500 border-b border-gray-200"
                  >
                    {lang.toUpperCase()}
                  </th>
                ))}
                <th className="w-8 border-b border-gray-200" />
              </tr>
            </thead>
            <tbody>
              {filteredKeys.map((key) => (
                <tr key={key} className="hover:bg-gray-50 border-t border-gray-50">
                  <td className="px-3 py-1.5 font-mono text-gray-800">{key}</td>
                  {languages.map((lang) => (
                    <td key={lang} className="px-2 py-1">
                      <input
                        type="text"
                        value={translations.languages[lang]?.[key] ?? ''}
                        onChange={(e) => handleUpdateValue(key, lang, e.target.value)}
                        className="w-full px-1.5 py-0.5 text-[11px] border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500"
                        placeholder={`${lang}...`}
                      />
                    </td>
                  ))}
                  <td className="px-1 py-1">
                    <button
                      onClick={() => handleRemoveKey(key)}
                      className="p-1 rounded hover:bg-red-100 text-red-400"
                      title="Remove key"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TranslationsPanel;
