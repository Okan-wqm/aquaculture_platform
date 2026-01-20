/**
 * RemoveModal Component
 *
 * Modal for removing cleaner fish from a tank (harvest, end of cycle, relocation).
 * Not for mortality - use MortalityModal for that.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import {
  useRemoveCleanerFish,
  useTankCleanerFish,
  CleanerFishBatch,
  CleanerFishRemovalReason,
} from '../../../hooks/useCleanerFish';
import { RemovalReasonLabels } from '../types';

interface RemoveModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: CleanerFishBatch | null;
  tankId: string | null;
  onSuccess: () => void;
}

export const RemoveModal: React.FC<RemoveModalProps> = ({
  isOpen,
  onClose,
  batch,
  tankId,
  onSuccess,
}) => {
  // Form state
  const [quantity, setQuantity] = useState<number>(0);
  const [reason, setReason] = useState<CleanerFishRemovalReason>('end_of_cycle');
  const [avgWeightG, setAvgWeightG] = useState<number | undefined>();
  const [removedAt, setRemovedAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState<string>('');

  // Mutation
  const removeCleanerFish = useRemoveCleanerFish();

  // Get tank cleaner fish info
  const { data: tankInfo } = useTankCleanerFish(tankId || '');

  // Get the batch detail in tank
  const batchDetail = useMemo(() => {
    if (!tankInfo || !batch) return null;
    return tankInfo.details.find((d) => d.batchId === batch.id);
  }, [tankInfo, batch]);

  // Reset form
  const resetForm = useCallback(() => {
    setQuantity(0);
    setReason('end_of_cycle');
    setAvgWeightG(undefined);
    setRemovedAt(new Date().toISOString().split('T')[0]);
    setNotes('');
  }, []);

  // Validation
  const maxQuantity = batchDetail?.quantity || 0;
  const isValid = batch && tankId && quantity > 0 && quantity <= maxQuantity && removedAt;

  // Calculate biomass removed
  const biomassRemoved = useMemo(() => {
    const weight = avgWeightG || batchDetail?.avgWeightG || 0;
    if (quantity > 0 && weight > 0) {
      return (quantity * weight) / 1000;
    }
    return 0;
  }, [quantity, avgWeightG, batchDetail]);

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid || !batch || !tankId) return;

    try {
      await removeCleanerFish.mutateAsync({
        cleanerBatchId: batch.id,
        tankId,
        quantity,
        reason,
        removedAt,
        avgWeightG,
        notes: notes || undefined,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to remove cleaner fish:', error);
      alert(error instanceof Error ? error.message : 'Failed to remove cleaner fish');
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  // Get reason color
  const getReasonColor = (r: CleanerFishRemovalReason) => {
    switch (r) {
      case 'harvest':
        return 'text-green-600';
      case 'end_of_cycle':
        return 'text-blue-600';
      case 'relocation':
        return 'text-amber-600';
      default:
        return 'text-gray-600';
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Remove Cleaner Fish" size="md">
      <div className="space-y-6">
        {/* Tank & Batch Info */}
        {batchDetail && (
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-gray-900">{tankInfo?.tankName}</h4>
                <p className="text-sm text-gray-500">
                  {batchDetail.batchNumber} - {batchDetail.speciesName}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Current Stock</p>
                <p className="text-lg font-semibold text-gray-900">
                  {batchDetail.quantity.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Removal Reason */}
        <div>
          <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
            Removal Reason <span className="text-red-500">*</span>
          </label>
          <select
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as CleanerFishRemovalReason)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            {Object.entries(RemovalReasonLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <p className={`mt-1 text-xs ${getReasonColor(reason)}`}>
            {reason === 'harvest' && 'Fish are being harvested for sale/consumption'}
            {reason === 'end_of_cycle' && 'Production cycle is ending, fish are being removed'}
            {reason === 'relocation' && 'Fish are being moved to another facility'}
            {reason === 'other' && 'Other reason for removal'}
          </p>
        </div>

        {/* Quantity */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
              Quantity to Remove <span className="text-red-500">*</span>
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
              {reason === 'harvest' && <span className="text-amber-500 ml-1">Recommended</span>}
            </label>
            <input
              type="number"
              id="avgWeight"
              min="0.1"
              step="0.1"
              value={avgWeightG || ''}
              onChange={(e) => setAvgWeightG(parseFloat(e.target.value) || undefined)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder={`Default: ${batchDetail?.avgWeightG?.toFixed(1) || 'N/A'}`}
            />
          </div>
        </div>

        {/* Biomass Removed */}
        {quantity > 0 && biomassRemoved > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-amber-800">Biomass to Remove</span>
              <span className="text-lg font-bold text-amber-600">
                {biomassRemoved.toFixed(2)} kg
              </span>
            </div>
          </div>
        )}

        {/* Removal Date */}
        <div>
          <label htmlFor="removedAt" className="block text-sm font-medium text-gray-700">
            Removal Date
          </label>
          <input
            type="date"
            id="removedAt"
            value={removedAt}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setRemovedAt(e.target.value)}
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
            placeholder="Optional notes about this removal..."
          />
        </div>

        {/* Validation Error */}
        {quantity > maxQuantity && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-600">
              Quantity exceeds current stock ({maxQuantity.toLocaleString()})
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
            disabled={!isValid || removeCleanerFish.isPending}
          >
            {removeCleanerFish.isPending ? 'Removing...' : 'Remove from Tank'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default RemoveModal;
