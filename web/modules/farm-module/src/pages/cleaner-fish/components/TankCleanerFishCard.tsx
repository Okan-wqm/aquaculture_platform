/**
 * TankCleanerFishCard Component
 *
 * Displays cleaner fish information for a single tank.
 * Shows all cleaner fish species/batches deployed to the tank.
 */
import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import { useTankCleanerFish } from '../../../hooks/useCleanerFish';
import { SourceTypeLabels } from '../types';

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
  const { data: tankInfo, isLoading, error } = useTankCleanerFish(tankId);

  // Format date
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
    });
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-3/4 mb-4" />
        <div className="h-8 bg-gray-200 rounded w-1/2 mb-4" />
        <div className="h-20 bg-gray-200 rounded" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-medium text-gray-900">{tankName}</h3>
            <p className="text-sm text-gray-500">{tankCode}</p>
          </div>
        </div>
        <p className="text-sm text-red-500">Failed to load cleaner fish info</p>
      </div>
    );
  }

  const hasCleanerFish = tankInfo && tankInfo.cleanerFishQuantity > 0;

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Header */}
      <div className="px-4 py-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-gray-900">{tankName}</h3>
            <p className="text-sm text-gray-500">{tankCode}</p>
          </div>
          <div className="text-right">
            {hasCleanerFish ? (
              <>
                <p className="text-2xl font-bold text-blue-600">
                  {tankInfo.cleanerFishQuantity.toLocaleString()}
                </p>
                <p className="text-xs text-gray-500">fish</p>
              </>
            ) : (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                No cleaner fish
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      {hasCleanerFish && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Biomass:</span>{' '}
              <span className="font-medium text-gray-900">
                {tankInfo.cleanerFishBiomassKg.toFixed(1)} kg
              </span>
            </div>
            <div>
              <span className="text-gray-500">Ratio:</span>{' '}
              <span className="font-medium text-gray-900">
                {(tankInfo.cleanerFishRatio * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Details List */}
      {hasCleanerFish && (
        <div className="divide-y divide-gray-100">
          {tankInfo.details.map((detail) => (
            <div key={detail.batchId} className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h4 className="text-sm font-medium text-gray-900">{detail.speciesName}</h4>
                  <p className="text-xs text-gray-500">{detail.batchNumber}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-gray-900">
                    {detail.quantity.toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500">
                    {detail.biomassKg.toFixed(1)} kg
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                <span>
                  Deployed: {formatDate(detail.deployedAt)}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full ${
                    detail.sourceType === 'farmed'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-amber-100 text-amber-700'
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
                  className="flex-1 text-xs text-red-600 hover:text-red-700"
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
          <svg
            className="mx-auto h-8 w-8 text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">
            No cleaner fish deployed
          </p>
          <p className="text-xs text-gray-400">
            Deploy cleaner fish from the Batches tab
          </p>
        </div>
      )}
    </div>
  );
};

export default TankCleanerFishCard;
