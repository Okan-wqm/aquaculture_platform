/**
 * Quick Actions Panel
 *
 * Provides quick access to tank operations: Mortality, Transfer, Cull
 */
import React from 'react';
import { TankWithBatch } from '../types';
import { ArrowLeftRight, Scissors, TriangleAlert, Zap } from 'lucide-react';

interface QuickActionsPanelProps {
  tanks: TankWithBatch[];
  selectedTankId: string | null;
  onTankSelect: (tankId: string | null) => void;
  onMortality: () => void;
  onTransfer: () => void;
  onCull: () => void;
}

export const QuickActionsPanel: React.FC<QuickActionsPanelProps> = ({
  tanks,
  selectedTankId,
  onTankSelect,
  onMortality,
  onTransfer,
  onCull,
}) => {
  const selectedTank = tanks.find((t) => t.id === selectedTankId);

  // Filter tanks that have fish (production or cleaner)
  const tanksWithFish = tanks.filter((t) => t.batchNumber || t.hasCleanerFish);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
          <Zap className="w-4 h-4" aria-hidden="true" />
          Quick Actions
        </h3>

        {/* Tank Selector */}
        <select
          value={selectedTankId || ''}
          onChange={(e) => onTankSelect(e.target.value || null)}
          className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm min-w-[200px] focus:ring-2 focus:ring-info-500 focus:border-info-500"
        >
          <option value="">Select Tank...</option>
          {tanksWithFish.map((tank) => (
            <option key={tank.id} value={tank.id}>
              {tank.name} ({tank.code}){tank.batchNumber ? ' - Production' : ''}
              {tank.hasCleanerFish ? ' - CF' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Selected Tank Info */}
      {selectedTank && (
        <div className="mb-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm">
          <div className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            {selectedTank.name}
          </div>
          <div className="flex flex-wrap gap-4">
            {selectedTank.batchNumber && (
              <div className="flex items-center gap-1">
                <span className="text-info-600 dark:text-info-400 font-medium">Production:</span>
                <span className="text-gray-700 dark:text-gray-300">
                  {selectedTank.pieces?.toLocaleString() || 0} fish
                </span>
                <span className="text-gray-400 dark:text-gray-500">•</span>
                <span className="text-gray-700 dark:text-gray-300">
                  {selectedTank.biomass?.toFixed(1) || 0} kg
                </span>
                <span className="text-gray-400 dark:text-gray-500">•</span>
                <span className="text-gray-500 dark:text-gray-400 text-xs">
                  Batch: {selectedTank.batchNumber}
                </span>
              </div>
            )}
            {selectedTank.hasCleanerFish && (
              <div className="flex items-center gap-1">
                <span className="text-success-600 dark:text-success-400 font-medium">
                  Cleaner Fish:
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  {selectedTank.cleanerFishQuantity?.toLocaleString() || 0} fish
                </span>
                {selectedTank.cleanerFishDetails && selectedTank.cleanerFishDetails.length > 1 && (
                  <>
                    <span className="text-gray-400 dark:text-gray-500">•</span>
                    <span className="text-gray-500 dark:text-gray-400 text-xs">
                      {selectedTank.cleanerFishDetails.length} batches
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={onMortality}
          disabled={!selectedTankId}
          className="flex-1 px-4 py-2.5 bg-error-50 text-error-700 rounded-lg hover:bg-error-100
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2
                     transition-colors border border-error-200 hover:border-error-300"
        >
          <TriangleAlert className="w-4 h-4" aria-hidden="true" />
          Mortality
        </button>
        <button
          onClick={onTransfer}
          disabled={!selectedTankId}
          className="flex-1 px-4 py-2.5 bg-info-50 text-info-700 rounded-lg hover:bg-info-100
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2
                     transition-colors border border-info-200 hover:border-info-300"
        >
          <ArrowLeftRight className="w-4 h-4" aria-hidden="true" />
          Transfer
        </button>
        <button
          onClick={onCull}
          disabled={!selectedTankId}
          className="flex-1 px-4 py-2.5 bg-warning-50 text-warning-700 rounded-lg hover:bg-warning-100
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2
                     transition-colors border border-warning-200 hover:border-warning-300"
        >
          <Scissors className="w-4 h-4" aria-hidden="true" />
          Cull
        </button>
      </div>

      {/* Help Text */}
      {!selectedTankId && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400 text-center">
          Select a tank to record mortality, transfer, or cull operations
        </p>
      )}
    </div>
  );
};
