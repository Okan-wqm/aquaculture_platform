/**
 * Manual HR expense entry create/edit modal (shared Modal primitive).
 * Currency defaults to the tenant setting when left blank.
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';

import {
  type HrFinanceEntry,
  useCreateHrFinanceEntry,
  useHrFinanceCategories,
  useUpdateHrFinanceEntry,
} from '../../../hooks/useHrFinance';

interface HrExpenseFormModalProps {
  entry?: HrFinanceEntry;
  onClose: () => void;
}

export const HrExpenseFormModal: React.FC<HrExpenseFormModalProps> = ({ entry, onClose }) => {
  const categoriesQuery = useHrFinanceCategories();
  const createEntry = useCreateHrFinanceEntry();
  const updateEntry = useUpdateHrFinanceEntry();

  const [categoryId, setCategoryId] = useState(entry?.categoryId ?? '');
  const [entryDate, setEntryDate] = useState(
    entry?.entryDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState<string>(entry ? String(entry.amount) : '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const bookableCategories = (categoriesQuery.data ?? []).filter(
    (c) => c.isActive && !c.computedRule,
  );
  const isSaving = createEntry.isPending || updateEntry.isPending;
  const formId = 'hr-expense-entry-form';

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setErrorMessage(null);
    const parsedAmount = Number(amount);
    if (!categoryId || !entryDate || !Number.isFinite(parsedAmount) || parsedAmount < 0) {
      setErrorMessage('Category, date and a non-negative amount are required.');
      return;
    }
    try {
      if (entry) {
        await updateEntry.mutateAsync({
          id: entry.id,
          input: { categoryId, entryDate, amount: parsedAmount, description: description || undefined },
        });
      } else {
        await createEntry.mutateAsync({
          categoryId,
          entryDate,
          amount: parsedAmount,
          description: description || undefined,
        });
      }
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Saving the entry failed.');
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={entry ? 'Edit HR expense' : 'Add HR expense'}
      size="md"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={isSaving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : entry ? 'Save changes' : 'Add expense'}
          </button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="hr-expense-category" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Category
          </label>
          <select
            id="hr-expense-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            required
          >
            <option value="">Select a category…</option>
            {bookableCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="hr-expense-date" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Date
            </label>
            <input
              id="hr-expense-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
              required
            />
          </div>
          <div>
            <label htmlFor="hr-expense-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Amount
            </label>
            <input
              id="hr-expense-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
              placeholder="0.00"
              required
            />
          </div>
        </div>
        <div>
          <label htmlFor="hr-expense-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Description
          </label>
          <textarea
            id="hr-expense-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            placeholder="Optional note (e.g. Q1 safety training)"
          />
        </div>
        {errorMessage && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {errorMessage}
          </div>
        )}
      </form>
    </Modal>
  );
};
