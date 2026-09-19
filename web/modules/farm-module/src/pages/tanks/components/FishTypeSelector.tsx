/**
 * Fish Type Selector Modal
 *
 * When a tank has both production fish and cleaner fish,
 * this modal lets the user choose which type to operate on.
 */
import React from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { TankWithBatch } from '../types';
import { ArrowLeftRight, Box, Fish as FishIcon, Scissors, TriangleAlert } from 'lucide-react';

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
  mortality: <TriangleAlert className="w-6 h-6 text-error-500" aria-hidden="true" />,
  transfer: <ArrowLeftRight className="w-6 h-6 text-info-500" aria-hidden="true" />,
  cull: <Scissors className="w-6 h-6 text-accent-500" aria-hidden="true" />,
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
        <div className="flex justify-center mb-4">{operationIcons[operation]}</div>

        <p className="text-gray-600 dark:text-gray-400 mb-6 text-center">
          <span className="font-medium">{tank.name}</span> has both production fish and cleaner
          fish.
          <br />
          Which would you like to record {operationLabels[operation]} for?
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {hasProduction && (
            <Button variant="secondary" onClick={() => onSelect('production')}>
              <div className="flex items-center gap-2 mb-2">
                <Box className="w-5 h-5 text-info-600 dark:text-info-400" aria-hidden="true" />
                <span className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-info-600">
                  Production Fish
                </span>
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 space-y-1">
                <div>{tank.pieces?.toLocaleString() || 0} fish</div>
                <div>{tank.biomass?.toFixed(1) || 0} kg biomass</div>
                <div className="text-xs">Batch: {tank.batchNumber}</div>
              </div>
            </Button>
          )}

          {showCleanerOption && (
            <Button variant="secondary" onClick={() => onSelect('cleaner')}>
              <div className="flex items-center gap-2 mb-2">
                <FishIcon
                  className="w-5 h-5 text-success-600 dark:text-success-400"
                  aria-hidden="true"
                />
                <span className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-success-600">
                  Cleaner Fish
                </span>
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 space-y-1">
                <div>{tank.cleanerFishQuantity?.toLocaleString() || 0} fish</div>
                <div>{tank.cleanerFishBiomassKg?.toFixed(2) || 0} kg biomass</div>
                {tank.cleanerFishDetails && tank.cleanerFishDetails.length > 0 && (
                  <div className="text-xs">
                    {tank.cleanerFishDetails.length} batch
                    {tank.cleanerFishDetails.length > 1 ? 'es' : ''}
                  </div>
                )}
              </div>
            </Button>
          )}
        </div>

        {operation === 'cull' && hasCleaner && (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            Note: Cull operations are only available for production fish.
          </p>
        )}

        <div className="mt-6 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
};
