/**
 * CleanerBatchList Component
 *
 * Displays a list of cleaner fish batches with status, quantities, and actions.
 */
import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import { CleanerFishBatch, CleanerFishSpecies } from '../../../hooks/useCleanerFish';
import { BatchStatusLabels, BatchStatusColors, SourceTypeLabels } from '../types';

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
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <div className="mx-auto h-12 w-12 text-gray-400">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
        </div>
        <h3 className="mt-2 text-sm font-medium text-gray-900">No cleaner fish batches</h3>
        <p className="mt-1 text-sm text-gray-500">
          Get started by creating a new cleaner fish batch.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-4 py-4 sm:px-6 flex items-center justify-between border-b border-gray-200">
        <h3 className="text-lg font-medium text-gray-900">Cleaner Fish Batches</h3>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Refresh
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Batch #
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Species
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Initial
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Current
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Deployed
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Source
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Status
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Stocked
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {batches.map((batch) => {
              const deployed = getDeployedQuantity(batch);
              const canDeploy = batch.currentQuantity > 0 && batch.status === 'ACTIVE';

              return (
                <tr key={batch.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-blue-600">{batch.batchNumber}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{batch.speciesName}</div>
                    <div className="text-xs text-gray-500">{batch.speciesCode}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="text-sm text-gray-900">
                      {batch.initialQuantity.toLocaleString()}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div
                      className={`text-sm font-medium ${
                        batch.currentQuantity === 0 ? 'text-gray-400' : 'text-gray-900'
                      }`}
                    >
                      {batch.currentQuantity.toLocaleString()}
                    </div>
                    {batch.currentQuantity === 0 && (
                      <span className="text-xs text-gray-400">Depleted</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="text-sm text-green-600">{deployed.toLocaleString()}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        batch.sourceType === 'farmed'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {SourceTypeLabels[batch.sourceType || 'farmed'] || batch.sourceType}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        BatchStatusColors[batch.status] || 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {BatchStatusLabels[batch.status] || batch.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(batch.stockedAt)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Summary Footer */}
      <div className="bg-gray-50 px-6 py-4 border-t border-gray-200">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">
            {batches.length} batch{batches.length !== 1 ? 'es' : ''}
          </span>
          <div className="flex items-center space-x-6">
            <span className="text-gray-500">
              Total Available:{' '}
              <span className="font-medium text-gray-900">
                {batches
                  .reduce((sum, b) => sum + b.currentQuantity, 0)
                  .toLocaleString()}
              </span>
            </span>
            <span className="text-gray-500">
              Total Deployed:{' '}
              <span className="font-medium text-green-600">
                {batches
                  .reduce((sum, b) => sum + getDeployedQuantity(b), 0)
                  .toLocaleString()}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CleanerBatchList;
