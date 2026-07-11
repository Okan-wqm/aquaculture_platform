/**
 * Finance Expenses tab — the unified ledger.
 *
 * MANUAL rows: edit/delete inline (they live in finance_expense_entries).
 * DERIVED rows: read-only projections of a source record — the row's
 * "Edit at source" link routes to the form that owns the data (feeding
 * records, batch detail, maintenance, health, harvest), preserving the
 * single source of truth.
 */
import { ConfirmModal, useCanMutate } from '@aquaculture/shared-ui';
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          <label htmlFor="origin-filter" className="text-sm text-gray-600">
            Show:
          </label>
          <select
            id="origin-filter"
            value={originFilter}
            onChange={(e) => {
              setOriginFilter(e.target.value as typeof originFilter);
              setOffset(0);
            }}
            className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="ALL">All entries</option>
            <option value="MANUAL">Manual entries</option>
            <option value="DERIVED">Auto (from records)</option>
          </select>
        </div>
        {canCreate && (
        <button
          onClick={() => setModalState({ open: true })}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          + Add expense
        </button>
        )}
      </div>

      {ledgerQuery.isLoading && (
        <div className="py-16 text-center text-gray-500">Loading ledger…</div>
      )}
      {Boolean(ledgerQuery.error) && (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          Failed to load the ledger. Manager or admin access is required.
        </div>
      )}

      {!ledgerQuery.isLoading && !ledgerQuery.error && (
        <div className="overflow-hidden rounded-lg bg-white shadow">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {['Date', 'Category', 'Description', 'Amount', 'Source', ''].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                      No ledger entries in this period
                    </td>
                  </tr>
                )}
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                      {item.entryDate.slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">
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
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-sm text-gray-500">
                      {item.description ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                      {formatMoney(item.amount, item.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      {item.origin === 'MANUAL' ? (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                          manual
                        </span>
                      ) : (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                          auto · {item.sourceDomain}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                      {item.editable ? (
                        <span className="space-x-3">
                          {canUpdate && (
                            <button
                              onClick={() => setModalState({ open: true, entry: item })}
                              className="font-medium text-blue-600 hover:text-blue-800"
                            >
                              Edit
                            </button>
                          )}
                          {canDelete && (
                            <button
                              onClick={() => setPendingDelete(item.id)}
                              className="font-medium text-red-600 hover:text-red-800"
                            >
                              Delete
                            </button>
                          )}
                          {!canUpdate && !canDelete && (
                            <span className="text-xs text-gray-400">—</span>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-40"
            >
              ← Previous
            </button>
            <span className="text-sm text-gray-500">
              {offset + 1}–{offset + items.length}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={(ledgerQuery.data?.length ?? 0) < PAGE_SIZE}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-40"
            >
              Next →
            </button>
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
