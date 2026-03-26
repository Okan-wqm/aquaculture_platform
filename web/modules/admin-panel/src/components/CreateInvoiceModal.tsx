/**
 * Create Invoice Modal
 *
 * Self-contained modal for creating new invoices. Manages its own form
 * state internally and delegates the actual API call to the parent via
 * the onSubmit callback. This keeps the InvoicesPage under the 500-line
 * guideline while co-locating validation logic with the form UI.
 */

import React, { useState, useCallback } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface CreateInvoicePayload {
  tenantId: string;
  amount: number;
  currency: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
}

interface CreateInvoiceModalProps {
  /** Called when the user submits the form with valid data */
  onSubmit: (data: CreateInvoicePayload) => Promise<void>;
  /** Called when the user closes or cancels the modal */
  onClose: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** ISO date string for a given Date object (YYYY-MM-DD) */
const toDateInput = (date: Date): string => date.toISOString().split('T')[0];

/** Returns sensible default field values for a new invoice form */
function getDefaults() {
  const today = new Date();
  const dueDate = new Date(today);
  dueDate.setDate(dueDate.getDate() + 30);

  const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  return {
    tenantId: '',
    amount: '',
    currency: 'USD',
    dueDate: toDateInput(dueDate),
    periodStart: toDateInput(periodStart),
    periodEnd: toDateInput(periodEnd),
  };
}

// ============================================================================
// Component
// ============================================================================

const CreateInvoiceModal: React.FC<CreateInvoiceModalProps> = ({ onSubmit, onClose }) => {
  const [form, setForm] = useState(getDefaults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateField = useCallback(
    (field: keyof ReturnType<typeof getDefaults>, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      setError(null);
    },
    [],
  );

  const handleSubmit = async () => {
    // Validate required fields before submitting
    if (!form.tenantId.trim()) {
      setError('Please enter a Tenant ID');
      return;
    }
    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (!form.dueDate) {
      setError('Please enter a due date');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        tenantId: form.tenantId.trim(),
        amount,
        currency: form.currency,
        dueDate: form.dueDate,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Create Invoice</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-600"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Form */}
        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tenant ID *</label>
            <input
              type="text"
              value={form.tenantId}
              onChange={(e) => updateField('tenantId', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter tenant ID"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.amount}
                  onChange={(e) => updateField('amount', e.target.value)}
                  className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
              <select
                value={form.currency}
                onChange={(e) => updateField('currency', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="TRY">TRY</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Due Date *</label>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => updateField('dueDate', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period Start</label>
              <input
                type="date"
                value={form.periodStart}
                onChange={(e) => updateField('periodStart', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period End</label>
              <input
                type="date"
                value={form.periodEnd}
                onChange={(e) => updateField('periodEnd', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-6 border-t border-gray-200 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Invoice'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateInvoiceModal;
