/**
 * Personnel Salary tab — annual salary per person per workforce category
 * plus the category totals. Read from the shared labour-cost snapshot.
 */
import React from 'react';

import type { HrLabourCost } from '../../../hooks/useHrFinance';
import { formatMoney, laborCategoryLabel } from './financeFormat';

interface SalariesTabProps {
  data: HrLabourCost | undefined;
  isLoading: boolean;
}

export const SalariesTab: React.FC<SalariesTabProps> = ({ data, isLoading }) => {
  if (isLoading) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading salaries…</div>;
  }
  if (!data) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">No salary data.</div>;
  }

  const rows = data.rows.filter((r) => r.headcount > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-900/40">
          <tr>
            {['Category', 'Headcount', 'Annual salary / person', 'Annual salary total'].map((h) => (
              <th
                key={h}
                className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 last:text-right"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
          {rows.map((row) => (
            <tr key={row.category ?? 'unclassified'}>
              <td className="px-5 py-3 text-sm text-gray-900 dark:text-gray-100">
                {laborCategoryLabel(row.category)}
              </td>
              <td className="px-5 py-3 text-sm text-gray-700 dark:text-gray-300">{row.headcount}</td>
              <td className="px-5 py-3 text-sm text-gray-700 dark:text-gray-300">
                {formatMoney(row.avgAnnualSalary, data.currency)}
              </td>
              <td className="px-5 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                {formatMoney(row.annualSalaryTotal, data.currency)}
              </td>
            </tr>
          ))}
          <tr className="bg-gray-50 dark:bg-gray-900/40">
            <td className="px-5 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100" colSpan={3}>
              Total annual salaries
            </td>
            <td className="px-5 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
              {formatMoney(data.annualSalaryTotal, data.currency)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};
