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
import { useAuth } from '@aquaculture/shared-ui';
import {
  useInventoryCounts,
  InventoryCountStatus,
  InventoryCount,
} from '../../../hooks/useInventoryCounts';
import { StartInventoryCountModal } from './StartInventoryCountModal';
import { InventoryCountDetailModal } from './InventoryCountDetailModal';

/** Badge colors per status — consistent with other tabs in the storage module */
const statusColors: Record<string, string> = {
  PLANNED: 'bg-gray-100 text-gray-800',
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
    if (ic.status === InventoryCountStatus.PLANNED || ic.status === InventoryCountStatus.IN_PROGRESS) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); setSelectedCountId(ic.id); }}
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
          onClick={(e) => { e.stopPropagation(); setSelectedCountId(ic.id); }}
          className={`text-xs px-2 py-1 rounded ${
            isOwnCount
              ? 'bg-gray-50 text-gray-600 hover:bg-gray-100'
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
        onClick={(e) => { e.stopPropagation(); setSelectedCountId(ic.id); }}
        className="text-xs px-2 py-1 bg-gray-50 text-gray-600 rounded hover:bg-gray-100"
      >
        View
      </button>
    );
  };

  return (
    <div>
      {/* Header: filter + action bar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex gap-3">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          >
            <option value="">All Status</option>
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setIsStartModalOpen(true)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Start Count
        </button>
      </div>

      {/* Loading spinner */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error state with retry */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load inventory counts.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Main table */}
      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Count #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Items</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total Variance</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Performed By</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {counts.map(ic => (
                <tr
                  key={ic.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelectedCountId(ic.id)}
                >
                  <td className="px-6 py-4 text-sm font-medium text-gray-900 font-mono">
                    {ic.countNumber}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">
                    {ic.locationName || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {ic.startedAt
                      ? new Date(ic.startedAt).toLocaleDateString('nb-NO')
                      : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {ic.items.length}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className={ic.totalVariance !== 0 ? 'text-red-600 font-medium' : 'text-green-600'}>
                      {ic.totalVariance > 0 ? '+' : ''}{ic.totalVariance}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {ic.performedByName || ic.performedBy}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      statusColors[ic.status] || 'bg-gray-100 text-gray-800'
                    }`}>
                      {ic.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {getActionButton(ic)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {counts.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">
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
