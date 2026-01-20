/**
 * Quick Actions Panel
 *
 * Provides quick access to tank operations: Mortality, Transfer, Cull
 */
import React from 'react';
import { TankWithBatch } from '../types';

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
  const tanksWithFish = tanks.filter(
    (t) => t.batchNumber || t.hasCleanerFish
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Quick Actions
        </h3>

        {/* Tank Selector */}
        <select
          value={selectedTankId || ''}
          onChange={(e) => onTankSelect(e.target.value || null)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm min-w-[200px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">Select Tank...</option>
          {tanksWithFish.map((tank) => (
            <option key={tank.id} value={tank.id}>
              {tank.name} ({tank.code})
              {tank.batchNumber ? ' - Production' : ''}
              {tank.hasCleanerFish ? ' - CF' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Selected Tank Info */}
      {selectedTank && (
        <div className="mb-3 p-3 bg-gray-50 rounded-lg text-sm">
          <div className="font-medium text-gray-900 mb-1">{selectedTank.name}</div>
          <div className="flex flex-wrap gap-4">
            {selectedTank.batchNumber && (
              <div className="flex items-center gap-1">
                <span className="text-blue-600 font-medium">Production:</span>
                <span className="text-gray-700">
                  {selectedTank.pieces?.toLocaleString() || 0} fish
                </span>
                <span className="text-gray-400">•</span>
                <span className="text-gray-700">
                  {selectedTank.biomass?.toFixed(1) || 0} kg
                </span>
                <span className="text-gray-400">•</span>
                <span className="text-gray-500 text-xs">
                  Batch: {selectedTank.batchNumber}
                </span>
              </div>
            )}
            {selectedTank.hasCleanerFish && (
              <div className="flex items-center gap-1">
                <span className="text-green-600 font-medium">Cleaner Fish:</span>
                <span className="text-gray-700">
                  {selectedTank.cleanerFishQuantity?.toLocaleString() || 0} fish
                </span>
                {selectedTank.cleanerFishDetails && selectedTank.cleanerFishDetails.length > 1 && (
                  <>
                    <span className="text-gray-400">•</span>
                    <span className="text-gray-500 text-xs">
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
          className="flex-1 px-4 py-2.5 bg-red-50 text-red-700 rounded-lg hover:bg-red-100
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2
                     transition-colors border border-red-200 hover:border-red-300"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          Mortality
        </button>
        <button
          onClick={onTransfer}
          disabled={!selectedTankId}
          className="flex-1 px-4 py-2.5 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2
                     transition-colors border border-blue-200 hover:border-blue-300"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          Transfer
        </button>
        <button
          onClick={onCull}
          disabled={!selectedTankId}
          className="flex-1 px-4 py-2.5 bg-orange-50 text-orange-700 rounded-lg hover:bg-orange-100
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2
                     transition-colors border border-orange-200 hover:border-orange-300"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
          </svg>
          Cull
        </button>
      </div>

      {/* Help Text */}
      {!selectedTankId && (
        <p className="mt-3 text-xs text-gray-500 text-center">
          Select a tank to record mortality, transfer, or cull operations
        </p>
      )}
    </div>
  );
};
