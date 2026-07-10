/**
 * Finance Overview tab — period totals + per-category breakdown.
 *
 * DERIVED rows (feed, fingerlings, maintenance, treatments, harvest) are
 * badged so the operator knows they came from source records; COMPUTED
 * rows (the 5% rule) are badged as calculated.
 */
import React from 'react';

import type { FinanceSummary } from '../../../hooks/useFinance';
import type { FinancePeriod } from '../FinancePage';

interface OverviewTabProps {
  summary: FinanceSummary | undefined;
  isLoading: boolean;
  error: unknown;
  period: FinancePeriod;
}

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ summary, isLoading, error, period }) => {
  if (isLoading) {
    return <div className="py-16 text-center text-gray-500">Loading finance summary…</div>;
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
    return <div className="py-16 text-center text-gray-500">No finance data for this period.</div>;
  }

  const expenseCategories = summary.byCategory.filter((c) => c.kind === 'EXPENSE');
  const revenueCategories = summary.byCategory.filter((c) => c.kind === 'REVENUE');

  return (
    <div className="space-y-6">
      {/* Headline cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg bg-white p-5 shadow">
          <p className="text-sm font-medium text-gray-500">Operational cost</p>
          <p className="mt-1 text-3xl font-semibold text-gray-900">
            {formatMoney(summary.totalExpense, summary.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {period.from} → {period.to}
          </p>
        </div>
        <div className="rounded-lg bg-white p-5 shadow">
          <p className="text-sm font-medium text-gray-500">Revenue</p>
          <p className="mt-1 text-3xl font-semibold text-gray-900">
            {formatMoney(summary.totalRevenue, summary.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500">Harvest sales</p>
        </div>
        <div className="rounded-lg bg-white p-5 shadow">
          <p className="text-sm font-medium text-gray-500">Net result</p>
          <p
            className={`mt-1 text-3xl font-semibold ${
              summary.netResult >= 0 ? 'text-green-700' : 'text-red-700'
            }`}
          >
            {formatMoney(summary.netResult, summary.currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500">Revenue − operational cost</p>
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

const CategoryTable: React.FC<{
  title: string;
  rows: FinanceSummary['byCategory'];
  currency: string;
}> = ({ title, rows, currency }) => (
  <div className="overflow-hidden rounded-lg bg-white shadow">
    <div className="border-b border-gray-200 px-5 py-4">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
    </div>
    <table className="min-w-full divide-y divide-gray-200">
      <thead className="bg-gray-50">
        <tr>
          <th scope="col" className="px-5 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            Category
          </th>
          <th scope="col" className="px-5 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
            Total
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 bg-white">
        {rows.length === 0 && (
          <tr>
            <td colSpan={2} className="px-5 py-6 text-center text-sm text-gray-500">
              No entries in this period
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr key={row.categoryId}>
            <td className="px-5 py-3 text-sm text-gray-900">
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
            </td>
            <td className="px-5 py-3 text-right text-sm font-medium text-gray-900">
              {formatMoney(row.total, currency)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
