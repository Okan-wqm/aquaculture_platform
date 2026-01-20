/**
 * Fish Type Selector Modal
 *
 * When a tank has both production fish and cleaner fish,
 * this modal lets the user choose which type to operate on.
 */
import React from 'react';
import { Modal } from '@aquaculture/shared-ui';
import { TankWithBatch } from '../types';

export type OperationType = 'mortality' | 'transfer' | 'cull';

interface FishTypeSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (type: 'production' | 'cleaner') => void;
  tank: TankWithBatch;
  operation: OperationType;
}

const operationLabels: Record<OperationType, string> = {
  mortality: 'mortality',
  transfer: 'transfer',
  cull: 'cull',
};

const operationIcons: Record<OperationType, React.ReactNode> = {
  mortality: (
    <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  ),
  transfer: (
    <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
    </svg>
  ),
  cull: (
    <svg className="w-6 h-6 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
    </svg>
  ),
};

export const FishTypeSelector: React.FC<FishTypeSelectorProps> = ({
  isOpen,
  onClose,
  onSelect,
  tank,
  operation,
}) => {
  const hasProduction = !!tank.batchNumber;
  const hasCleaner = tank.hasCleanerFish;

  // Cull is only for production fish
  const showCleanerOption = hasCleaner && operation !== 'cull';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Select Fish Type for ${operationLabels[operation].charAt(0).toUpperCase() + operationLabels[operation].slice(1)}`}
    >
      <div className="p-4">
        <div className="flex justify-center mb-4">
          {operationIcons[operation]}
        </div>

        <p className="text-gray-600 mb-6 text-center">
          <span className="font-medium">{tank.name}</span> has both production fish and cleaner fish.
          <br />
          Which would you like to record {operationLabels[operation]} for?
        </p>

        <div className="grid grid-cols-2 gap-4">
          {hasProduction && (
            <button
              onClick={() => onSelect('production')}
              className="p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50
                         transition-colors text-left group"
            >
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                <span className="text-lg font-semibold text-gray-900 group-hover:text-blue-600">
                  Production Fish
                </span>
              </div>
              <div className="text-sm text-gray-500 space-y-1">
                <div>{tank.pieces?.toLocaleString() || 0} fish</div>
                <div>{tank.biomass?.toFixed(1) || 0} kg biomass</div>
                <div className="text-xs">Batch: {tank.batchNumber}</div>
              </div>
            </button>
          )}

          {showCleanerOption && (
            <button
              onClick={() => onSelect('cleaner')}
              className="p-4 border-2 border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50
                         transition-colors text-left group"
            >
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 12c0 4-4 6-8 6s-8-2-8-6 4-6 8-6 8 2 8 6z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 12l4-2v4l-4-2zM6 12a2 2 0 100-4 2 2 0 000 4z" />
                </svg>
                <span className="text-lg font-semibold text-gray-900 group-hover:text-green-600">
                  Cleaner Fish
                </span>
              </div>
              <div className="text-sm text-gray-500 space-y-1">
                <div>{tank.cleanerFishQuantity?.toLocaleString() || 0} fish</div>
                <div>{tank.cleanerFishBiomassKg?.toFixed(2) || 0} kg biomass</div>
                {tank.cleanerFishDetails && tank.cleanerFishDetails.length > 0 && (
                  <div className="text-xs">
                    {tank.cleanerFishDetails.length} batch{tank.cleanerFishDetails.length > 1 ? 'es' : ''}
                  </div>
                )}
              </div>
            </button>
          )}
        </div>

        {operation === 'cull' && hasCleaner && (
          <p className="mt-4 text-sm text-gray-500 text-center">
            Note: Cull operations are only available for production fish.
          </p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};
