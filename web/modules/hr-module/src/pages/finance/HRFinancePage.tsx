/**
 * HR Finance Page — the finance tab of the HR module.
 *
 * The Personnel Table, Salaries and Labour Cost tabs all render from the
 * single `hrLabourCost` snapshot so the numbers never drift between
 * views. Charts and the manual HR expense ledger complete the surface.
 */
import { useAuth } from '@aquaculture/shared-ui';
import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useHrLabourCost, type HrFinanceGranularity } from '../../hooks/useHrFinance';
import { PersonnelTableTab } from './components/PersonnelTableTab';
import { SalariesTab } from './components/SalariesTab';
import { LabourCostTab } from './components/LabourCostTab';
import { HrExpensesTab } from './components/HrExpensesTab';
import { HrChartsTab } from './components/HrChartsTab';

type TabId = 'personnel' | 'salaries' | 'labour' | 'expenses' | 'charts';

const VALID_TABS: TabId[] = ['personnel', 'salaries', 'labour', 'expenses', 'charts'];
const DEFAULT_TAB: TabId = 'personnel';

const TABS: Array<{ id: TabId; name: string }> = [
  { id: 'personnel', name: 'Personnel Table' },
  { id: 'salaries', name: 'Salaries' },
  { id: 'labour', name: 'Labour Cost' },
  { id: 'expenses', name: 'Expenses' },
  { id: 'charts', name: 'Charts' },
];

const HRFinancePage: React.FC = () => {
  const { hasAnyRole } = useAuth();
  // Labour-cost / salary reads are MANAGER+ADMIN-gated on the backend; guard the
  // route so a lower role never reaches the finance surface (buttons included).
  const canView = hasAnyRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER']);
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = tabParam && VALID_TABS.includes(tabParam) ? tabParam : DEFAULT_TAB;

  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const yearOptions = useMemo(
    () => Array.from({ length: 5 }, (_, i) => currentYear - i),
    [currentYear],
  );

  // Single shared snapshot behind Personnel / Salaries / Labour Cost.
  const labourCostQuery = useHrLabourCost(year);

  const period = useMemo(() => {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const granularity: HrFinanceGranularity = 'MONTH';
    return { from, to, granularity };
  }, [year]);

  const setTab = (tab: TabId): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    });
  };

  if (!canView) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div role="alert" className="max-w-md rounded-md bg-white p-8 text-center shadow">
          <h2 className="text-lg font-semibold text-gray-900">Finance is restricted</h2>
          <p className="mt-2 text-sm text-gray-600">
            You need a manager or admin role to view the HR finance tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">HR Finance</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Personnel headcounts, salaries, labour cost and workforce expenses
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="hr-finance-year" className="text-sm text-gray-600 dark:text-gray-400">
            Year:
          </label>
          <select
            id="hr-finance-year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex space-x-6 overflow-x-auto" aria-label="HR finance tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`whitespace-nowrap border-b-2 py-3 px-1 text-sm font-medium ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400'
              }`}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              {tab.name}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'personnel' && (
        <PersonnelTableTab
          data={labourCostQuery.data}
          isLoading={labourCostQuery.isLoading}
          error={labourCostQuery.error}
        />
      )}
      {activeTab === 'salaries' && (
        <SalariesTab data={labourCostQuery.data} isLoading={labourCostQuery.isLoading} />
      )}
      {activeTab === 'labour' && (
        <LabourCostTab data={labourCostQuery.data} isLoading={labourCostQuery.isLoading} />
      )}
      {activeTab === 'expenses' && <HrExpensesTab period={period} />}
      {activeTab === 'charts' && <HrChartsTab period={period} />}
    </div>
  );
};

export default HRFinancePage;
