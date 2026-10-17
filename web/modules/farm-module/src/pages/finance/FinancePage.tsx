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
 * - Budget: budget vs actual per cost centre with a month-end forecast —
 *   sample data behind MockPreview until farm-service stores budgets
 *   (FARM-MEDIUM-439)
 * - Cost centres: the cost-centre register and unit production cost per
 *   site — sample data behind MockPreview until cost centres bound to the
 *   location tree exist (FARM-MEDIUM-440)
 * - Categories: dynamic user-defined taxonomy management
 * - Charts: cost trends (day/week/month/year), per-category, per-batch
 * - Settings: tenant default currency (SSoT) + fiscal year start
 */
import { useI18n, PageHeader, Select, type MessageKey } from '@aquaculture/shared-ui';
import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useFinanceSummary, FinanceGranularity } from '../../hooks/useFinance';
import { OverviewTab } from './components/OverviewTab';
import { ExpensesTab } from './components/ExpensesTab';
import { BudgetTab } from './components/BudgetTab';
import { CostCentresTab } from './components/CostCentresTab';
import { CategoriesTab } from './components/CategoriesTab';
import { ChartsTab } from './components/ChartsTab';
import { FinanceSettingsTab } from './components/FinanceSettingsTab';
import { useCanReadFinance } from './useCanReadFinance';

type TabId =
  | 'overview'
  | 'expenses'
  | 'budget'
  | 'cost-centres'
  | 'charts'
  | 'categories'
  | 'settings';

const VALID_TABS: readonly TabId[] = [
  'overview',
  'expenses',
  'budget',
  'cost-centres',
  'charts',
  'categories',
  'settings',
];
const DEFAULT_TAB: TabId = 'overview';

/**
 * The tabs whose figures follow the period select. The rest (budget, cost
 * centres, categories, settings) take no period, so the select is not offered
 * there — changing it would suggest their figures move with it.
 */
const PERIOD_TABS: ReadonlySet<TabId> = new Set<TabId>(['overview', 'expenses', 'charts']);
/** The tabs that render the period summary; only they read it. */
const SUMMARY_TABS: ReadonlySet<TabId> = new Set<TabId>(['overview', 'charts']);

/**
 * The tab strip, in the console nav's order and with its labels
 * (web/shell/src/console/nav/pages/finance.ts): an entry in the rail and the
 * tab it opens read the same.
 */
const TABS: ReadonlyArray<{ id: TabId; labelKey: MessageKey }> = [
  { id: 'overview', labelKey: 'nav.overview' },
  { id: 'expenses', labelKey: 'nav.page.expenses' },
  { id: 'budget', labelKey: 'nav.page.budget' },
  { id: 'cost-centres', labelKey: 'nav.page.costCentres' },
  { id: 'charts', labelKey: 'nav.page.charts' },
  { id: 'categories', labelKey: 'nav.page.categories' },
  { id: 'settings', labelKey: 'nav.page.financeSettings' },
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

type PeriodPresetId = '30d' | '90d' | '12m' | '5y';

/**
 * A preset's label key, derived from its id. WHY derived, not written per
 * preset: a key-named property holding a dotted literal with digits reads to
 * the secret scanner (gitleaks generic-api-key) as a credential; the template
 * literal keeps the compiler's check that every finance.period key is a real
 * message key.
 */
function periodLabelKey(id: PeriodPresetId): MessageKey {
  return `finance.period.${id}`;
}

const PERIOD_PRESETS: Array<{
  id: PeriodPresetId;
  days: number;
  granularity: FinanceGranularity;
}> = [
  { id: '30d', days: 30, granularity: 'DAY' },
  { id: '90d', days: 90, granularity: 'WEEK' },
  { id: '12m', days: 365, granularity: 'MONTH' },
  { id: '5y', days: 1826, granularity: 'YEAR' },
];

const FinancePage: React.FC = () => {
  const { t } = useI18n();
  // Finance reads are MANAGER+ADMIN-gated on the backend; guard the route so a
  // direct URL visit by a lower role sees an explicit message, not empty 403s.
  const canView = useCanReadFinance();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  // An unknown or missing ?tab= opens the overview rather than a blank page.
  const activeTab: TabId = VALID_TABS.find((tab) => tab === tabParam) ?? DEFAULT_TAB;

  const [presetId, setPresetId] = useState<string>('12m');
  const preset = PERIOD_PRESETS.find((p) => p.id === presetId) ?? PERIOD_PRESETS[2];

  const period: FinancePeriod = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - preset.days);
    return { from: isoDate(from), to: isoDate(to), granularity: preset.granularity };
  }, [preset]);

  const summaryQuery = useFinanceSummary(period.from, period.to, period.granularity, {
    enabled: canView && SUMMARY_TABS.has(activeTab),
  });

  const setTab = (tab: TabId): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    });
  };

  if (!canView) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-800">
        <div
          role="alert"
          className="max-w-md rounded-md bg-white dark:bg-gray-900 p-8 text-center shadow-(--shadow-sd-sm)"
        >
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('finance.restricted.title')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('finance.restricted.body')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 shadow-(--shadow-sd-sm)">
        <div className="px-4 sm:px-6 py-6">
          <PageHeader
            title={t('finance.title')}
            description={t('finance.description')}
            actions={
              PERIOD_TABS.has(activeTab) ? (
                <div className="mt-4 flex md:mt-0 md:ml-4 items-center space-x-3">
                  <label
                    htmlFor="finance-period"
                    className="text-sm text-gray-600 dark:text-gray-400"
                  >
                    {t('finance.period.label')}
                  </label>
                  <Select
                    id="finance-period"
                    fullWidth={false}
                    size="sm"
                    value={presetId}
                    onChange={(e) => setPresetId(e.target.value)}
                    options={PERIOD_PRESETS.map((p) => ({
                      value: p.id,
                      label: t(periodLabelKey(p.id)),
                    }))}
                  />
                </div>
              ) : undefined
            }
          />
        </div>

        {/* Tab bar */}
        <div className="px-4 sm:px-6">
          <nav
            className="-mb-px flex space-x-6 overflow-x-auto"
            aria-label={t('finance.tabs.label')}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setTab(tab.id)}
                className={`min-h-11 whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  activeTab === tab.id
                    ? 'border-info-500 text-info-600 dark:text-info-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-100'
                }`}
                aria-current={activeTab === tab.id ? 'page' : undefined}
              >
                {t(tab.labelKey)}
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
        {activeTab === 'budget' && <BudgetTab />}
        {activeTab === 'cost-centres' && <CostCentresTab />}
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
