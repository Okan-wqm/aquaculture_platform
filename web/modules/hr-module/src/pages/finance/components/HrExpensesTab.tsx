/**
 * HR Expenses tab — manual HR expense ledger (training, recruitment,
 * PPE, travel, custom) with dynamic category management.
 */
import {
  DataTable,
  parseMoney,
  useConfirm,
  type DataTableColumn,
  Button,
  Input,
} from '@aquaculture/shared-ui';
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
  const confirm = useConfirm();

  const handleDeleteEntry = async (id: string): Promise<void> => {
    if (
      !(await confirm({
        title: 'Delete this HR expense?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      }))
    )
      return;
    deleteEntry.mutate(id);
  };

  // FE-HIGH-086: archiving a category hides it from every new entry; it asks
  // first, like deleting an entry does.
  const handleArchiveCategory = async (category: { id: string; name: string }): Promise<void> => {
    if (
      !(await confirm({
        title: `Archive category "${category.name}"?`,
        message: 'Existing entries keep it; new entries can no longer use it.',
        confirmText: 'Archive',
        cancelText: 'Cancel',
        variant: 'danger',
      }))
    )
      return;
    archiveCategory.mutate(category.id);
  };

  const [modal, setModal] = useState<{ open: boolean; entry?: HrFinanceEntry }>({ open: false });
  const [newCategory, setNewCategory] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const categoryName = new Map((categoriesQuery.data ?? []).map((c) => [c.id, c.name] as const));

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

  const expenseColumns: DataTableColumn<HrFinanceEntry>[] = [
    {
      key: 'entryDate',
      header: 'Date',
      render: (_value, entry) => (
        <span className="whitespace-nowrap">{entry.entryDate.slice(0, 10)}</span>
      ),
    },
    {
      key: 'categoryId',
      header: 'Category',
      render: (_value, entry) => (
        <span className="text-gray-900 dark:text-gray-100">
          {categoryName.get(entry.categoryId) ?? '—'}
        </span>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (_value, entry) => (
        <span className="block max-w-xs truncate text-gray-500 dark:text-gray-400">
          {entry.description ?? '—'}
        </span>
      ),
    },
    {
      key: 'amountDecimal',
      header: 'Amount',
      align: 'right',
      render: (_value, entry) => (
        <span className="whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
          {formatMoney(parseMoney(entry.amountDecimal), entry.currency)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (_value, entry) => (
        <span className="space-x-3 whitespace-nowrap">
          <Button variant="ghost" onClick={() => setModal({ open: true, entry })}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => void handleDeleteEntry(entry.id)}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Category management */}
      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form onSubmit={handleCreateCategory} className="flex items-end gap-2">
            <div>
              <label
                htmlFor="hr-new-category"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                New expense category
              </label>
              <Input
                id="hr-new-category"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="e.g. Uniforms"
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={createCategory.isPending || !newCategory.trim()}
            >
              Add
            </Button>
          </form>
          <Button variant="primary" onClick={() => setModal({ open: true })}>
            + Add expense
          </Button>
        </div>
        {errorMessage && (
          <div className="mt-3 rounded-md bg-error-50 p-2 text-sm text-error-700 dark:bg-error-900/30 dark:text-error-300">
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
                <span className="text-accent-600 dark:text-accent-300">
                  {c.computedRule.percent}%
                </span>
              )}
              {canArchive(c) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    void handleArchiveCategory(c);
                  }}
                  aria-label={`Archive ${c.name}`}
                >
                  ×
                </Button>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Entries table */}
      <DataTable<HrFinanceEntry>
        data={entriesQuery.data ?? []}
        columns={expenseColumns}
        keyExtractor={(entry) => entry.id}
        loading={entriesQuery.isLoading}
        loadingMessage="Loading expenses…"
        emptyMessage="No HR expenses booked this year"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        compact
        className="rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm"
      />

      {modal.open && (
        <HrExpenseFormModal entry={modal.entry} onClose={() => setModal({ open: false })} />
      )}
    </div>
  );
};
