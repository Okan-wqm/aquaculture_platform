/**
 * Labour Cost tab — the full Labour Cost table (salary totals + fund
 * projections + total payroll), with the tenant's fund percentages
 * editable inline (the funds recompute from the shared snapshot).
 *
 * Fund rates default to 0 — the tenant admin enters their jurisdiction's
 * employer rates. defaultCurrency is read-only here: it is projected from
 * the farm finance settings SSoT, so it is changed there, not here.
 */
import React, { useEffect, useState } from 'react';
import { Button, Input } from '@aquaculture/shared-ui';

import {
  type HrLabourCost,
  usePayrollCostSettings,
  useUpdatePayrollCostSettings,
} from '../../../hooks/useHrFinance';
import { formatMoney } from './financeFormat';

interface LabourCostTabProps {
  data: HrLabourCost | undefined;
  isLoading: boolean;
}

export const LabourCostTab: React.FC<LabourCostTabProps> = ({ data, isLoading }) => {
  const settingsQuery = usePayrollCostSettings();
  const updateSettings = useUpdatePayrollCostSettings();

  const [pension, setPension] = useState('0');
  const [social, setSocial] = useState('0');
  const [medical, setMedical] = useState('0');
  const [other, setOther] = useState('5');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setPension(String(settingsQuery.data.pensionFundPct));
      setSocial(String(settingsQuery.data.socialInsurancePct));
      setMedical(String(settingsQuery.data.medicalInsurancePct));
      setOther(String(settingsQuery.data.otherCostPct));
    }
  }, [settingsQuery.data]);

  const handleSaveRates = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setMessage(null);
    try {
      await updateSettings.mutateAsync({
        pensionFundPct: Number(pension),
        socialInsurancePct: Number(social),
        medicalInsurancePct: Number(medical),
        otherCostPct: Number(other),
      });
      setMessage({ kind: 'ok', text: 'Fund rates saved — labour cost recalculated.' });
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof Error && err.message.includes('Forbidden')
            ? 'Only a tenant admin can change fund rates.'
            : 'Saving the fund rates failed.',
      });
    }
  };

  if (isLoading || !data) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading labour cost…</div>;
  }

  const currency = data.currency;
  // A label/value ledger, not a data grid: a definition list carries the
  // semantics without a header-less grid.
  const line = (label: string, value: number | string, strong = false) => (
    <div
      className={`flex items-center justify-between gap-4 px-5 py-3 text-sm text-gray-900 dark:text-gray-100 ${
        strong ? 'bg-gray-50 font-semibold dark:bg-gray-900/40' : ''
      }`}
    >
      <dt>{label}</dt>
      <dd className={strong ? 'font-semibold' : 'font-medium'}>{formatMoney(value, currency)}</dd>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Labour Cost table */}
      <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 lg:col-span-2">
        <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Labour Cost</h2>
        </div>
        <dl className="divide-y divide-gray-100 dark:divide-gray-700">
            {line('Annual salaries', data.annualSalaryTotalDecimal)}
            {line(`Pension fund (${settingsQuery.data?.pensionFundPct ?? 0}%)`, data.pensionFundDecimal)}
            {line(`Social insurance fund (${settingsQuery.data?.socialInsurancePct ?? 0}%)`, data.socialInsuranceFundDecimal)}
            {line(`Compulsory medical insurance fund (${settingsQuery.data?.medicalInsurancePct ?? 0}%)`, data.medicalInsuranceFundDecimal)}
            {line(`Other cost (${settingsQuery.data?.otherCostPct ?? 5}% of annual salaries)`, data.otherCostDecimal)}
            {line('Total Payroll', data.totalPayrollDecimal, true)}
        </dl>
        <div className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          Actual gross pay booked this year: {formatMoney(data.actualGrossPayYtdDecimal, currency)} ·
          HR expenses: {formatMoney(data.hrExpensesYtdDecimal, currency)}
        </div>
      </div>

      {/* Fund rates editor */}
      <form
        onSubmit={handleSaveRates}
        className="space-y-4 rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Fund rates</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Employer contribution percentages applied to the annual salary base.
        </p>
        {(
          [
            ['Pension fund %', pension, setPension],
            ['Social insurance %', social, setSocial],
            ['Compulsory medical %', medical, setMedical],
            ['Other cost %', other, setOther],
          ] as Array<[string, string, React.Dispatch<React.SetStateAction<string>>]>
        ).map(([label, value, setter]) => (
          <div key={label}>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
            <Input type="number" min="0" max="100" step="0.01" value={value} onChange={(e) => setter(e.target.value)} />
          </div>
        ))}
        {message && (
          <div
            className={`rounded-md p-2 text-sm ${
              message.kind === 'ok'
                ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
            }`}
          >
            {message.text}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={updateSettings.isPending}>{updateSettings.isPending ? 'Saving…' : 'Save rates'}</Button>
      </form>
    </div>
  );
};
