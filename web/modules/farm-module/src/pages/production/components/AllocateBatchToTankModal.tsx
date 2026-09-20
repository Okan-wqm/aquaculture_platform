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
import { Modal, Button, useToast, Input, Select, Textarea } from '@aquaculture/shared-ui';

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
  const [allocationType, setAllocationType] = useState<AllocationType>('INITIAL_STOCKING');
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

  const projectedBiomassKg = useMemo(() => (quantity * avgWeightG) / 1000, [quantity, avgWeightG]);

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
  }, [tankId, quantity, availableBatchQuantity, avgWeightG, selectedTank, projectedBiomassKg]);

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
      const message = error instanceof Error ? error.message : 'Failed to allocate batch to tank.';
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
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Batch</p>
          <p className="font-medium text-gray-900 dark:text-gray-100">{batchNumber}</p>
          {availableBatchQuantity > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Unassigned stock:{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {availableBatchQuantity.toLocaleString()}
              </span>
            </p>
          )}
        </div>

        <div className="space-y-4">
          <Select
            id="target-tank"
            label="Destination tank"
            required
            placeholder="— Choose a tank —"
            value={tankId}
            onChange={(e) => setTankId(e.target.value)}
            helperText={availableTanks.isLoading ? 'Loading tanks…' : undefined}
            options={(availableTanks.data ?? []).map((tank) => ({
              value: tank.id,
              label: `${tank.name} (${tank.code}) — ${tank.availableCapacity.toFixed(0)} kg free`,
            }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="alloc-quantity"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Quantity <span className="text-accent-500">*</span>
              </label>
              <Input
                fullWidth
                type="number"
                id="alloc-quantity"
                min={1}
                value={quantity || ''}
                onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div>
              <label
                htmlFor="alloc-weight"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Avg weight (g) <span className="text-accent-500">*</span>
              </label>
              <Input
                fullWidth
                type="number"
                id="alloc-weight"
                min={0}
                step="0.1"
                value={avgWeightG || ''}
                onChange={(e) => setAvgWeightG(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>

          <Select
            id="alloc-type"
            label="Allocation type"
            value={allocationType}
            onChange={(e) => setAllocationType(e.target.value as AllocationType)}
            options={ALLOCATION_TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          />

          <Textarea
            label="Notes (optional)"
            fullWidth
            id="alloc-notes"
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {projectedBiomassKg > 0 && (
          <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-info-900 dark:text-info-100">
                Projected biomass
              </span>
              <span className="text-lg font-bold text-info-700 dark:text-info-300">
                {projectedBiomassKg.toFixed(2)} kg
              </span>
            </div>
            {selectedTank && (
              <p className="mt-1 text-xs text-info-700 dark:text-info-300">
                Tank capacity remaining after allocation:{' '}
                {(selectedTank.availableCapacity - projectedBiomassKg).toFixed(1)} kg
              </p>
            )}
          </div>
        )}

        {errors.length > 0 && (
          <div className="bg-accent-50 dark:bg-accent-900/20 border border-accent-200 dark:border-accent-800 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-accent-600 dark:text-accent-400 space-y-1">
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
            className="bg-accent-600 hover:bg-accent-700"
          >
            {allocate.isPending ? 'Allocating…' : 'Allocate to tank'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default AllocateBatchToTankModal;
