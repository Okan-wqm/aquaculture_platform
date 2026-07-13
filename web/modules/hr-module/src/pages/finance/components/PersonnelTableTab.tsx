/**
 * Personnel Table tab — headcounts per workforce category + total.
 *
 * Unclassified employees (no laborCategory) surface as an explicit
 * warning row linking to the employee list, rather than being silently
 * folded into another bucket.
 */
import React from 'react';
import { Link } from 'react-router-dom';

import type { HrPersonnelTable } from '../../../hooks/useHrFinance';
import { laborCategoryLabel } from './financeFormat';

interface PersonnelTableTabProps {
  data: HrPersonnelTable | undefined;
  isLoading: boolean;
  error: unknown;
}

export const PersonnelTableTab: React.FC<PersonnelTableTabProps> = ({ data, isLoading, error }) => {
  if (isLoading) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading personnel table…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
        Failed to load — manager or admin access is required to view HR finance data.
      </div>
    );
  }
  if (!data) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">No personnel data.</div>;
  }

  const classified = data.rows.filter((r) => r.category !== null);
  const unclassified = data.rows.find((r) => r.category === null);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Personnel category
              </th>
              <th className="px-5 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Quantity
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
            {classified.map((row) => (
              <tr key={row.category}>
                <td className="px-5 py-3 text-sm text-gray-900 dark:text-gray-100">
                  {laborCategoryLabel(row.category)}
                </td>
                <td className="px-5 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                  {row.headcount}
                </td>
              </tr>
            ))}
            {unclassified && unclassified.headcount > 0 && (
              <tr className="bg-amber-50 dark:bg-amber-900/20">
                <td className="px-5 py-3 text-sm text-amber-800 dark:text-amber-300">
                  Unclassified —{' '}
                  <Link to="/hr/employees" className="font-medium underline">
                    assign a category
                  </Link>
                </td>
                <td className="px-5 py-3 text-right text-sm font-medium text-amber-800 dark:text-amber-300">
                  {unclassified.headcount}
                </td>
              </tr>
            )}
            <tr className="bg-gray-50 dark:bg-gray-900/40">
              <td className="px-5 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
                Number of employees
              </td>
              <td className="px-5 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                {data.totalHeadcount}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};
