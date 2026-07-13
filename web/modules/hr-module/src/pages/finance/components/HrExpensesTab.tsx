/**
 * HR Expenses tab — manual HR expense ledger (training, recruitment,
 * PPE, travel, custom) with dynamic category management.
 */
import { parseMoney } from '@aquaculture/shared-ui';
import React, { useState } from 'react';

import {
  type HrFinanceCategory,
  type HrFinanceEntry,
  useArchiveHrFinanceCategory,
  useCreateHrFinanceCategory,
  useDeleteHrFinanceEntry,
  useHrFinanceCategories,
  useHrFinanceEntries,
} from '../../../hooks/useHrFinance';
import { formatMoney } from './financeFormat';
import { HrExpenseFormModal } from './HrExpenseFormModal';

interface HrExpensesTabProps {
  period: { from: string; to: string };
}

export const HrExpensesTab: React.FC<HrExpensesTabProps> = ({ period }) => {
  const entriesQuery = useHrFinanceEntries({ from: period.from, to: period.to, limit: 100 });
  const categoriesQuery = useHrFinanceCategories();
  const createCategory = useCreateHrFinanceCategory();
  const archiveCategory = useArchiveHrFinanceCategory();
  const deleteEntry = useDeleteHrFinanceEntry();

  const [modal, setModal] = useState<{ open: boolean; entry?: HrFinanceEntry }>({ open: false });
  const [newCategory, setNewCategory] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const categoryName = new Map(
    (categoriesQuery.data ?? []).map((c) => [c.id, c.name] as const),
  );

  const canArchive = (c: HrFinanceCategory): boolean => c.isActive && !c.computedRule;

  const handleCreateCategory = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setErrorMessage(null);
    if (!newCategory.trim()) return;
    try {
      await createCategory.mutateAsync({ name: newCategory.trim() });
      setNewCategory('');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Creating the category failed.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Category management */}
      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form onSubmit={handleCreateCategory} className="flex items-end gap-2">
            <div>
              <label htmlFor="hr-new-category" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                New expense category
              </label>
              <input
                id="hr-new-category"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                placeholder="e.g. Uniforms"
              />
            </div>
            <button
              type="submit"
              disabled={createCategory.isPending || !newCategory.trim()}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Add
            </button>
          </form>
          <button
            onClick={() => setModal({ open: true })}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            + Add expense
          </button>
        </div>
        {errorMessage && (
          <div className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {errorMessage}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {(categoriesQuery.data ?? []).map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200"
            >
              {c.name}
              {c.computedRule && (
                <span className="text-purple-600 dark:text-purple-300">{c.computedRule.percent}%</span>
              )}
              {canArchive(c) && (
                <button
                  onClick={() => archiveCategory.mutate(c.id)}
                  className="text-red-500 hover:text-red-700"
                  aria-label={`Archive ${c.name}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Entries table */}
      <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              {['Date', 'Category', 'Description', 'Amount', ''].map((h) => (
                <th
                  key={h}
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
            {entriesQuery.isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  Loading expenses…
                </td>
              </tr>
            )}
            {!entriesQuery.isLoading && (entriesQuery.data ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No HR expenses booked this year
                </td>
              </tr>
            )}
            {(entriesQuery.data ?? []).map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  {entry.entryDate.slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                  {categoryName.get(entry.categoryId) ?? '—'}
                </td>
                <td className="max-w-xs truncate px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                  {entry.description ?? '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                  {formatMoney(parseMoney(entry.amountDecimal), entry.currency)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                  <span className="space-x-3">
                    <button
                      onClick={() => setModal({ open: true, entry })}
                      className="font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm('Delete this HR expense?')) deleteEntry.mutate(entry.id);
                      }}
                      className="font-medium text-red-600 hover:text-red-800 dark:text-red-400"
                    >
                      Delete
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal.open && <HrExpenseFormModal entry={modal.entry} onClose={() => setModal({ open: false })} />}
    </div>
  );
};
