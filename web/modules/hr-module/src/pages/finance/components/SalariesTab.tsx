/**
 * Personnel Salary tab — annual salary per person per workforce category
 * plus the category totals. Read from the shared labour-cost snapshot.
 */
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import React from 'react';

import type { HrLabourCost, HrLabourCostRow } from '../../../hooks/useHrFinance';
import { formatMoney, laborCategoryLabel } from './financeFormat';

interface SalariesTabProps {
  data: HrLabourCost | undefined;
  isLoading: boolean;
}

const SUPPRESSED_TITLE =
  'Withheld — too few people in this category to show salary without identifying an individual';

const salaryColumns = (currency: string): DataTableColumn<HrLabourCostRow>[] => [
  {
    key: 'category',
    header: 'Category',
    render: (_value, row) => <span className="text-gray-900 dark:text-gray-100">{laborCategoryLabel(row.category)}</span>,
  },
  { key: 'headcount', header: 'Headcount' },
  {
    key: 'avgAnnualSalaryDecimal',
    header: 'Annual salary / person',
    render: (_value, row) => (
      <span title={row.salarySuppressed ? SUPPRESSED_TITLE : undefined}>
        {formatMoney(row.avgAnnualSalaryDecimal, currency)}
      </span>
    ),
  },
  {
    key: 'annualSalaryTotalDecimal',
    header: 'Annual salary total',
    align: 'right',
    render: (_value, row) => (
      <span
        className="font-medium text-gray-900 dark:text-gray-100"
        title={row.salarySuppressed ? SUPPRESSED_TITLE : undefined}
      >
        {formatMoney(row.annualSalaryTotalDecimal, currency)}
      </span>
    ),
  },
];

export const SalariesTab: React.FC<SalariesTabProps> = ({ data, isLoading }) => {
  if (isLoading) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading salaries…</div>;
  }
  if (!data) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">No salary data.</div>;
  }

  const rows = data.rows.filter((r) => r.headcount > 0);

  return (
    <DataTable<HrLabourCostRow>
      data={rows}
      columns={salaryColumns(data.currency)}
      keyExtractor={(row) => row.category ?? 'unclassified'}
      summaryRow={{
        category: 'Total annual salaries',
        annualSalaryTotalDecimal: formatMoney(data.annualSalaryTotalDecimal, data.currency),
      }}
      searchable={false}
      sortable={false}
      stickyHeader={false}
      className="rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm"
    />
  );
};
