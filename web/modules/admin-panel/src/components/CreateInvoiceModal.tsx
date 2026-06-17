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
  billingAddress: {
    companyName: string;
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
  }>;
  currency: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  notes?: string;
}

interface CreateInvoiceModalProps {
  /** Called when the user submits the form with valid data */
  onSubmit: (data: CreateInvoicePayload) => Promise<void>;
  /** Called when the user closes or cancels the modal */
  onClose: () => void;
}

interface CreateInvoiceFormState {
  tenantId: string;
  companyName: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  description: string;
  amount: string;
  currency: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** ISO date string for a given Date object (YYYY-MM-DD) */
const toDateInput = (date: Date): string => date.toISOString().split('T')[0];

/** Returns sensible default field values for a new invoice form */
function getDefaults(): CreateInvoiceFormState {
  const today = new Date();
  const dueDate = new Date(today);
  dueDate.setDate(dueDate.getDate() + 30);

  const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  return {
    tenantId: '',
    companyName: '',
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
    description: 'Platform billing charge',
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
    (field: keyof CreateInvoiceFormState, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      setError(null);
    },
    [],
  );

  const handleSubmit = async (): Promise<void> => {
    // Validate required fields before submitting
    if (!form.tenantId.trim()) {
      setError('Please enter a Tenant ID');
      return;
    }
    if (!form.companyName.trim() || !form.street.trim() || !form.city.trim() || !form.state.trim() || !form.postalCode.trim()) {
      setError('Please enter the billing address');
      return;
    }
    if (!form.description.trim()) {
      setError('Please enter a line item description');
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
        billingAddress: {
          companyName: form.companyName.trim(),
          street: form.street.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          postalCode: form.postalCode.trim(),
          country: form.country.trim() || 'US',
        },
        lineItems: [
          {
            description: form.description.trim(),
            quantity: 1,
            unitPrice: amount,
          },
        ],
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
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
            <label htmlFor="invoice-tenant-id" className="block text-sm font-medium text-gray-700 mb-1">Tenant ID *</label>
            <input
              id="invoice-tenant-id"
              type="text"
              value={form.tenantId}
              onChange={(e) => updateField('tenantId', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              placeholder="Enter tenant ID"
            />
          </div>
          <div>
            <label htmlFor="invoice-company-name" className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
            <input
              id="invoice-company-name"
              type="text"
              value={form.companyName}
              onChange={(e) => updateField('companyName', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              placeholder="Billing company"
            />
          </div>
          <div>
            <label htmlFor="invoice-street" className="block text-sm font-medium text-gray-700 mb-1">Street *</label>
            <input
              id="invoice-street"
              type="text"
              value={form.street}
              onChange={(e) => updateField('street', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              placeholder="Street address"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="invoice-city" className="block text-sm font-medium text-gray-700 mb-1">City *</label>
              <input
                id="invoice-city"
                type="text"
                value={form.city}
                onChange={(e) => updateField('city', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="invoice-state" className="block text-sm font-medium text-gray-700 mb-1">State *</label>
              <input
                id="invoice-state"
                type="text"
                value={form.state}
                onChange={(e) => updateField('state', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="invoice-postal-code" className="block text-sm font-medium text-gray-700 mb-1">Postal Code *</label>
              <input
                id="invoice-postal-code"
                type="text"
                value={form.postalCode}
                onChange={(e) => updateField('postalCode', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="invoice-country" className="block text-sm font-medium text-gray-700 mb-1">Country</label>
              <input
                id="invoice-country"
                type="text"
                value={form.country}
                onChange={(e) => updateField('country', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label htmlFor="invoice-line-item" className="block text-sm font-medium text-gray-700 mb-1">Line Item *</label>
            <input
              id="invoice-line-item"
              type="text"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              placeholder="Service period or custom charge"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="invoice-amount" className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  id="invoice-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.amount}
                  onChange={(e) => updateField('amount', e.target.value)}
                  className="w-full pl-7 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <label htmlFor="invoice-currency" className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
              <select
                id="invoice-currency"
                value={form.currency}
                onChange={(e) => updateField('currency', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="TRY">TRY</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="invoice-due-date" className="block text-sm font-medium text-gray-700 mb-1">Due Date *</label>
            <input
              id="invoice-due-date"
              type="date"
              value={form.dueDate}
              onChange={(e) => updateField('dueDate', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="invoice-period-start" className="block text-sm font-medium text-gray-700 mb-1">Period Start</label>
              <input
                id="invoice-period-start"
                type="date"
                value={form.periodStart}
                onChange={(e) => updateField('periodStart', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="invoice-period-end" className="block text-sm font-medium text-gray-700 mb-1">Period End</label>
              <input
                id="invoice-period-end"
                type="date"
                value={form.periodEnd}
                onChange={(e) => updateField('periodEnd', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
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
            onClick={() => {
              void handleSubmit();
            }}
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
