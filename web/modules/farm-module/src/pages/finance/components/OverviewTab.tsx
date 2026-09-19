/**
 * Finance Overview tab — period totals + per-category breakdown.
 *
 * DERIVED rows (feed, fingerlings, maintenance, treatments, harvest) are
 * badged so the operator knows they came from source records; COMPUTED
 * rows (the 5% rule) are badged as calculated.
 */
import { formatCurrency, parseMoney, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import React from 'react';

import type { FinanceSummary } from '../../../hooks/useFinance';
import type { FinancePeriod } from '../FinancePage';

interface OverviewTabProps {
  summary: FinanceSummary | undefined;
  isLoading: boolean;
  error: unknown;
  period: FinancePeriod;
}

/**
 * Finance money formatter — delegates to the shared 2-decimal
 * formatCurrency so rows reconcile with their totals (a 0-decimal format
 * makes 0.50 × 3 render as "1" each yet total "2"). Booked amounts are
 * always in the tenant default currency (backend SSoT).
 *
 * Money now crosses the wire as an exact decimal STRING (Decimal scalar,
 * ADR-0004 / DATA-MEDIUM-009); accept either the string form or a raw
 * number and coerce once here at the display boundary.
 */
export function formatMoney(amount: number | string, currency: string): string {
  return formatCurrency(parseMoney(amount), currency);
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ summary, isLoading, error, period }) => {
  if (isLoading) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading finance summary…</div>;
  }
  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Failed to load the finance summary. You need manager or admin access to view financial
        data.
      </div>
    );
  }
  if (!summary) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">No finance data for this period.</div>;
  }

  const expenseCategories = summary.byCategory.filter((c) => c.kind === 'EXPENSE');
  const revenueCategories = summary.byCategory.filter((c) => c.kind === 'REVENUE');

  return (
    <div className="space-y-6">
      {/* Headline cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg bg-white dark:bg-gray-900 p-5 shadow">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Operational cost</p>
          <p className="mt-1 text-3xl font-semibold text-gray-900 dark:text-gray-100">
            {formatMoney(summary.totalExpenseDecimal, summary.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {period.from} → {period.to}
          </p>
        </div>
        <div className="rounded-lg bg-white dark:bg-gray-900 p-5 shadow">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Revenue</p>
          <p className="mt-1 text-3xl font-semibold text-gray-900 dark:text-gray-100">
            {formatMoney(summary.totalRevenueDecimal, summary.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Harvest sales</p>
        </div>
        <div className="rounded-lg bg-white dark:bg-gray-900 p-5 shadow">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Net result</p>
          <p
            className={`mt-1 text-3xl font-semibold ${
              parseMoney(summary.netResultDecimal) >= 0 ? 'text-green-700' : 'text-red-700'
            }`}
          >
            {formatMoney(summary.netResultDecimal, summary.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Revenue − operational cost</p>
        </div>
      </div>

      {/* Category tables */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CategoryTable
          title="Operational cost by category"
          rows={expenseCategories}
          currency={summary.currency}
        />
        <CategoryTable title="Revenue by category" rows={revenueCategories} currency={summary.currency} />
      </div>
    </div>
  );
};

type CategoryRow = FinanceSummary['byCategory'][number];

const categoryColumns = (currency: string): DataTableColumn<CategoryRow>[] => [
  {
    key: 'category',
    header: 'Category',
    render: (_value, row) => (
      <>
        <span>{row.categoryName}</span>
        {row.isDerived && (
          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
            auto
          </span>
        )}
        {row.isComputed && (
          <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
            calculated
          </span>
        )}
      </>
    ),
  },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    render: (_value, row) => formatMoney(row.totalDecimal, currency),
  }
];

const CategoryTable: React.FC<{
  title: string;
  rows: FinanceSummary['byCategory'];
  currency: string;
}> = ({ title, rows, currency }) => (
  <div className="overflow-hidden rounded-lg bg-white dark:bg-gray-900 shadow">
    <div className="border-b border-gray-200 dark:border-gray-700 px-5 py-4">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
    </div>
    <DataTable<CategoryRow>
      data={rows}
      columns={categoryColumns(currency)}
      keyExtractor={(row) => row.categoryId}
      emptyMessage="No records found"
      searchable={false}
      sortable={false}
      stickyHeader={false}
    />
  </div>
);
