/**
 * Farm Finance Page — the finance tab of the farm module.
 *
 * Unified view over the tenant's farm finance ledger:
 * - Overview: period totals + per-category breakdown (derived costs like
 *   feed/fingerlings/maintenance appear automatically from their source
 *   records; computed lines like the 5% other-variable-cost rule are
 *   evaluated read-time by the backend)
 * - Expenses: unified line items (manual + derived); manual rows are
 *   editable here, derived rows deep-link to their source record's form
 * - Categories: dynamic user-defined taxonomy management
 * - Charts: cost trends (day/week/month/year), per-category, per-batch
 * - Settings: tenant default currency (SSoT) + fiscal year start
 */
import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useFinanceSummary, FinanceGranularity } from '../../hooks/useFinance';
import { OverviewTab } from './components/OverviewTab';
import { ExpensesTab } from './components/ExpensesTab';
import { CategoriesTab } from './components/CategoriesTab';
import { ChartsTab } from './components/ChartsTab';
import { FinanceSettingsTab } from './components/FinanceSettingsTab';

type TabId = 'overview' | 'expenses' | 'categories' | 'charts' | 'settings';

const VALID_TABS: TabId[] = ['overview', 'expenses', 'categories', 'charts', 'settings'];
const DEFAULT_TAB: TabId = 'overview';

const TABS: Array<{ id: TabId; name: string }> = [
  { id: 'overview', name: 'Overview' },
  { id: 'expenses', name: 'Expenses' },
  { id: 'categories', name: 'Categories' },
  { id: 'charts', name: 'Charts' },
  { id: 'settings', name: 'Settings' },
];

/** ISO date (yyyy-mm-dd) n days/years back from today. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FinancePeriod {
  from: string;
  to: string;
  granularity: FinanceGranularity;
}

const PERIOD_PRESETS: Array<{ id: string; label: string; days: number; granularity: FinanceGranularity }> = [
  { id: '30d', label: 'Last 30 days', days: 30, granularity: 'DAY' },
  { id: '90d', label: 'Last 90 days', days: 90, granularity: 'WEEK' },
  { id: '12m', label: 'Last 12 months', days: 365, granularity: 'MONTH' },
  { id: '5y', label: 'Last 5 years', days: 1826, granularity: 'YEAR' },
];

const FinancePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = tabParam && VALID_TABS.includes(tabParam) ? tabParam : DEFAULT_TAB;

  const [presetId, setPresetId] = useState<string>('12m');
  const preset = PERIOD_PRESETS.find((p) => p.id === presetId) ?? PERIOD_PRESETS[2];

  const period: FinancePeriod = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - preset.days);
    return { from: isoDate(from), to: isoDate(to), granularity: preset.granularity };
  }, [preset]);

  const summaryQuery = useFinanceSummary(period.from, period.to, period.granularity);

  const setTab = (tab: TabId): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="px-4 sm:px-6 py-6">
          <div className="md:flex md:items-center md:justify-between">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Farm Finance
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Operational costs, revenue and budgeting — feed, fingerlings, maintenance and
                treatments flow in automatically from their source records
              </p>
            </div>
            <div className="mt-4 flex md:mt-0 md:ml-4 items-center space-x-3">
              <label htmlFor="finance-period" className="text-sm text-gray-600">
                Period:
              </label>
              <select
                id="finance-period"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              >
                {PERIOD_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-6 overflow-x-auto" aria-label="Finance tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTab(tab.id)}
                className={`whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                }`}
                aria-current={activeTab === tab.id ? 'page' : undefined}
              >
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-4 sm:px-6 py-6">
        {activeTab === 'overview' && (
          <OverviewTab
            summary={summaryQuery.data}
            isLoading={summaryQuery.isLoading}
            error={summaryQuery.error}
            period={period}
          />
        )}
        {activeTab === 'expenses' && <ExpensesTab period={period} />}
        {activeTab === 'categories' && <CategoriesTab />}
        {activeTab === 'charts' && (
          <ChartsTab
            summary={summaryQuery.data}
            isLoading={summaryQuery.isLoading}
            period={period}
          />
        )}
        {activeTab === 'settings' && <FinanceSettingsTab />}
      </div>
    </div>
  );
};

export default FinancePage;
