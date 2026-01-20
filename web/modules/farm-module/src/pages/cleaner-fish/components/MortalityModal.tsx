/**
 * MortalityModal Component
 *
 * Modal for recording cleaner fish mortality.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import {
  useRecordCleanerMortality,
  useTankCleanerFish,
  CleanerFishBatch,
  CleanerMortalityReason,
} from '../../../hooks/useCleanerFish';
import { MortalityReasonLabels } from '../types';

interface MortalityModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: CleanerFishBatch | null;
  tankId: string | null;
  onSuccess: () => void;
}

export const MortalityModal: React.FC<MortalityModalProps> = ({
  isOpen,
  onClose,
  batch,
  tankId,
  onSuccess,
}) => {
  // Form state
  const [quantity, setQuantity] = useState<number>(0);
  const [reason, setReason] = useState<CleanerMortalityReason>('unknown');
  const [detail, setDetail] = useState<string>('');
  const [observedAt, setObservedAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState<string>('');

  // Mutation
  const recordMortality = useRecordCleanerMortality();

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
    setReason('unknown');
    setDetail('');
    setObservedAt(new Date().toISOString().split('T')[0]);
    setNotes('');
  }, []);

  // Validation
  const maxQuantity = batchDetail?.quantity || 0;
  const isValid =
    batch &&
    tankId &&
    quantity > 0 &&
    quantity <= maxQuantity &&
    notes.trim() !== '' &&
    observedAt;

  // Calculate biomass loss
  const biomassLoss = useMemo(() => {
    if (quantity > 0 && batchDetail?.avgWeightG) {
      return (quantity * batchDetail.avgWeightG) / 1000;
    }
    return 0;
  }, [quantity, batchDetail]);

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid || !batch || !tankId) return;

    try {
      await recordMortality.mutateAsync({
        cleanerBatchId: batch.id,
        tankId,
        quantity,
        reason,
        detail: detail || undefined,
        observedAt,
        notes,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to record mortality:', error);
      alert(error instanceof Error ? error.message : 'Failed to record mortality');
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Record Cleaner Fish Mortality" size="md">
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

        {/* Dead Count */}
        <div>
          <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
            Dead Fish Count <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            id="quantity"
            min="1"
            max={maxQuantity}
            value={quantity || ''}
            onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
            placeholder="Enter number of dead fish"
          />
          <p className="mt-1 text-xs text-gray-500">
            Max: {maxQuantity.toLocaleString()}
          </p>
        </div>

        {/* Biomass Loss */}
        {quantity > 0 && biomassLoss > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-red-800">Biomass Loss</span>
              <span className="text-lg font-bold text-red-600">
                {biomassLoss.toFixed(2)} kg
              </span>
            </div>
          </div>
        )}

        {/* Mortality Reason */}
        <div>
          <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
            Mortality Reason <span className="text-red-500">*</span>
          </label>
          <select
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as CleanerMortalityReason)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
          >
            {Object.entries(MortalityReasonLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {/* Detail */}
        <div>
          <label htmlFor="detail" className="block text-sm font-medium text-gray-700">
            Detail / Diagnosis
          </label>
          <input
            type="text"
            id="detail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
            placeholder="e.g., Specific disease name..."
          />
        </div>

        {/* Observation Date */}
        <div>
          <label htmlFor="observedAt" className="block text-sm font-medium text-gray-700">
            Observation Date
          </label>
          <input
            type="date"
            id="observedAt"
            value={observedAt}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setObservedAt(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
          />
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
            Why did the fish die? <span className="text-red-500">*</span>
          </label>
          <textarea
            id="notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
            placeholder="Describe the circumstances of the mortality..."
          />
        </div>

        {/* Validation Errors */}
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
            disabled={!isValid || recordMortality.isPending}
            className="bg-red-600 hover:bg-red-700"
          >
            {recordMortality.isPending ? 'Recording...' : 'Record Mortality'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default MortalityModal;
