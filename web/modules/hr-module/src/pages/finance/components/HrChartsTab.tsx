/**
 * HR Finance Charts tab — payroll/expense trend + per-department cost.
 *
 * Chart discipline (dataviz): single y-axis, fixed series hues (payroll
 * = indigo, expenses = amber), legend present for the two-series trend.
 */
import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useHrFinanceSummary, type HrFinanceGranularity } from '../../../hooks/useHrFinance';

const PAYROLL_COLOR = '#4f46e5'; // indigo-600
const EXPENSE_COLOR = '#d97706'; // amber-600

interface HrChartsTabProps {
  period: { from: string; to: string; granularity: HrFinanceGranularity };
  /** Whether the caller may see salary/payroll figures (HR-MEDIUM-005). */
  canViewSalary: boolean;
}

export const HrChartsTab: React.FC<HrChartsTabProps> = ({ period, canViewSalary }) => {
  const summaryQuery = useHrFinanceSummary(period.from, period.to, period.granularity);

  if (summaryQuery.isLoading) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading charts…</div>;
  }
  if (!summaryQuery.data) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">No HR finance data to chart.</div>;
  }

  const summary = summaryQuery.data;
  const trendData = summary.series.map((bucket) => ({
    bucket: new Date(bucket.bucketStart).toLocaleDateString(undefined, {
      year: '2-digit',
      month: 'short',
    }),
    // payrollGross is null when the caller lacks the salary permission — the
    // Payroll series is hidden entirely in that case (not plotted as 0).
    Payroll: bucket.payrollGross ?? 0,
    Expenses: bucket.hrExpenses,
  }));

  const departmentData = summary.byDepartment
    .slice(0, 15)
    // A suppressed department salary (HR-HIGH-001 small cell OR HR-MEDIUM-005 no
    // permission) arrives as null; the Salary bar is hidden rather than 0-plotted.
    .map((d) => ({ name: d.departmentName, Salary: d.annualSalaryTotal ?? 0, Expenses: d.hrExpenses }));

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
          Payroll & HR expense trend ({summary.currency})
        </h2>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {canViewSalary && (
              <Line type="monotone" dataKey="Payroll" stroke={PAYROLL_COLOR} strokeWidth={2} dot={false} />
            )}
            <Line type="monotone" dataKey="Expenses" stroke={EXPENSE_COLOR} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">
          Cost by department ({summary.currency})
        </h2>
        {departmentData.length === 0 ? (
          <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            No department cost data
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(240, departmentData.length * 40)}>
            <BarChart
              data={departmentData}
              layout="vertical"
              margin={{ top: 8, right: 16, bottom: 8, left: 24 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12 }} />
              <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              {canViewSalary && (
                <Bar dataKey="Salary" fill={PAYROLL_COLOR} radius={[0, 4, 4, 0]} barSize={12} />
              )}
              <Bar dataKey="Expenses" fill={EXPENSE_COLOR} radius={[0, 4, 4, 0]} barSize={12} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
