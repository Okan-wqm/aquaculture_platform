/**
 * Finance Settings tab — tenant default currency (the platform-wide
 * currency SSoT: feeding records, finance entries and — via the
 * FinanceSettingsUpdated event — HR payroll settings all resolve their
 * default from here) + fiscal year start month.
 *
 * Mutation is TENANT_ADMIN-only on the backend; the form surfaces the
 * authorisation error for non-admins.
 */
import { useCanMutate } from '@aquaculture/shared-ui';
import React, { useEffect, useState } from 'react';

import { useFinanceSettings, useUpdateFinanceSettings } from '../../../hooks/useFinance';

const CURRENCIES = ['NOK', 'EUR', 'USD', 'TRY', 'GBP', 'SEK', 'DKK'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const FinanceSettingsTab: React.FC = () => {
  const settingsQuery = useFinanceSettings();
  const updateSettings = useUpdateFinanceSettings();
  const canUpdateSettings = useCanMutate('updateFinanceSettings');

  const [currency, setCurrency] = useState('NOK');
  const [fiscalMonth, setFiscalMonth] = useState(1);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setCurrency(settingsQuery.data.defaultCurrency);
      setFiscalMonth(settingsQuery.data.fiscalYearStartMonth);
    }
  }, [settingsQuery.data]);

  const handleSave = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setMessage(null);
    try {
      await updateSettings.mutateAsync({
        defaultCurrency: currency,
        fiscalYearStartMonth: fiscalMonth,
      });
      setMessage({ kind: 'ok', text: 'Finance settings saved.' });
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof Error && err.message.includes('Forbidden')
            ? 'Only a tenant admin can change finance settings.'
            : 'Saving finance settings failed.',
      });
    }
  };

  return (
    <div className="max-w-xl">
      <form onSubmit={handleSave} className="space-y-5 rounded-lg bg-white p-6 shadow">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Finance settings</h2>
          <p className="mt-1 text-sm text-gray-500">
            The default currency is the single source of truth for every module — feeding
            records, finance entries and HR payroll settings all resolve their default from
            here.
          </p>
        </div>

        <div>
          <label htmlFor="default-currency" className="block text-sm font-medium text-gray-700">
            Default currency
          </label>
          <select
            id="default-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="mt-1 block w-40 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="fiscal-month" className="block text-sm font-medium text-gray-700">
            Fiscal year starts in
          </label>
          <select
            id="fiscal-month"
            value={fiscalMonth}
            onChange={(e) => setFiscalMonth(Number(e.target.value))}
            className="mt-1 block w-48 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            {MONTHS.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {message && (
          <div
            className={`rounded-md p-3 text-sm ${
              message.kind === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}
          >
            {message.text}
          </div>
        )}

        {canUpdateSettings && (
          <div className="border-t border-gray-200 pt-4">
            <button
              type="submit"
              disabled={updateSettings.isPending || settingsQuery.isLoading}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {updateSettings.isPending ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
};
