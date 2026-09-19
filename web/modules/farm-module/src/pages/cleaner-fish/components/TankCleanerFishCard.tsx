/**
 * TankCleanerFishCard Component
 *
 * Displays cleaner fish information for a single tank.
 * Shows all cleaner fish species/batches deployed to the tank.
 */
import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import { useTankCleanerFish } from '../../../hooks/useCleanerFish';
import { isBlockingError } from '../../../utils/list-view-state';
import { SourceTypeLabels } from '../types';
import { Inbox } from 'lucide-react';

interface TankCleanerFishCardProps {
  tankId: string;
  tankName: string;
  tankCode: string;
  onTransfer: (tankId: string, batchId: string) => void;
  onMortality: (tankId: string, batchId: string) => void;
  onRemove: (tankId: string, batchId: string) => void;
}

export const TankCleanerFishCard: React.FC<TankCleanerFishCardProps> = ({
  tankId,
  tankName,
  tankCode,
  onTransfer,
  onMortality,
  onRemove,
}) => {
  const { data: tankInfo, isLoading, error, refetch } = useTankCleanerFish(tankId);

  // Format date
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
    });
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6 animate-pulse">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-4" />
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/2 mb-4" />
        <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
    );
  }

  // Blocking error — ONLY when the initial load failed and there is no cached
  // tank info. A failed background refetch with cached data keeps rendering the
  // card and surfaces a non-blocking strip below (stale-on-error).
  if (isBlockingError(error, Boolean(tankInfo))) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{tankName}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">{tankCode}</p>
          </div>
        </div>
        <p className="text-sm text-error-500">Failed to load cleaner fish info</p>
      </div>
    );
  }

  const hasCleanerFish = tankInfo && tankInfo.cleanerFishQuantity > 0;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
      {/* Non-blocking refresh error — keeps the last-loaded card visible. */}
      {error && (
        <div className="flex items-center justify-between border-b border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 px-4 py-2">
          <p className="text-xs text-warning-800 dark:text-warning-200">
            Couldn&apos;t refresh — showing the last loaded data.
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-warning-100 dark:bg-warning-900/40 px-2 py-0.5 text-xs text-warning-800 dark:text-warning-200 hover:bg-warning-200 dark:hover:bg-warning-800/60"
          >
            Retry
          </button>
        </div>
      )}

      {/* Header */}
      <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{tankName}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">{tankCode}</p>
          </div>
          <div className="text-right">
            {hasCleanerFish ? (
              <>
                <p className="text-2xl font-bold text-info-600 dark:text-info-400">
                  {tankInfo.cleanerFishQuantity.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">fish</p>
              </>
            ) : (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                No cleaner fish
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      {hasCleanerFish && (
        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Biomass:</span>{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {tankInfo.cleanerFishBiomassKg.toFixed(1)} kg
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Ratio:</span>{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {(tankInfo.cleanerFishRatio * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Details List */}
      {hasCleanerFish && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {tankInfo.details.map((detail) => (
            <div key={detail.batchId} className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {detail.speciesName}
                  </h4>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{detail.batchNumber}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {detail.quantity.toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {detail.biomassKg.toFixed(1)} kg
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-2">
                <span>Deployed: {formatDate(detail.deployedAt)}</span>
                <span
                  className={`px-2 py-0.5 rounded-full ${
                    detail.sourceType === 'farmed'
                      ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                      : 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
                  }`}
                >
                  {SourceTypeLabels[detail.sourceType] || detail.sourceType}
                </span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onTransfer(tankId, detail.batchId)}
                  className="flex-1 text-xs"
                >
                  Transfer
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onMortality(tankId, detail.batchId)}
                  className="flex-1 text-xs text-error-600 dark:text-error-400 hover:text-error-700 dark:hover:text-error-200"
                >
                  Mortality
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onRemove(tankId, detail.batchId)}
                  className="flex-1 text-xs"
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!hasCleanerFish && (
        <div className="px-4 py-8 text-center">
          <Inbox className="mx-auto h-8 w-8 text-gray-300" aria-hidden="true" />
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No cleaner fish deployed</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Deploy cleaner fish from the Batches tab
          </p>
        </div>
      )}
    </div>
  );
};

export default TankCleanerFishCard;
