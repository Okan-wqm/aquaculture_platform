/**
 * Transfer Modal
 * Transfers fish from source tank to destination tank
 * Handles mixed batch logic when transferring to a tank with existing fish
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Modal, Button, useToast, Input, Textarea } from '@aquaculture/shared-ui';
import { TankBatch } from '../types/batch.types';
import { useTransferBatch, useAvailableTanks, AvailableTank } from '../../../hooks/useBatches';
import { BatchScopeSelector } from './BatchScopeSelector';
import { ArrowRight, TriangleAlert } from 'lucide-react';

// Transfer reason options
const TransferReasons = {
  GRADING: 'Grading',
  DENSITY_MANAGEMENT: 'Density Management',
  GROWTH_OPTIMIZATION: 'Growth Optimization',
  TANK_MAINTENANCE: 'Tank Maintenance',
  DISEASE_ISOLATION: 'Disease Isolation',
  HARVEST_PREPARATION: 'Harvest Preparation',
  OTHER: 'Other',
};

interface TransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  tank: TankBatch;
  onSuccess: () => void;
}

export const TransferModal: React.FC<TransferModalProps> = ({
  isOpen,
  onClose,
  tank,
  onSuccess,
}) => {
  // Form state
  const [destinationTankId, setDestinationTankId] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(0);
  const [avgWeightG, setAvgWeightG] = useState<number>(tank.avgWeightG || 0);
  const [transferReason, setTransferReason] = useState<string>('DENSITY_MANAGEMENT');
  const [notes, setNotes] = useState<string>('');
  const [transferredAt, setTransferredAt] = useState<string>(
    new Date().toISOString().split('T')[0],
  );
  const [selectedBatchId, setSelectedBatchId] = useState<string | undefined>(tank.primaryBatchId);

  // Combined-tank scoping: on a tank holding several batches (B-1 + B-2) the
  // transfer moves fish from the SELECTED batch, so the source stock/biomass/weight
  // and the max transferable quantity are that batch's share — you cannot move more
  // fish than the selected batch holds. A single-batch tank uses the tank totals.
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
  const transferBatch = useTransferBatch();
  const { toast } = useToast();

  // Keep the read-only weight in sync with the selected batch on a combined tank.
  useEffect(() => {
    setAvgWeightG(scopedAvgWeightG);
  }, [scopedAvgWeightG]);

  // Fetch available tanks
  const { data: availableTanks = [], isLoading: tanksLoading } = useAvailableTanks({
    excludeFullTanks: false, // Include all tanks so user can see capacity info
  });

  // Filter out the source tank from available destinations
  const destinationTanks = useMemo(() => {
    return availableTanks.filter((t: AvailableTank) => t.id !== tank.equipmentId);
  }, [availableTanks, tank.equipmentId]);

  // Get selected destination tank details
  const selectedDestinationTank = useMemo(() => {
    return destinationTanks.find((t: AvailableTank) => t.id === destinationTankId);
  }, [destinationTanks, destinationTankId]);

  // Calculate biomass from the selected batch's average weight (not user-editable)
  const calculatedBiomass = useMemo(() => {
    if (quantity > 0 && scopedAvgWeightG > 0) {
      return (quantity * scopedAvgWeightG) / 1000; // kg
    }
    return 0;
  }, [quantity, scopedAvgWeightG]);

  // Calculate post-operation states
  const postOperationStates = useMemo(() => {
    // Source tank after transfer
    const sourceAfter = {
      quantity: Math.max(0, availableQuantity - quantity),
      biomass: Math.max(0, availableBiomassKg - calculatedBiomass),
    };

    // Destination tank after transfer
    const destAfter = selectedDestinationTank
      ? {
          quantity: (selectedDestinationTank.currentCount || 0) + quantity,
          biomass: (selectedDestinationTank.currentBiomass || 0) + calculatedBiomass,
          willBeMixed: selectedDestinationTank.currentCount > 0,
        }
      : null;

    return { sourceAfter, destAfter };
  }, [availableQuantity, availableBiomassKg, quantity, calculatedBiomass, selectedDestinationTank]);

  // Validation - separate errors (blocking) from warnings (non-blocking)
  const { errors, warnings } = useMemo(() => {
    const errs: string[] = [];
    const warns: string[] = [];

    if (!destinationTankId) {
      errs.push('Please select a destination tank');
    }
    if (quantity <= 0) {
      errs.push('Quantity must be greater than 0');
    }
    if (quantity > availableQuantity) {
      errs.push(
        `Quantity cannot exceed ${isCombined ? 'batch' : 'source tank'} stock (${availableQuantity.toLocaleString()})`,
      );
    }
    if (!notes.trim()) {
      errs.push('Please explain why the fish are being transferred');
    }

    // Check destination capacity - WARNING only, not blocking
    if (selectedDestinationTank && calculatedBiomass > 0) {
      const availableCapacity =
        selectedDestinationTank.maxBiomass - selectedDestinationTank.currentBiomass;
      if (calculatedBiomass > availableCapacity) {
        warns.push(
          `Transfer biomass (${calculatedBiomass.toFixed(1)} kg) exceeds destination capacity (${availableCapacity.toFixed(1)} kg available). Tank will be over capacity.`,
        );
      }
    }

    return { errors: errs, warnings: warns };
  }, [
    destinationTankId,
    quantity,
    availableQuantity,
    isCombined,
    notes,
    selectedDestinationTank,
    calculatedBiomass,
  ]);

  const isValid = errors.length === 0;

  // Reset form
  const resetForm = useCallback(() => {
    setDestinationTankId('');
    setQuantity(0);
    setAvgWeightG(scopedAvgWeightG);
    setTransferReason('DENSITY_MANAGEMENT');
    setNotes('');
    setTransferredAt(new Date().toISOString().split('T')[0]);
    setSelectedBatchId(tank.primaryBatchId);
  }, [scopedAvgWeightG, tank.primaryBatchId]);

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid) return;

    // Check if we have a batch
    if (!selectedBatchId) {
      toast({
        title: 'Validation Error',
        description: 'No batch assigned to this tank.',
        variant: 'error',
      });
      return;
    }

    try {
      await transferBatch.mutateAsync({
        batchId: selectedBatchId,
        sourceTankId: tank.equipmentId, // Source tank
        destinationTankId: destinationTankId,
        quantity,
        avgWeightG: scopedAvgWeightG > 0 ? scopedAvgWeightG : undefined,
        transferReason,
        transferredAt,
        notes,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      // LOW-004: Log errors in all environments, not just DEV. Production transfer
      // failures were invisible beyond the toast. Sanitize before logging to prevent
      // internal error detail exposure via browser devtools in production.
      console.error(
        '[TransferModal] Transfer failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      toast({
        title: 'Error',
        description: 'Failed to transfer batch. Please try again.',
        variant: 'error',
      });
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  // Calculate capacity usage for destination tank
  const getCapacityInfo = (t: AvailableTank) => {
    const usedPercent = t.maxBiomass > 0 ? (t.currentBiomass / t.maxBiomass) * 100 : 0;
    const available = Math.max(0, t.maxBiomass - t.currentBiomass);
    return { usedPercent, available };
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Transfer Fish" size="lg">
      <div className="space-y-6">
        {/* Source Tank Info Header */}
        <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-info-600 dark:text-info-400 uppercase font-medium">
                Source Tank
              </p>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">{tank.tankName}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Batch: {selectedBatchNumber || 'No batch assigned'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500 dark:text-gray-400">Current Stock</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {availableQuantity.toLocaleString()} fish
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {availableBiomassKg.toFixed(1)} kg
              </p>
            </div>
          </div>
        </div>

        {/* Combined-tank batch scope (renders only when >1 batch shares the tank) */}
        <BatchScopeSelector
          batchDetails={tank.batchDetails}
          selectedBatchId={selectedBatchId}
          onChange={setSelectedBatchId}
          accent="blue"
        />

        {/* Form Fields */}
        <div className="space-y-4">
          {/* Destination Tank Selection */}
          <div>
            <label
              htmlFor="destinationTank"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Destination Tank <span className="text-info-500">*</span>
            </label>
            {tanksLoading ? (
              <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">Loading tanks...</div>
            ) : (
              <select
                id="destinationTank"
                value={destinationTankId}
                onChange={(e) => setDestinationTankId(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm"
              >
                <option value="">Select destination tank...</option>
                {destinationTanks.map((t: AvailableTank) => {
                  const { usedPercent, available } = getCapacityInfo(t);
                  const hasStock = t.currentCount > 0;
                  return (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code}) - {available.toFixed(0)} kg available
                      {hasStock ? ` [${t.currentCount.toLocaleString()} fish]` : ' [Empty]'}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* Show destination tank details if selected */}
          {selectedDestinationTank && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-medium">
                    Destination Tank
                  </p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {selectedDestinationTank.name}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Current: {selectedDestinationTank.currentCount?.toLocaleString() || 0} fish
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {selectedDestinationTank.currentBiomass?.toFixed(1) || 0} kg /{' '}
                    {selectedDestinationTank.maxBiomass} kg
                  </p>
                </div>
              </div>
              {/* Mixed batch warning */}
              {selectedDestinationTank.currentCount > 0 && (
                <div className="mt-2 flex items-center gap-2 text-warning-700 dark:text-warning-300 bg-warning-50 dark:bg-warning-900/20 px-2 py-1 rounded">
                  <TriangleAlert className="w-4 h-4" aria-hidden="true" />
                  <span className="text-sm">
                    This tank already has fish. Transfer will create a mixed batch.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Quantity */}
          <div>
            <label
              htmlFor="quantity"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Transfer Quantity <span className="text-info-500">*</span>
            </label>
            <Input
              fullWidth
              type="number"
              id="quantity"
              min="1"
              max={availableQuantity}
              value={quantity || ''}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
              placeholder="Enter number of fish to transfer"
            />
            {/* Quick select buttons — percentages of the SELECTED batch's stock */}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setQuantity(Math.floor(availableQuantity * 0.25))}
                className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
              >
                25%
              </button>
              <button
                type="button"
                onClick={() => setQuantity(Math.floor(availableQuantity * 0.5))}
                className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
              >
                50%
              </button>
              <button
                type="button"
                onClick={() => setQuantity(Math.floor(availableQuantity * 0.75))}
                className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
              >
                75%
              </button>
              <button
                type="button"
                onClick={() => setQuantity(availableQuantity)}
                className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
              >
                100%
              </button>
            </div>
          </div>

          {/* Average Weight */}
          <div>
            <label
              htmlFor="avgWeight"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Average Weight (g)
            </label>
            <Input
              fullWidth
              type="number"
              id="avgWeight"
              value={scopedAvgWeightG.toFixed(1)}
              readOnly
              disabled
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {isCombined ? 'Selected batch' : 'Source tank'} average — cannot be changed during
              transfer. Biomass is calculated automatically.
            </p>
          </div>

          {/* Biomass Calculation */}
          {quantity > 0 && avgWeightG > 0 && (
            <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-info-800 dark:text-info-200">
                  Biomass to Transfer
                </span>
                <span className="text-lg font-bold text-info-600 dark:text-info-400">
                  {calculatedBiomass.toFixed(2)} kg
                </span>
              </div>
            </div>
          )}

          {/* Transfer Reason */}
          <div>
            <label
              htmlFor="reason"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Transfer Reason <span className="text-info-500">*</span>
            </label>
            <select
              id="reason"
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm"
            >
              {Object.entries(TransferReasons).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Date */}
          <div>
            <label
              htmlFor="transferredAt"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Transfer Date
            </label>
            <Input
              fullWidth
              type="date"
              id="transferredAt"
              value={transferredAt}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setTransferredAt(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div>
            <label
              htmlFor="notes"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Transfer Notes <span className="text-info-500">*</span>
            </label>
            <Textarea
              fullWidth
              id="notes"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Explain why the fish are being transferred..."
            />
          </div>
        </div>

        {/* Pre/Post Operation States */}
        {quantity > 0 && destinationTankId && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Tank Status After Transfer
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {/* Source Tank */}
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-2">
                  Source: {tank.tankName}
                </p>
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Before</p>
                    <p className="text-sm font-medium">{availableQuantity.toLocaleString()} fish</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {availableBiomassKg.toFixed(1)} kg
                    </p>
                  </div>
                  <ArrowRight
                    className="w-4 h-4 text-gray-400 dark:text-gray-500"
                    aria-hidden="true"
                  />
                  <div className="text-right">
                    <p className="text-xs text-gray-500 dark:text-gray-400">After</p>
                    <p className="text-sm font-medium text-info-600 dark:text-info-400">
                      {postOperationStates.sourceAfter.quantity.toLocaleString()} fish
                    </p>
                    <p className="text-xs text-info-600 dark:text-info-400">
                      {postOperationStates.sourceAfter.biomass.toFixed(1)} kg
                    </p>
                  </div>
                </div>
              </div>

              {/* Destination Tank */}
              {postOperationStates.destAfter && selectedDestinationTank && (
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-2">
                    Destination: {selectedDestinationTank.name}
                  </p>
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Before</p>
                      <p className="text-sm font-medium">
                        {(selectedDestinationTank.currentCount || 0).toLocaleString()} fish
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {(selectedDestinationTank.currentBiomass || 0).toFixed(1)} kg
                      </p>
                    </div>
                    <ArrowRight
                      className="w-4 h-4 text-gray-400 dark:text-gray-500"
                      aria-hidden="true"
                    />
                    <div className="text-right">
                      <p className="text-xs text-gray-500 dark:text-gray-400">After</p>
                      <p className="text-sm font-medium text-success-600 dark:text-success-400">
                        {postOperationStates.destAfter.quantity.toLocaleString()} fish
                      </p>
                      <p className="text-xs text-success-600 dark:text-success-400">
                        {postOperationStates.destAfter.biomass.toFixed(1)} kg
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Capacity Warning (non-blocking) */}
        {warnings.length > 0 && (
          <div className="bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <TriangleAlert
                className="w-5 h-5 text-warning-500 flex-shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <ul className="text-sm text-warning-700 dark:text-warning-300 space-y-1">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Validation Errors (blocking) */}
        {errors.length > 0 && (quantity > 0 || destinationTankId) && (
          <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-error-600 dark:text-error-400 space-y-1">
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Validation Errors */}
        {errors.length > 0 && (
          <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3">
            <p className="text-sm font-medium text-error-800 dark:text-error-200 mb-1">
              Please fix the following:
            </p>
            <ul className="list-disc list-inside space-y-1">
              {errors.map((error, index) => (
                <li key={index} className="text-sm text-error-700 dark:text-error-300">
                  {error}
                </li>
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
            disabled={!isValid || transferBatch.isPending}
            className="bg-info-600 hover:bg-info-700"
          >
            {transferBatch.isPending ? 'Transferring...' : 'Transfer Fish'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default TransferModal;
