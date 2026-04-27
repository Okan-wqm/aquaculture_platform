/**
 * AllocateBatchToTankModal
 *
 * Surfaces the `allocateBatchToTank` mutation. Capacity invariants
 * are enforced centrally by `TankCapacityService` on the backend
 * (phase 1.1) so this modal is deliberately thin: the operator
 * chooses a destination tank, enters the allocation quantity and
 * average weight, and submits. If the backend rejects due to
 * capacity / density / status, the error message is surfaced via
 * toast — the service returns structured details that already name
 * the failing axis.
 *
 * Phase 3 Tier 1 of the "Farm modülü kalan kör noktalar" plan.
 */
import React, { useMemo, useState } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';

import {
  AllocationType,
  useAllocateBatchToTank,
  useAvailableTanks,
} from '../../../hooks/useBatches';

interface AllocateBatchToTankModalProps {
  isOpen: boolean;
  onClose: () => void;
  batchId: string;
  batchNumber: string;
  siteId?: string;
  departmentId?: string;
  availableBatchQuantity: number;
  onSuccess?: () => void;
}

const ALLOCATION_TYPE_OPTIONS: Array<{
  value: AllocationType;
  label: string;
}> = [
  { value: 'INITIAL_STOCKING', label: 'Initial stocking' },
  { value: 'TRANSFER_IN', label: 'Transfer in' },
  { value: 'REDISTRIBUTION', label: 'Redistribution' },
];

export const AllocateBatchToTankModal: React.FC<AllocateBatchToTankModalProps> = ({
  isOpen,
  onClose,
  batchId,
  batchNumber,
  siteId,
  departmentId,
  availableBatchQuantity,
  onSuccess,
}) => {
  const [tankId, setTankId] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(0);
  const [avgWeightG, setAvgWeightG] = useState<number>(0);
  const [allocationType, setAllocationType] =
    useState<AllocationType>('INITIAL_STOCKING');
  const [notes, setNotes] = useState<string>('');

  const availableTanks = useAvailableTanks({
    siteId,
    departmentId,
    excludeFullTanks: true,
  });
  const allocate = useAllocateBatchToTank();
  const { toast } = useToast();

  const selectedTank = useMemo(
    () => availableTanks.data?.find((t) => t.id === tankId),
    [availableTanks.data, tankId],
  );

  const projectedBiomassKg = useMemo(
    () => (quantity * avgWeightG) / 1000,
    [quantity, avgWeightG],
  );

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!tankId) errs.push('Choose a destination tank.');
    if (quantity <= 0) errs.push('Quantity must be greater than 0.');
    if (availableBatchQuantity > 0 && quantity > availableBatchQuantity) {
      errs.push(
        `Quantity cannot exceed the batch's unassigned stock (${availableBatchQuantity.toLocaleString()}).`,
      );
    }
    if (avgWeightG <= 0) errs.push('Average weight must be greater than 0 g.');
    if (selectedTank && projectedBiomassKg > selectedTank.availableCapacity) {
      errs.push(
        `Projected biomass ${projectedBiomassKg.toFixed(1)} kg exceeds the tank's remaining capacity ${selectedTank.availableCapacity.toFixed(1)} kg.`,
      );
    }
    return errs;
  }, [
    tankId,
    quantity,
    availableBatchQuantity,
    avgWeightG,
    selectedTank,
    projectedBiomassKg,
  ]);

  const isValid = errors.length === 0;

  const resetForm = () => {
    setTankId('');
    setQuantity(0);
    setAvgWeightG(0);
    setAllocationType('INITIAL_STOCKING');
    setNotes('');
  };

  const handleSubmit = async () => {
    if (!isValid) return;
    try {
      await allocate.mutateAsync({
        batchId,
        tankId,
        quantity,
        avgWeightG,
        allocationType,
        notes: notes.trim() || undefined,
      });
      toast({
        title: 'Allocation recorded',
        description: `${quantity.toLocaleString()} fish allocated to ${selectedTank?.name ?? 'tank'}.`,
        variant: 'success',
      });
      resetForm();
      onSuccess?.();
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to allocate batch to tank.';
      toast({ title: 'Error', description: message, variant: 'error' });
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Allocate Batch to Tank" size="md">
      <div className="space-y-6">
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-sm text-gray-500">Batch</p>
          <p className="font-medium text-gray-900">{batchNumber}</p>
          {availableBatchQuantity > 0 && (
            <p className="text-sm text-gray-500 mt-2">
              Unassigned stock:{' '}
              <span className="font-medium text-gray-900">
                {availableBatchQuantity.toLocaleString()}
              </span>
            </p>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="target-tank" className="block text-sm font-medium text-gray-700">
              Destination tank <span className="text-orange-500">*</span>
            </label>
            <select
              id="target-tank"
              value={tankId}
              onChange={(e) => setTankId(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            >
              <option value="">— Choose a tank —</option>
              {availableTanks.data?.map((tank) => (
                <option key={tank.id} value={tank.id}>
                  {tank.name} ({tank.code}) — {tank.availableCapacity.toFixed(0)} kg free
                </option>
              ))}
            </select>
            {availableTanks.isLoading && (
              <p className="mt-1 text-xs text-gray-500">Loading tanks…</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="alloc-quantity" className="block text-sm font-medium text-gray-700">
                Quantity <span className="text-orange-500">*</span>
              </label>
              <input
                type="number"
                id="alloc-quantity"
                min={1}
                value={quantity || ''}
                onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
              />
            </div>
            <div>
              <label htmlFor="alloc-weight" className="block text-sm font-medium text-gray-700">
                Avg weight (g) <span className="text-orange-500">*</span>
              </label>
              <input
                type="number"
                id="alloc-weight"
                min={0}
                step="0.1"
                value={avgWeightG || ''}
                onChange={(e) => setAvgWeightG(parseFloat(e.target.value) || 0)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="alloc-type" className="block text-sm font-medium text-gray-700">
              Allocation type
            </label>
            <select
              id="alloc-type"
              value={allocationType}
              onChange={(e) => setAllocationType(e.target.value as AllocationType)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            >
              {ALLOCATION_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="alloc-notes" className="block text-sm font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="alloc-notes"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            />
          </div>
        </div>

        {projectedBiomassKg > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-blue-900">Projected biomass</span>
              <span className="text-lg font-bold text-blue-700">
                {projectedBiomassKg.toFixed(2)} kg
              </span>
            </div>
            {selectedTank && (
              <p className="mt-1 text-xs text-blue-700">
                Tank capacity remaining after allocation:{' '}
                {(selectedTank.availableCapacity - projectedBiomassKg).toFixed(1)} kg
              </p>
            )}
          </div>
        )}

        {errors.length > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-orange-600 space-y-1">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isValid || allocate.isPending}
            className="bg-orange-600 hover:bg-orange-700"
          >
            {allocate.isPending ? 'Allocating…' : 'Allocate to tank'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default AllocateBatchToTankModal;
