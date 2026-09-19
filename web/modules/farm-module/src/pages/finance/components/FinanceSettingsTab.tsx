/**
 * Finance Settings tab — tenant default currency (the platform-wide
 * currency SSoT: feeding records, finance entries and — via the
 * FinanceSettingsUpdated event — HR payroll settings all resolve their
 * default from here) + fiscal year start month.
 *
 * Mutation is TENANT_ADMIN-only on the backend; the form surfaces the
 * authorisation error for non-admins.
 */
import { useCanMutate, Button, Select } from '@aquaculture/shared-ui';
import React, { useEffect, useState } from 'react';

import { useFinanceSettings, useUpdateFinanceSettings } from '../../../hooks/useFinance';

const CURRENCIES = ['NOK', 'EUR', 'USD', 'TRY', 'GBP', 'SEK', 'DKK'];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
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
      <form
        onSubmit={handleSave}
        className="space-y-5 rounded-lg bg-white dark:bg-gray-900 p-6 shadow"
      >
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Finance settings
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            The default currency is the single source of truth for every module — feeding records,
            finance entries and HR payroll settings all resolve their default from here.
          </p>
        </div>

        <div>
          <Select
            id="default-currency"
            label="Default currency"
            fullWidth={false}
            className="w-40"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
        </div>

        <div>
          <Select
            id="fiscal-month"
            label="Fiscal year starts in"
            fullWidth={false}
            className="w-48"
            value={fiscalMonth}
            onChange={(e) => setFiscalMonth(Number(e.target.value))}
            options={MONTHS.map((name, index) => ({ value: index + 1, label: name }))}
          />
        </div>

        {message && (
          <div
            className={`rounded-md p-3 text-sm ${
              message.kind === 'ok'
                ? 'bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300'
                : 'bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-300'
            }`}
          >
            {message.text}
          </div>
        )}

        {canUpdateSettings && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <Button
              variant="primary"
              type="submit"
              disabled={updateSettings.isPending || settingsQuery.isLoading}
            >
              {updateSettings.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
};
