/**
 * Manual finance entry create/edit modal.
 *
 * Currency is optional — when left blank the backend books the entry in
 * the tenant's default currency (the finance_settings SSoT). Computed
 * categories (5% rules) are excluded from the picker; the backend
 * rejects them defensively as well.
 */
import React, { useState } from 'react';
import { Modal, Button, Input, Select, Textarea } from '@aquaculture/shared-ui';

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
  const [entryDate, setEntryDate] = useState(
    entry?.entryDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  );
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
          input: {
            categoryId,
            entryDate,
            amount: parsedAmount,
            description: description || undefined,
          },
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
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={isSaving}>
            {isSaving ? 'Saving…' : entry ? 'Save changes' : 'Add entry'}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Select
            id="entry-category"
            label="Category"
            required
            placeholder="Select a category…"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            options={bookableCategories.map((c) => ({
              value: c.id,
              label: `${c.name} ${c.kind === 'REVENUE' ? '(revenue)' : ''}`,
            }))}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="entry-date"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Date
            </label>
            <Input
              fullWidth
              id="entry-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label
              htmlFor="entry-amount"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Amount
            </label>
            <Input
              fullWidth
              id="entry-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Booked in the tenant default currency
            </p>
          </div>
        </div>

        <div>
          <label
            htmlFor="entry-description"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Description
          </label>
          <Textarea
            fullWidth
            id="entry-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional note (e.g. January electricity invoice)"
          />
        </div>

        {errorMessage && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md bg-error-50 dark:bg-error-900/20 p-3 text-sm text-error-700 dark:text-error-300"
          >
            {errorMessage}
          </div>
        )}
      </form>
    </Modal>
  );
};
