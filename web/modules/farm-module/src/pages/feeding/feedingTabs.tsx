/**
 * Feeding hub tab configuration — extracted from FeedingPage (cleanup pass).
 *
 * All tabs use i18n keys (P-17): the legacy raw-name tabs were migrated to
 * `feedingV2.tab.*` keys defined in shared-ui locales (en + tr).
 *
 * NOTE: the en values 'Records'/'Summary'/'Growth'/'FCR' are load-bearing —
 * FeedingPage.spec matches the Records tab button with a case-sensitive
 * /Records/ regex through the REAL useI18n en-fallback.
 */
import React from 'react';
import type { MessageKey } from '@aquaculture/shared-ui';

export type TabId =
  | 'meal-board'
  | 'forecast'
  | 'records'
  | 'summary'
  | 'growth'
  | 'fcr'
  | 'protocols-v2'
  | 'assignments';

export interface FeedingTab {
  id: TabId;
  i18nKey: MessageKey;
  icon: React.ReactNode;
}

export const VALID_TABS: TabId[] = [
  'meal-board',
  'forecast',
  'records',
  'summary',
  'growth',
  'fcr',
  'protocols-v2',
  'assignments',
];

export const DEFAULT_TAB: TabId = 'meal-board';

/**
 * FeedingFilters'ı gerçekten TÜKETEN sekmeler — meal-board/forecast kendi
 * kapsam seçicilerini taşır, protocols-v2 site/batch bağımsızdır; onlarda
 * filtre çubuğu göstermek ölü UI olur (FARM-LOW-234).
 */
export const FILTER_CONSUMING_TABS: TabId[] = ['records', 'summary', 'growth', 'fcr', 'assignments'];

export const feedingTabs: FeedingTab[] = [
  {
    id: 'meal-board',
    i18nKey: 'feedingV2.tab.mealBoard',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 6h16M4 10h16M4 14h10M4 18h6"
        />
      </svg>
    ),
  },
  {
    id: 'forecast',
    i18nKey: 'feedingV2.tab.forecast',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 17l6-6 4 4 8-8M21 7v6h-6"
        />
      </svg>
    ),
  },
  {
    id: 'records',
    i18nKey: 'feedingV2.tab.records',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
        />
      </svg>
    ),
  },
  {
    id: 'summary',
    i18nKey: 'feedingV2.tab.summary',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
    ),
  },
  {
    id: 'growth',
    i18nKey: 'feedingV2.tab.growth',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
        />
      </svg>
    ),
  },
  {
    id: 'fcr',
    i18nKey: 'feedingV2.tab.fcr',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
    ),
  },
  {
    id: 'protocols-v2',
    i18nKey: 'feedingV2.tab.builder',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
    ),
  },
  {
    id: 'assignments',
    i18nKey: 'feedingV2.tab.assignments',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

export function isValidTab(value: string | null): value is TabId {
  return value !== null && VALID_TABS.includes(value as TabId);
}
