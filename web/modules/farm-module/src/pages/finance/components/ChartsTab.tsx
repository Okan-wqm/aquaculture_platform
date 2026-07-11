/**
 * Finance Charts tab — cost/revenue trend, per-category and per-batch
 * breakdowns.
 *
 * Chart discipline (dataviz): single y-axis per chart, expense/revenue
 * carry FIXED hues (blue = expense, green = revenue — the entity keeps
 * its color regardless of filtering), magnitude breakdowns use one hue,
 * legends present for two-series charts.
 */
import { parseMoney } from '@aquaculture/shared-ui';
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

import { useFinanceBatchTotals, type FinanceSummary } from '../../../hooks/useFinance';
import { useBatchList } from '../../../hooks/useBatches';
import type { FinancePeriod } from '../FinancePage';

/** Fixed series hues — expense/revenue never swap or cycle. */
const EXPENSE_COLOR = '#2563eb'; // blue-600
const REVENUE_COLOR = '#16a34a'; // green-600

interface ChartsTabProps {
  summary: FinanceSummary | undefined;
  isLoading: boolean;
  period: FinancePeriod;
}

function bucketLabel(iso: string, granularity: FinancePeriod['granularity']): string {
  // bucketStart is a canonical UTC midnight (backend emits YYYY-MM-DD in UTC).
  // Format in UTC so the label never shifts a day in negative-UTC locales.
  const date = new Date(iso);
  switch (granularity) {
    case 'DAY':
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    case 'WEEK':
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    case 'MONTH':
      return date.toLocaleDateString(undefined, { year: '2-digit', month: 'short', timeZone: 'UTC' });
    case 'YEAR':
      return String(date.getUTCFullYear());
    default:
      return iso.slice(0, 10);
  }
}

export const ChartsTab: React.FC<ChartsTabProps> = ({ summary, isLoading, period }) => {
  const batchTotalsQuery = useFinanceBatchTotals(period.from, period.to);
  const batchesQuery = useBatchList({});

  if (isLoading) {
    return <div className="py-16 text-center text-gray-500">Loading charts…</div>;
  }
  if (!summary) {
    return <div className="py-16 text-center text-gray-500">No finance data to chart.</div>;
  }

  const trendData = summary.series.map((bucket) => ({
    bucket: bucketLabel(bucket.bucketStart, period.granularity),
    Expense: parseMoney(bucket.totalExpenseDecimal),
    Revenue: parseMoney(bucket.totalRevenueDecimal),
  }));

  const categoryData = summary.byCategory
    .filter((c) => c.kind === 'EXPENSE' && parseMoney(c.totalDecimal) > 0)
    .map((c) => ({ name: c.categoryName, Expense: parseMoney(c.totalDecimal) }));

  const batchNameById = new Map(
    (batchesQuery.data?.items ?? []).map((b: { id: string; batchNumber?: string; name?: string }) => [
      b.id,
      b.batchNumber ?? b.name ?? b.id.slice(0, 8),
    ]),
  );
  const batchData = (batchTotalsQuery.data ?? []).slice(0, 15).map((row) => ({
    name: batchNameById.get(row.batchId) ?? row.batchId.slice(0, 8),
    Expense: parseMoney(row.totalExpenseDecimal),
    Revenue: parseMoney(row.totalRevenueDecimal),
  }));

  return (
    <div className="space-y-6">
      {/* Trend over time */}
      <div className="rounded-lg bg-white p-5 shadow">
        <h2 className="mb-4 text-base font-semibold text-gray-900">
          Cost & revenue trend ({period.granularity.toLowerCase()} buckets, {summary.currency})
        </h2>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="Expense" stroke={EXPENSE_COLOR} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="Revenue" stroke={REVENUE_COLOR} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Cost by category — magnitude job, one hue */}
        <div className="rounded-lg bg-white p-5 shadow">
          <h2 className="mb-4 text-base font-semibold text-gray-900">
            Operational cost by category ({summary.currency})
          </h2>
          {categoryData.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-500">No expense data in this period</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(240, categoryData.length * 34)}>
              <BarChart
                data={categoryData}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 8, left: 24 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={170} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="Expense" fill={EXPENSE_COLOR} radius={[0, 4, 4, 0]} barSize={18} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Cost & revenue per batch */}
        <div className="rounded-lg bg-white p-5 shadow">
          <h2 className="mb-4 text-base font-semibold text-gray-900">
            Cost & revenue per batch ({summary.currency})
          </h2>
          {batchData.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-500">
              No batch-linked finance data in this period
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(240, batchData.length * 40)}>
              <BarChart
                data={batchData}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 8, left: 24 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Expense" fill={EXPENSE_COLOR} radius={[0, 4, 4, 0]} barSize={12} />
                <Bar dataKey="Revenue" fill={REVENUE_COLOR} radius={[0, 4, 4, 0]} barSize={12} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
};
