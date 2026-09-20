/**
 * Manual HR expense entry create/edit modal (shared Modal primitive).
 * Currency defaults to the tenant setting when left blank.
 */
import React, { useState } from 'react';
import { Button, Input, Modal, Select, Textarea } from '@aquaculture/shared-ui';

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

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={entry ? 'Edit HR expense' : 'Add HR expense'}
      size="md"
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={isSaving}>
            {isSaving ? 'Saving…' : entry ? 'Save changes' : 'Add expense'}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Category"
          id="hr-expense-category"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          required
          placeholder="Select a category…"
          options={bookableCategories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Date"
            fullWidth
            id="hr-expense-date"
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            required
          />
          <Input
            label="Amount"
            fullWidth
            id="hr-expense-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
          />
        </div>
        <Textarea
          label="Description"
          fullWidth
          id="hr-expense-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Optional note (e.g. Q1 safety training)"
        />
        {errorMessage && (
          <div className="rounded-md bg-error-50 p-3 text-sm text-error-700 dark:bg-error-900/30 dark:text-error-300">
            {errorMessage}
          </div>
        )}
      </form>
    </Modal>
  );
};
