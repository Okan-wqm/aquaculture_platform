/**
 * CleanerBatchList Component
 *
 * Displays a list of cleaner fish batches with status, quantities, and actions.
 */
import React from 'react';
import { Button, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import { CleanerFishBatch, CleanerFishSpecies } from '../../../hooks/useCleanerFish';
import { BatchStatusLabels, BatchStatusColors, SourceTypeLabels } from '../types';
import { Inbox, RefreshCw } from 'lucide-react';

interface CleanerBatchListProps {
  batches: (CleanerFishBatch & { speciesName?: string; speciesCode?: string })[];
  species: CleanerFishSpecies[];
  onDeploy: (batch: CleanerFishBatch) => void;
  onRefresh: () => void;
}

export const CleanerBatchList: React.FC<CleanerBatchListProps> = ({
  batches,
  species,
  onDeploy,
  onRefresh,
}) => {
  // Calculate deployed quantity
  const getDeployedQuantity = (batch: CleanerFishBatch) => {
    return batch.initialQuantity - batch.currentQuantity - (batch.totalMortality || 0);
  };

  // Format date
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };

  if (batches.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-8 text-center">
        <div className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500">
          <Inbox aria-hidden="true" />
        </div>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          No cleaner fish batches
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Get started by creating a new cleaner fish batch.
        </p>
      </div>
    );
  }

  type BatchRow = (typeof batches)[number];
  const batchRowColumns: DataTableColumn<BatchRow>[] = [
    {
      key: 'batch',
      header: 'Batch #',
      render: (_value, batch) => (
        <div className="text-sm font-medium text-info-600 dark:text-info-400">
          {batch.batchNumber}
        </div>
      ),
    },
    {
      key: 'species',
      header: 'Species',
      render: (_value, batch) => (
        <>
          <div className="text-sm text-gray-900 dark:text-gray-100">{batch.speciesName}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{batch.speciesCode}</div>
        </>
      ),
    },
    {
      key: 'initial',
      header: 'Initial',
      align: 'right',
      render: (_value, batch) => (
        <div className="text-sm text-gray-900 dark:text-gray-100">
          {batch.initialQuantity.toLocaleString()}
        </div>
      ),
    },
    {
      key: 'current',
      header: 'Current',
      align: 'right',
      render: (_value, batch) => (
        <>
          <div
            className={`text-sm font-medium ${
              batch.currentQuantity === 0
                ? 'text-gray-400 dark:text-gray-500'
                : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {batch.currentQuantity.toLocaleString()}
          </div>
          {batch.currentQuantity === 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">Depleted</span>
          )}
        </>
      ),
    },
    {
      key: 'deployed',
      header: 'Deployed',
      align: 'right',
      render: (_value, batch) => {
        const deployed = getDeployedQuantity(batch);
        return (
          <div className="text-sm text-success-600 dark:text-success-400">
            {deployed.toLocaleString()}
          </div>
        );
      },
    },
    {
      key: 'source',
      header: 'Source',
      render: (_value, batch) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              batch.sourceType === 'farmed'
                ? 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200'
                : 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200'
            }`}
          >
            {SourceTypeLabels[batch.sourceType || 'farmed'] || batch.sourceType}
          </span>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, batch) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              BatchStatusColors[batch.status] ||
              'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
            }`}
          >
            {BatchStatusLabels[batch.status] || batch.status}
          </span>
        </>
      ),
    },
    {
      key: 'stocked',
      header: 'Stocked',
      render: (_value, batch) => formatDate(batch.stockedAt),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, batch) => {
        const canDeploy = batch.currentQuantity > 0 && batch.status === 'ACTIVE';
        return (
          <div className="flex items-center justify-end space-x-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onDeploy(batch)}
              disabled={!canDeploy}
              title={canDeploy ? 'Deploy to tank' : 'No fish available to deploy'}
            >
              Deploy
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
      <div className="px-4 py-4 sm:px-6 flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          Cleaner Fish Batches
        </h3>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          <RefreshCw className="w-4 h-4 mr-1" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <DataTable<BatchRow>
        data={batches}
        columns={batchRowColumns}
        keyExtractor={(batch) => batch.id}
        emptyMessage="No records found"
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />

      {/* Summary Footer */}
      <div className="bg-gray-50 dark:bg-gray-800 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            {batches.length} batch{batches.length !== 1 ? 'es' : ''}
          </span>
          <div className="flex items-center space-x-6">
            <span className="text-gray-500 dark:text-gray-400">
              Total Available:{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {batches.reduce((sum, b) => sum + b.currentQuantity, 0).toLocaleString()}
              </span>
            </span>
            <span className="text-gray-500 dark:text-gray-400">
              Total Deployed:{' '}
              <span className="font-medium text-success-600 dark:text-success-400">
                {batches.reduce((sum, b) => sum + getDeployedQuantity(b), 0).toLocaleString()}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CleanerBatchList;
