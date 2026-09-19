/**
 * Personnel Table tab — headcounts per workforce category + total.
 *
 * Unclassified employees (no laborCategory) surface as an explicit
 * warning row linking to the employee list, rather than being silently
 * folded into another bucket.
 */
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import React from 'react';
import { Link } from 'react-router-dom';

import type { HrPersonnelRow, HrPersonnelTable } from '../../../hooks/useHrFinance';
import { laborCategoryLabel } from './financeFormat';

interface PersonnelTableTabProps {
  data: HrPersonnelTable | undefined;
  isLoading: boolean;
  error: unknown;
}

const personnelColumns: DataTableColumn<HrPersonnelRow>[] = [
  {
    key: 'category',
    header: 'Personnel category',
    render: (_value, row) =>
      row.category === null ? (
        <span className="text-amber-800">
          Unclassified —{' '}
          <Link to="/hr/employees" className="font-medium underline">
            assign a category
          </Link>
        </span>
      ) : (
        <span className="text-gray-900 dark:text-gray-100">{laborCategoryLabel(row.category)}</span>
      ),
  },
  {
    key: 'headcount',
    header: 'Quantity',
    align: 'right',
    render: (_value, row) => <span className="font-medium">{row.headcount}</span>,
  },
];

export const PersonnelTableTab: React.FC<PersonnelTableTabProps> = ({ data, isLoading, error }) => {
  if (isLoading) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading personnel table…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
        Failed to load — manager or admin access is required to view HR finance data.
      </div>
    );
  }
  if (!data) {
    return <div className="py-16 text-center text-gray-500 dark:text-gray-400">No personnel data.</div>;
  }

  const classified = data.rows.filter((r) => r.category !== null);
  const unclassified = data.rows.find((r) => r.category === null);
  const rows = unclassified && unclassified.headcount > 0 ? [...classified, unclassified] : classified;

  return (
    <DataTable<HrPersonnelRow>
      data={rows}
      columns={personnelColumns}
      keyExtractor={(row) => row.category ?? 'unclassified'}
      rowClassName={(row) => (row.category === null ? 'bg-amber-50 text-amber-800' : '')}
      summaryRow={{ category: 'Number of employees', headcount: data.totalHeadcount }}
      searchable={false}
      sortable={false}
      stickyHeader={false}
      className="rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm"
    />
  );
};
