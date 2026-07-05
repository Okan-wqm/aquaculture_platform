/**
 * Mortality Modal
 * Records fish mortality in a tank with reason and biomass calculation
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';
import { TankBatch, MortalityReason, MortalityReasonLabels } from '../types/batch.types';
import { useRecordMortality } from '../../../hooks/useBatches';
import { BatchScopeSelector } from './BatchScopeSelector';

interface MortalityModalProps {
  isOpen: boolean;
  onClose: () => void;
  tank: TankBatch;
  onSuccess: () => void;
}

export const MortalityModal: React.FC<MortalityModalProps> = ({
  isOpen,
  onClose,
  tank,
  onSuccess,
}) => {
  // Form state
  const [quantity, setQuantity] = useState<number>(0);
  const [avgWeightG, setAvgWeightG] = useState<number>(tank.avgWeightG || 0);
  const [reason, setReason] = useState<MortalityReason>(MortalityReason.UNKNOWN);
  const [notes, setNotes] = useState<string>('');
  const [observedAt, setObservedAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | undefined>(tank.primaryBatchId);

  // Combined-tank scoping: when the tank holds several batches (B-1 + B-2) the
  // operation is attributed to the SELECTED batch and every stock/biomass/weight
  // figure is that batch's share. A single-batch tank has no batchDetails split,
  // so everything falls back to the tank totals — behaviour is unchanged.
  const isCombined = (tank.batchDetails?.length ?? 0) > 1;
  const selectedBatch = useMemo(
    () => (isCombined ? tank.batchDetails?.find((b) => b.batchId === selectedBatchId) : undefined),
    [isCombined, tank.batchDetails, selectedBatchId],
  );
  const availableQuantity = selectedBatch?.quantity ?? tank.totalQuantity;
  const availableBiomassKg = selectedBatch?.biomassKg ?? tank.totalBiomassKg;
  const scopedAvgWeightG = selectedBatch?.avgWeightG ?? tank.avgWeightG ?? 0;
  const selectedBatchNumber = selectedBatch?.batchNumber ?? tank.primaryBatchNumber;

  // Mutation hook
  const recordMortality = useRecordMortality();
  const { toast } = useToast();

  // Re-default the editable average weight to the selected batch's average when
  // the operator switches batches on a combined tank.
  useEffect(() => {
    setAvgWeightG(scopedAvgWeightG);
  }, [scopedAvgWeightG]);

  // Calculate biomass loss
  const calculatedBiomass = useMemo(() => {
    if (quantity > 0 && avgWeightG > 0) {
      return (quantity * avgWeightG) / 1000; // kg
    }
    return 0;
  }, [quantity, avgWeightG]);

  // Calculate post-operation state
  const postOperationState = useMemo(() => {
    const newQuantity = Math.max(0, availableQuantity - quantity);
    const newBiomass = Math.max(0, availableBiomassKg - calculatedBiomass);
    return {
      quantity: newQuantity,
      biomass: newBiomass,
    };
  }, [availableQuantity, availableBiomassKg, quantity, calculatedBiomass]);

  // Validation
  const errors = useMemo(() => {
    const errs: string[] = [];
    if (quantity <= 0) {
      errs.push('Quantity must be greater than 0');
    }
    if (quantity > availableQuantity) {
      errs.push(
        `Quantity cannot exceed ${isCombined ? 'batch' : 'tank'} stock (${availableQuantity.toLocaleString()})`,
      );
    }
    if (!notes.trim()) {
      errs.push('Please explain why the fish died');
    }
    return errs;
  }, [quantity, availableQuantity, isCombined, notes]);

  const isValid = errors.length === 0;

  // Reset form
  const resetForm = useCallback(() => {
    setQuantity(0);
    setAvgWeightG(scopedAvgWeightG);
    setReason(MortalityReason.UNKNOWN);
    setNotes('');
    setObservedAt(new Date().toISOString().split('T')[0]);
    setSelectedBatchId(tank.primaryBatchId);
  }, [scopedAvgWeightG, tank.primaryBatchId]);

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid) return;

    // Check if we have a batch
    if (!selectedBatchId) {
      toast({ title: 'Validation Error', description: 'No batch assigned to this tank.', variant: 'error' });
      return;
    }

    // LOW-03: programmatic future-date guard (max attr is a browser hint, not enforced)
    if (new Date(observedAt) > new Date()) {
      toast({ title: 'Validation Error', description: 'Observation date cannot be in the future.', variant: 'error' });
      return;
    }

    try {
      await recordMortality.mutateAsync({
        batchId: selectedBatchId,
        tankId: tank.equipmentId, // Backend expects tankId, frontend uses equipmentId
        quantity,
        // `reason` is a MortalityReason enum value whose string literal
        // (e.g. `'disease'`) matches the hook's `MortalityReason` union
        // type exactly — no cast required.
        reason,
        avgWeightG: avgWeightG > 0 ? avgWeightG : undefined,
        observedAt,
        notes,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to record mortality:', error);
      toast({ title: 'Error', description: 'Failed to record mortality. Please try again.', variant: 'error' });
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Record Mortality" size="md">
      <div className="space-y-6">
        {/* Tank Info Header */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900">{tank.tankName}</h3>
              <p className="text-sm text-gray-500">
                Batch: {selectedBatchNumber || 'No batch assigned'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">Current Stock</p>
              <p className="text-lg font-semibold text-gray-900">
                {availableQuantity.toLocaleString()} fish
              </p>
            </div>
          </div>
        </div>

        {/* Combined-tank batch scope (renders only when >1 batch shares the tank) */}
        <BatchScopeSelector
          batchDetails={tank.batchDetails}
          selectedBatchId={selectedBatchId}
          onChange={setSelectedBatchId}
          accent="red"
        />

        {/* Form Fields */}
        <div className="space-y-4">
          {/* Quantity */}
          <div>
            <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
              Dead Fish Count <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="quantity"
              min="1"
              max={availableQuantity}
              value={quantity || ''}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
              placeholder="Enter number of dead fish"
            />
          </div>

          {/* Average Weight */}
          <div>
            <label htmlFor="avgWeight" className="block text-sm font-medium text-gray-700">
              Average Weight (g)
            </label>
            <input
              type="number"
              id="avgWeight"
              min="0"
              step="0.1"
              value={avgWeightG || ''}
              onChange={(e) => setAvgWeightG(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
              placeholder="Enter average weight"
            />
            <p className="mt-1 text-xs text-gray-500">
              Default: {scopedAvgWeightG.toFixed(1)} g ({isCombined ? 'batch' : 'tank'} average)
            </p>
          </div>

          {/* Biomass Calculation */}
          {quantity > 0 && avgWeightG > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-red-800">Biomass Loss</span>
                <span className="text-lg font-bold text-red-600">
                  {calculatedBiomass.toFixed(2)} kg
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
              onChange={(e) => setReason(e.target.value as MortalityReason)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
            >
              {Object.entries(MortalityReasonLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Date */}
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
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
              placeholder="Describe the circumstances of the mortality..."
            />
          </div>
        </div>

        {/* Pre/Post Operation State */}
        {quantity > 0 && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Tank Status After Operation</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">Before</p>
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="text-gray-600">Stock:</span>{' '}
                    <span className="font-medium">{availableQuantity.toLocaleString()}</span>
                  </p>
                  <p className="text-sm">
                    <span className="text-gray-600">Biomass:</span>{' '}
                    <span className="font-medium">{availableBiomassKg.toFixed(1)} kg</span>
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">After</p>
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="text-gray-600">Stock:</span>{' '}
                    <span className="font-medium text-red-600">
                      {postOperationState.quantity.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-sm">
                    <span className="text-gray-600">Biomass:</span>{' '}
                    <span className="font-medium text-red-600">
                      {postOperationState.biomass.toFixed(1)} kg
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Validation Errors */}
        {errors.length > 0 && quantity > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-red-600 space-y-1">
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
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
