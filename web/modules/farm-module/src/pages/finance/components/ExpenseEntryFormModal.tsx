/**
 * Manual finance entry create/edit modal.
 *
 * Currency is optional — when left blank the backend books the entry in
 * the tenant's default currency (the finance_settings SSoT). Computed
 * categories (5% rules) are excluded from the picker; the backend
 * rejects them defensively as well.
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';

import {
  FinanceLineItem,
  useCreateFinanceEntry,
  useFinanceCategories,
  useUpdateFinanceEntry,
} from '../../../hooks/useFinance';

interface ExpenseEntryFormModalProps {
  /** When present (a MANUAL ledger line), the modal edits; otherwise creates. */
  entry?: FinanceLineItem;
  onClose: () => void;
}

export const ExpenseEntryFormModal: React.FC<ExpenseEntryFormModalProps> = ({ entry, onClose }) => {
  const categoriesQuery = useFinanceCategories();
  const createEntry = useCreateFinanceEntry();
  const updateEntry = useUpdateFinanceEntry();

  const [categoryId, setCategoryId] = useState(entry?.categoryId ?? '');
  const [entryDate, setEntryDate] = useState(entry?.entryDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState<string>(entry ? entry.amountDecimal : '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const bookableCategories = (categoriesQuery.data ?? []).filter(
    (c) => c.isActive && !c.computedRule,
  );

  const isSaving = createEntry.isPending || updateEntry.isPending;

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

  const formId = 'finance-expense-entry-form';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={entry ? 'Edit expense entry' : 'Add expense entry'}
      size="md"
      footer={
        <div className="flex justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={isSaving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : entry ? 'Save changes' : 'Add entry'}
          </button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="entry-category" className="block text-sm font-medium text-gray-700">
            Category
          </label>
          <select
            id="entry-category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            required
          >
            <option value="">Select a category…</option>
            {bookableCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.kind === 'REVENUE' ? '(revenue)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="entry-date" className="block text-sm font-medium text-gray-700">
              Date
            </label>
            <input
              id="entry-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              required
            />
          </div>
          <div>
            <label htmlFor="entry-amount" className="block text-sm font-medium text-gray-700">
              Amount
            </label>
            <input
              id="entry-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="0.00"
              required
            />
            <p className="mt-1 text-xs text-gray-500">Booked in the tenant default currency</p>
          </div>
        </div>

        <div>
          <label htmlFor="entry-description" className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            id="entry-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="Optional note (e.g. January electricity invoice)"
          />
        </div>

        {errorMessage && (
          <div role="alert" aria-live="assertive" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {errorMessage}
          </div>
        )}
      </form>
    </Modal>
  );
};
