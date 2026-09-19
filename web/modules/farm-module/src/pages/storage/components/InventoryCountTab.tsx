/**
 * Inventory Count Tab — Lists all cycle count records with filtering and actions.
 *
 * This is the main entry point for warehouse staff and supervisors to manage
 * inventory counts. Supports the full lifecycle: start a new count, perform
 * counting, submit for review, and approve.
 *
 * Data is now served from the GraphQL backend via useInventoryCounts hook,
 * replacing the previous mock data implementation.
 */
import React, { useState } from 'react';
import { useAuth, DataTable, type DataTableColumn, Spinner, Button } from '@aquaculture/shared-ui';
import {
  useInventoryCounts,
  InventoryCountStatus,
  InventoryCount,
} from '../../../hooks/useInventoryCounts';
import { StartInventoryCountModal } from './StartInventoryCountModal';
import { InventoryCountDetailModal } from './InventoryCountDetailModal';
import { Plus } from 'lucide-react';

/** Badge colors per status — consistent with other tabs in the storage module */
const statusColors: Record<string, string> = {
  PLANNED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  APPROVED: 'bg-purple-100 text-purple-800',
};

/** All available status values for the filter dropdown */
const STATUS_OPTIONS: InventoryCountStatus[] = [
  InventoryCountStatus.PLANNED,
  InventoryCountStatus.IN_PROGRESS,
  InventoryCountStatus.COMPLETED,
  InventoryCountStatus.APPROVED,
];

export const InventoryCountTab: React.FC = () => {
  const { user } = useAuth();

  /* Filter state — status filter narrows the list for focused workflows */
  const [statusFilter, setStatusFilter] = useState<string>('');

  /* Modal visibility state */
  const [isStartModalOpen, setIsStartModalOpen] = useState(false);
  const [selectedCountId, setSelectedCountId] = useState<string | null>(null);

  /* Fetch counts with optional status filter */
  const { data, isLoading, error, refetch } = useInventoryCounts({
    status: statusFilter ? (statusFilter as InventoryCountStatus) : undefined,
  });

  const counts = data?.items || [];

  /**
   * Determine the primary action label and mode for each row.
   * This maps directly to the count lifecycle:
   * - PLANNED/IN_PROGRESS: counter can continue counting
   * - COMPLETED: supervisor can approve (if different user)
   * - APPROVED: anyone can view the finalized record
   */
  const getActionButton = (ic: InventoryCount) => {
    if (
      ic.status === InventoryCountStatus.PLANNED ||
      ic.status === InventoryCountStatus.IN_PROGRESS
    ) {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedCountId(ic.id);
          }}
          className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
        >
          Count
        </button>
      );
    }
    if (ic.status === InventoryCountStatus.COMPLETED) {
      /* Only show "Approve" if the current user is not the counter (segregation of duties) */
      const isOwnCount = user?.id === ic.performedBy;
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedCountId(ic.id);
          }}
          className={`text-xs px-2 py-1 rounded ${
            isOwnCount
              ? 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              : 'bg-green-50 text-green-700 hover:bg-green-100'
          }`}
        >
          {isOwnCount ? 'View' : 'Approve'}
        </button>
      );
    }
    /* APPROVED — read-only view */
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setSelectedCountId(ic.id);
        }}
        className="text-xs px-2 py-1 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        View
      </button>
    );
  };

  type IcRow = (typeof counts)[number];
  const icRowColumns: DataTableColumn<IcRow>[] = [
    {
      key: 'count',
      header: 'Count #',
      render: (_value, ic) => ic.countNumber,
    },
    {
      key: 'location',
      header: 'Location',
      render: (_value, ic) => ic.locationName || '-',
    },
    {
      key: 'date',
      header: 'Date',
      render: (_value, ic) => (
        <>{ic.startedAt ? new Date(ic.startedAt).toLocaleDateString('nb-NO') : '-'}</>
      ),
    },
    {
      key: 'items',
      header: 'Items',
      render: (_value, ic) => ic.items.length,
    },
    {
      key: 'totalVariance',
      header: 'Total Variance',
      render: (_value, ic) => (
        <span className={ic.totalVariance !== 0 ? 'text-red-600 font-medium' : 'text-green-600'}>
          {ic.totalVariance > 0 ? '+' : ''}
          {ic.totalVariance}
        </span>
      ),
    },
    {
      key: 'performedBy',
      header: 'Performed By',
      render: (_value, ic) => ic.performedByName || ic.performedBy,
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, ic) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              statusColors[ic.status] ||
              'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
            }`}
          >
            {ic.status.replace('_', ' ')}
          </span>
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, ic) => getActionButton(ic),
    },
  ];

  return (
    <div>
      {/* Header: filter + action bar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          >
            <option value="">All Status</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={() => setIsStartModalOpen(true)}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Start Count
        </Button>
      </div>

      {/* Loading spinner */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error state with retry */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load inventory counts.</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Main table */}
      {!isLoading && !error && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <DataTable<IcRow>
            data={counts}
            columns={icRowColumns}
            keyExtractor={(ic) => ic.id}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
          {counts.length === 0 && (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400 text-sm">
              No inventory counts found. Start a new count to reconcile your stock.
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <StartInventoryCountModal
        isOpen={isStartModalOpen}
        onClose={() => setIsStartModalOpen(false)}
      />
      <InventoryCountDetailModal
        isOpen={!!selectedCountId}
        onClose={() => setSelectedCountId(null)}
        countId={selectedCountId}
      />
    </div>
  );
};

export default InventoryCountTab;
