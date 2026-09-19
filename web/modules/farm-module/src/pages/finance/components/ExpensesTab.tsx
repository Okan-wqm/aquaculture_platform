/**
 * Finance Expenses tab — the unified ledger.
 *
 * MANUAL rows: edit/delete inline (they live in finance_expense_entries).
 * DERIVED rows: read-only projections of a source record — the row's
 * "Edit at source" link routes to the form that owns the data (feeding
 * records, batch detail, maintenance, health, harvest), preserving the
 * single source of truth.
 */
import { ConfirmModal, useCanMutate, DataTable, type DataTableColumn, Button, Select } from '@aquaculture/shared-ui';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  FinanceLineItem,
  useDeleteFinanceEntry,
  useFinanceLedger,
} from '../../../hooks/useFinance';
import type { FinancePeriod } from '../FinancePage';
import { ExpenseEntryFormModal } from './ExpenseEntryFormModal';
import { formatMoney } from './OverviewTab';

const PAGE_SIZE = 50;

/** Route the "edit at source" link per derived source domain. */
function sourceEditPath(item: FinanceLineItem): string {
  switch (item.sourceDomain) {
    case 'feeding':
      return '/sites/feeding?tab=records';
    case 'batch':
      return item.batchId ? `/sites/batch/${item.batchId}` : '/sites/tanks';
    case 'maintenance':
      return '/sites/maintenance';
    case 'fish-health':
      return '/sites/health';
    case 'harvest':
      return '/sites/harvest';
    default:
      return '/sites/map';
  }
}

interface ExpensesTabProps {
  period: FinancePeriod;
}

export const ExpensesTab: React.FC<ExpensesTabProps> = ({ period }) => {
  const [offset, setOffset] = useState(0);
  const [originFilter, setOriginFilter] = useState<'ALL' | 'MANUAL' | 'DERIVED'>('ALL');
  const [modalState, setModalState] = useState<{ open: boolean; entry?: FinanceLineItem }>({
    open: false,
  });

  const ledgerQuery = useFinanceLedger({
    from: period.from,
    to: period.to,
    includeDerived: originFilter !== 'MANUAL',
    limit: PAGE_SIZE,
    offset,
  });
  const deleteEntry = useDeleteFinanceEntry();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const canCreate = useCanMutate('createFinanceEntry');
  const canUpdate = useCanMutate('updateFinanceEntry');
  const canDelete = useCanMutate('deleteFinanceEntry');

  const items = (ledgerQuery.data ?? []).filter(
    (item) => originFilter === 'ALL' || item.origin === originFilter,
  );

  type ItemRow = (typeof items)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (_value, item) => item.entryDate.slice(0, 10),
    },
    {
      key: 'category',
      header: 'Category',
      render: (_value, item) => (
        <>
          {item.categoryName}
          {item.kind === 'REVENUE' && (
            <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
              revenue
            </span>
          )}
          {item.estimated && (
            <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700">
              estimate
            </span>
          )}
        </>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (_value, item) => item.description ?? '—',
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (_value, item) => formatMoney(item.amountDecimal, item.currency),
    },
    {
      key: 'source',
      header: 'Source',
      render: (_value, item) => (
        <>
          {item.origin === 'MANUAL' ? (
            <span className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-400">
              manual
            </span>
          ) : (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
              auto · {item.sourceDomain}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'col',
      header: '',
      render: (_value, item) => (
        <>
          {item.editable ? (
            <span className="space-x-3">
              {canUpdate && (
                <Button variant="ghost" onClick={() => setModalState({ open: true, entry: item })}>Edit</Button>
              )}
              {canDelete && (
                <Button variant="ghost" onClick={() => setPendingDelete(item.id)}>Delete</Button>
              )}
              {!canUpdate && !canDelete && (
                <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
              )}
            </span>
          ) : (
            <Link
              to={sourceEditPath(item)}
              className="font-medium text-blue-600 hover:text-blue-800"
            >
              Edit at source →
            </Link>
          )}
        </>
      ),
    }
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          <label htmlFor="origin-filter" className="text-sm text-gray-600 dark:text-gray-400">
            Show:
          </label>
          <Select options={[{ value: 'ALL', label: 'All entries' }, { value: 'MANUAL', label: 'Manual entries' }, { value: 'DERIVED', label: 'Auto (from records)' }]} id="origin-filter" value={originFilter} onChange={(e) => {
       setOriginFilter(e.target.value as typeof originFilter);
       setOffset(0);
      }} />
        </div>
        {canCreate && (
        <Button variant="primary" onClick={() => setModalState({ open: true })}>+ Add expense</Button>
        )}
      </div>

      {ledgerQuery.isLoading && (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400">Loading ledger…</div>
      )}
      {Boolean(ledgerQuery.error) && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          Failed to load the ledger. Manager or admin access is required.
        </div>
      )}

      {!ledgerQuery.isLoading && !ledgerQuery.error && (
        <div className="overflow-hidden rounded-lg bg-white dark:bg-gray-900 shadow">
          <DataTable<ItemRow>
            data={items}
            columns={itemRowColumns}
            keyExtractor={(item) => item.id}
            emptyMessage="No ledger entries in this period"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 px-4 py-3">
            <Button variant="secondary" size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>← Previous</Button>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {offset + 1}–{offset + items.length}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={(ledgerQuery.data?.length ?? 0) < PAGE_SIZE}>Next →</Button>
          </div>
        </div>
      )}

      {modalState.open && (
        <ExpenseEntryFormModal
          entry={modalState.entry}
          onClose={() => setModalState({ open: false })}
        />
      )}

      <ConfirmModal
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) {
            deleteEntry.mutate(pendingDelete);
          }
          setPendingDelete(null);
        }}
        title="Delete finance entry"
        message="Delete this finance entry? This cannot be undone."
        variant="danger"
        confirmText="Delete"
        isLoading={deleteEntry.isPending}
      />
    </div>
  );
};
