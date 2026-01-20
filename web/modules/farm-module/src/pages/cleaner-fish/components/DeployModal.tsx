/**
 * DeployModal Component
 *
 * Modal for deploying cleaner fish from a batch to a tank.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { useDeployCleanerFish, CleanerFishBatch } from '../../../hooks/useCleanerFish';

interface Tank {
  id: string;
  code: string;
  name: string;
}

interface DeployModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: CleanerFishBatch | null;
  batches: (CleanerFishBatch & { speciesName?: string })[];
  tanks: Tank[];
  onSuccess: () => void;
}

export const DeployModal: React.FC<DeployModalProps> = ({
  isOpen,
  onClose,
  batch,
  batches,
  tanks,
  onSuccess,
}) => {
  // Form state
  const [selectedBatchId, setSelectedBatchId] = useState<string>(batch?.id || '');
  const [targetTankId, setTargetTankId] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(0);
  const [avgWeightG, setAvgWeightG] = useState<number | undefined>();
  const [deployedAt, setDeployedAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState<string>('');

  // Mutation
  const deployCleanerFish = useDeployCleanerFish();

  // Get selected batch
  const selectedBatch = useMemo(() => {
    if (!selectedBatchId) return null;
    return batches.find((b) => b.id === selectedBatchId) || null;
  }, [selectedBatchId, batches]);

  // Calculate biomass
  const calculatedBiomass = useMemo(() => {
    if (quantity > 0 && avgWeightG && avgWeightG > 0) {
      return (quantity * avgWeightG) / 1000;
    }
    return 0;
  }, [quantity, avgWeightG]);

  // Reset form
  const resetForm = useCallback(() => {
    setSelectedBatchId(batch?.id || '');
    setTargetTankId('');
    setQuantity(0);
    setAvgWeightG(undefined);
    setDeployedAt(new Date().toISOString().split('T')[0]);
    setNotes('');
  }, [batch]);

  // Update selected batch when prop changes
  React.useEffect(() => {
    if (batch) {
      setSelectedBatchId(batch.id);
    }
  }, [batch]);

  // Validation
  const maxQuantity = selectedBatch?.currentQuantity || 0;
  const isValid = selectedBatchId && targetTankId && quantity > 0 && quantity <= maxQuantity && deployedAt;

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid) return;

    try {
      await deployCleanerFish.mutateAsync({
        cleanerBatchId: selectedBatchId,
        targetTankId,
        quantity,
        avgWeightG,
        deployedAt,
        notes: notes || undefined,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to deploy cleaner fish:', error);
      alert(error instanceof Error ? error.message : 'Failed to deploy cleaner fish');
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Deploy Cleaner Fish" size="md">
      <div className="space-y-6">
        {/* Batch Selection */}
        <div>
          <label htmlFor="batch" className="block text-sm font-medium text-gray-700">
            Cleaner Fish Batch <span className="text-red-500">*</span>
          </label>
          <select
            id="batch"
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="">Select a batch...</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batchNumber} - {b.speciesName || 'Unknown'} ({b.currentQuantity.toLocaleString()} available)
              </option>
            ))}
          </select>
        </div>

        {/* Selected Batch Info */}
        {selectedBatch && (
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-gray-900">{selectedBatch.batchNumber}</h4>
                <p className="text-sm text-gray-500">{selectedBatch.speciesName}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Available</p>
                <p className="text-lg font-semibold text-gray-900">
                  {selectedBatch.currentQuantity.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Target Tank */}
        <div>
          <label htmlFor="targetTank" className="block text-sm font-medium text-gray-700">
            Target Tank <span className="text-red-500">*</span>
          </label>
          <select
            id="targetTank"
            value={targetTankId}
            onChange={(e) => setTargetTankId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="">Select a tank...</option>
            {tanks.map((tank) => (
              <option key={tank.id} value={tank.id}>
                {tank.name} ({tank.code})
              </option>
            ))}
          </select>
        </div>

        {/* Quantity */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
              Quantity to Deploy <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="quantity"
              min="1"
              max={maxQuantity}
              value={quantity || ''}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter quantity"
            />
            <p className="mt-1 text-xs text-gray-500">
              Max: {maxQuantity.toLocaleString()}
            </p>
          </div>
          <div>
            <label htmlFor="avgWeight" className="block text-sm font-medium text-gray-700">
              Avg Weight (g)
            </label>
            <input
              type="number"
              id="avgWeight"
              min="0.1"
              step="0.1"
              value={avgWeightG || ''}
              onChange={(e) => setAvgWeightG(parseFloat(e.target.value) || undefined)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Optional"
            />
          </div>
        </div>

        {/* Calculated Biomass */}
        {quantity > 0 && avgWeightG && avgWeightG > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-green-800">Biomass to Deploy</span>
              <span className="text-lg font-bold text-green-600">
                {calculatedBiomass.toFixed(2)} kg
              </span>
            </div>
          </div>
        )}

        {/* Date */}
        <div>
          <label htmlFor="deployedAt" className="block text-sm font-medium text-gray-700">
            Deployment Date
          </label>
          <input
            type="date"
            id="deployedAt"
            value={deployedAt}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setDeployedAt(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          />
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
            Notes
          </label>
          <textarea
            id="notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="Optional notes..."
          />
        </div>

        {/* Validation Error */}
        {quantity > maxQuantity && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-600">
              Quantity exceeds available stock ({maxQuantity.toLocaleString()})
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isValid || deployCleanerFish.isPending}
          >
            {deployCleanerFish.isPending ? 'Deploying...' : 'Deploy to Tank'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default DeployModal;
