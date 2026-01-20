/**
 * Transfer Modal
 * Transfers fish from source tank to destination tank
 * Handles mixed batch logic when transferring to a tank with existing fish
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { TankBatch } from '../types/batch.types';
import { useTransferBatch, useAvailableTanks, AvailableTank } from '../../../hooks/useBatches';

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
  const [transferredAt, setTransferredAt] = useState<string>(new Date().toISOString().split('T')[0]);

  // Mutation hook
  const transferBatch = useTransferBatch();

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

  // Calculate biomass being transferred
  const calculatedBiomass = useMemo(() => {
    if (quantity > 0 && avgWeightG > 0) {
      return (quantity * avgWeightG) / 1000; // kg
    }
    return 0;
  }, [quantity, avgWeightG]);

  // Calculate post-operation states
  const postOperationStates = useMemo(() => {
    // Source tank after transfer
    const sourceAfter = {
      quantity: Math.max(0, tank.totalQuantity - quantity),
      biomass: Math.max(0, tank.totalBiomassKg - calculatedBiomass),
    };

    // Destination tank after transfer
    const destAfter = selectedDestinationTank ? {
      quantity: (selectedDestinationTank.currentCount || 0) + quantity,
      biomass: (selectedDestinationTank.currentBiomass || 0) + calculatedBiomass,
      willBeMixed: selectedDestinationTank.currentCount > 0,
    } : null;

    return { sourceAfter, destAfter };
  }, [tank.totalQuantity, tank.totalBiomassKg, quantity, calculatedBiomass, selectedDestinationTank]);

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
    if (quantity > tank.totalQuantity) {
      errs.push(`Quantity cannot exceed source tank stock (${tank.totalQuantity.toLocaleString()})`);
    }
    if (!notes.trim()) {
      errs.push('Please explain why the fish are being transferred');
    }

    // Check destination capacity - WARNING only, not blocking
    if (selectedDestinationTank && calculatedBiomass > 0) {
      const availableCapacity = selectedDestinationTank.maxBiomass - selectedDestinationTank.currentBiomass;
      if (calculatedBiomass > availableCapacity) {
        warns.push(`Transfer biomass (${calculatedBiomass.toFixed(1)} kg) exceeds destination capacity (${availableCapacity.toFixed(1)} kg available). Tank will be over capacity.`);
      }
    }

    return { errors: errs, warnings: warns };
  }, [destinationTankId, quantity, tank.totalQuantity, notes, selectedDestinationTank, calculatedBiomass]);

  const isValid = errors.length === 0;

  // Reset form
  const resetForm = useCallback(() => {
    setDestinationTankId('');
    setQuantity(0);
    setAvgWeightG(tank.avgWeightG || 0);
    setTransferReason('DENSITY_MANAGEMENT');
    setNotes('');
    setTransferredAt(new Date().toISOString().split('T')[0]);
  }, [tank.avgWeightG]);

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid) return;

    // Check if we have a batch
    if (!tank.primaryBatchId) {
      alert('No batch assigned to this tank');
      return;
    }

    try {
      await transferBatch.mutateAsync({
        batchId: tank.primaryBatchId,
        sourceTankId: tank.equipmentId, // Source tank
        destinationTankId: destinationTankId,
        quantity,
        avgWeightG: avgWeightG > 0 ? avgWeightG : undefined,
        transferReason,
        transferredAt,
        notes,
        skipCapacityCheck: true, // Always allow transfers even if destination is over capacity
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to transfer batch:', error);
      alert(error instanceof Error ? error.message : 'Failed to transfer batch');
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
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-blue-600 uppercase font-medium">Source Tank</p>
              <h3 className="font-medium text-gray-900">{tank.tankName}</h3>
              <p className="text-sm text-gray-500">
                Batch: {tank.primaryBatchNumber || 'No batch assigned'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">Current Stock</p>
              <p className="text-lg font-semibold text-gray-900">
                {tank.totalQuantity.toLocaleString()} fish
              </p>
              <p className="text-sm text-gray-500">
                {tank.totalBiomassKg.toFixed(1)} kg
              </p>
            </div>
          </div>
        </div>

        {/* Form Fields */}
        <div className="space-y-4">
          {/* Destination Tank Selection */}
          <div>
            <label htmlFor="destinationTank" className="block text-sm font-medium text-gray-700">
              Destination Tank <span className="text-blue-500">*</span>
            </label>
            {tanksLoading ? (
              <div className="mt-1 text-sm text-gray-500">Loading tanks...</div>
            ) : (
              <select
                id="destinationTank"
                value={destinationTankId}
                onChange={(e) => setDestinationTankId(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
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
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 uppercase font-medium">Destination Tank</p>
                  <p className="font-medium text-gray-900">{selectedDestinationTank.name}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-500">
                    Current: {selectedDestinationTank.currentCount?.toLocaleString() || 0} fish
                  </p>
                  <p className="text-sm text-gray-500">
                    {selectedDestinationTank.currentBiomass?.toFixed(1) || 0} kg / {selectedDestinationTank.maxBiomass} kg
                  </p>
                </div>
              </div>
              {/* Mixed batch warning */}
              {selectedDestinationTank.currentCount > 0 && (
                <div className="mt-2 flex items-center gap-2 text-yellow-700 bg-yellow-50 px-2 py-1 rounded">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="text-sm">This tank already has fish. Transfer will create a mixed batch.</span>
                </div>
              )}
            </div>
          )}

          {/* Quantity */}
          <div>
            <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
              Transfer Quantity <span className="text-blue-500">*</span>
            </label>
            <input
              type="number"
              id="quantity"
              min="1"
              max={tank.totalQuantity}
              value={quantity || ''}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter number of fish to transfer"
            />
            {/* Quick select buttons */}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setQuantity(Math.floor(tank.totalQuantity * 0.25))}
                className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
              >
                25%
              </button>
              <button
                type="button"
                onClick={() => setQuantity(Math.floor(tank.totalQuantity * 0.5))}
                className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
              >
                50%
              </button>
              <button
                type="button"
                onClick={() => setQuantity(Math.floor(tank.totalQuantity * 0.75))}
                className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
              >
                75%
              </button>
              <button
                type="button"
                onClick={() => setQuantity(tank.totalQuantity)}
                className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
              >
                100%
              </button>
            </div>
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
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter average weight"
            />
            <p className="mt-1 text-xs text-gray-500">
              Default: {tank.avgWeightG?.toFixed(1) || 0} g (tank average)
            </p>
          </div>

          {/* Biomass Calculation */}
          {quantity > 0 && avgWeightG > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-blue-800">Biomass to Transfer</span>
                <span className="text-lg font-bold text-blue-600">
                  {calculatedBiomass.toFixed(2)} kg
                </span>
              </div>
            </div>
          )}

          {/* Transfer Reason */}
          <div>
            <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
              Transfer Reason <span className="text-blue-500">*</span>
            </label>
            <select
              id="reason"
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
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
            <label htmlFor="transferredAt" className="block text-sm font-medium text-gray-700">
              Transfer Date
            </label>
            <input
              type="date"
              id="transferredAt"
              value={transferredAt}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setTransferredAt(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
              Transfer Notes <span className="text-blue-500">*</span>
            </label>
            <textarea
              id="notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Explain why the fish are being transferred..."
            />
          </div>
        </div>

        {/* Pre/Post Operation States */}
        {quantity > 0 && destinationTankId && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Tank Status After Transfer</h4>
            <div className="grid grid-cols-2 gap-6">
              {/* Source Tank */}
              <div>
                <p className="text-xs text-gray-500 uppercase mb-2">Source: {tank.tankName}</p>
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-xs text-gray-500">Before</p>
                    <p className="text-sm font-medium">{tank.totalQuantity.toLocaleString()} fish</p>
                    <p className="text-xs text-gray-500">{tank.totalBiomassKg.toFixed(1)} kg</p>
                  </div>
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">After</p>
                    <p className="text-sm font-medium text-blue-600">
                      {postOperationStates.sourceAfter.quantity.toLocaleString()} fish
                    </p>
                    <p className="text-xs text-blue-600">
                      {postOperationStates.sourceAfter.biomass.toFixed(1)} kg
                    </p>
                  </div>
                </div>
              </div>

              {/* Destination Tank */}
              {postOperationStates.destAfter && selectedDestinationTank && (
                <div>
                  <p className="text-xs text-gray-500 uppercase mb-2">Destination: {selectedDestinationTank.name}</p>
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-xs text-gray-500">Before</p>
                      <p className="text-sm font-medium">{(selectedDestinationTank.currentCount || 0).toLocaleString()} fish</p>
                      <p className="text-xs text-gray-500">{(selectedDestinationTank.currentBiomass || 0).toFixed(1)} kg</p>
                    </div>
                    <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                    <div className="text-right">
                      <p className="text-xs text-gray-500">After</p>
                      <p className="text-sm font-medium text-green-600">
                        {postOperationStates.destAfter.quantity.toLocaleString()} fish
                      </p>
                      <p className="text-xs text-green-600">
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
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <ul className="text-sm text-amber-700 space-y-1">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Validation Errors (blocking) */}
        {errors.length > 0 && (quantity > 0 || destinationTankId) && (
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
            disabled={!isValid || transferBatch.isPending}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {transferBatch.isPending ? 'Transferring...' : 'Transfer Fish'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default TransferModal;
