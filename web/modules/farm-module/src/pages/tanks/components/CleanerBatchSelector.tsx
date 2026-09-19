/**
 * Cleaner Batch Selector Modal
 *
 * When a tank has multiple cleaner fish batches,
 * this modal lets the user choose which batch to operate on.
 */
import React from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { TankWithBatch } from '../types';
import { OperationType } from './FishTypeSelector';

interface CleanerFishDetail {
  batchId: string;
  batchNumber: string;
  speciesId: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  sourceType: 'farmed' | 'wild_caught';
  deployedAt: string;
}

interface CleanerBatchSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (batch: CleanerFishDetail) => void;
  tank: TankWithBatch;
  operation: OperationType;
}

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

export const CleanerBatchSelector: React.FC<CleanerBatchSelectorProps> = ({
  isOpen,
  onClose,
  onSelect,
  tank,
  operation,
}) => {
  const batches = tank.cleanerFishDetails || [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Select Cleaner Fish Batch">
      <div className="p-4">
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          <span className="font-medium">{tank.name}</span> has {batches.length} cleaner fish
          batches.
          <br />
          Select which batch to record {operation} for:
        </p>

        <div className="space-y-3 max-h-80 overflow-y-auto">
          {batches.map((batch) => (
            <Button variant="secondary" key={batch.batchId} onClick={() => onSelect(batch)}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                    {batch.batchNumber}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 group-hover:text-success-600">
                    {batch.speciesName}
                  </span>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    batch.sourceType === 'farmed'
                      ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                      : 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
                  }`}
                >
                  {batch.sourceType === 'farmed' ? 'Farmed' : 'Wild'}
                </span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm text-gray-500 dark:text-gray-400">
                <div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">Quantity</div>
                  <div className="font-medium text-gray-700 dark:text-gray-300">
                    {batch.quantity.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">Avg Weight</div>
                  <div className="font-medium text-gray-700 dark:text-gray-300">
                    {batch.avgWeightG.toFixed(1)}g
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">Biomass</div>
                  <div className="font-medium text-gray-700 dark:text-gray-300">
                    {batch.biomassKg.toFixed(2)} kg
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">Deployed</div>
                  <div className="font-medium text-gray-700 dark:text-gray-300">
                    {formatDate(batch.deployedAt)}
                  </div>
                </div>
              </div>
            </Button>
          ))}
        </div>

        {batches.length === 0 && (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            No cleaner fish batches in this tank.
          </div>
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
