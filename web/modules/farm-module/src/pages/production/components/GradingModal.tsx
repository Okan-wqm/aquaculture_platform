/**
 * Grading Modal (FARM-MEDIUM-117)
 *
 * Splits a tank's fish by size class into multiple destination tanks in one
 * operation. Server-side each output row is its own transfer (reason
 * 'grading') through the movement-ledger SSoT; a mid-sequence failure leaves
 * the already-committed outputs moved, and the server error names them so the
 * operator resubmits only the remainder — that message is surfaced verbatim.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';
import { TankBatch } from '../types/batch.types';
import {
  useRecordGrading,
  useAvailableTanks,
  AvailableTank,
  GradingOutputDraft,
} from '../../../hooks/useBatches';
import { BatchScopeSelector } from './BatchScopeSelector';

const MAX_OUTPUTS = 12;

interface OutputRow {
  /** Stable per-row identity (FARM-MEDIUM-129) — carried to the hook as rowKey. */
  rowId: string;
  destinationTankId: string;
  quantity: number;
  avgWeightG: number;
  sizeClass: string;
}

const emptyRow = (avgWeightG: number): OutputRow => ({
  rowId: crypto.randomUUID(),
  destinationTankId: '',
  quantity: 0,
  avgWeightG,
  sizeClass: '',
});

interface GradingModalProps {
  isOpen: boolean;
  onClose: () => void;
  tank: TankBatch;
  onSuccess: () => void;
}

export const GradingModal: React.FC<GradingModalProps> = ({
  isOpen,
  onClose,
  tank,
  onSuccess,
}) => {
  const [selectedBatchId, setSelectedBatchId] = useState<string | undefined>(tank.primaryBatchId);

  // Combined-tank scoping: grading splits the SELECTED batch, so the source stock,
  // biomass, remaining count and per-row weight defaults are that batch's share —
  // you cannot grade out more fish than the selected batch holds. A single-batch
  // tank falls back to the tank totals (behaviour unchanged).
  const isCombined = (tank.batchDetails?.length ?? 0) > 1;
  const selectedBatch = useMemo(
    () => (isCombined ? tank.batchDetails?.find((b) => b.batchId === selectedBatchId) : undefined),
    [isCombined, tank.batchDetails, selectedBatchId],
  );
  const availableQuantity = selectedBatch?.quantity ?? tank.totalQuantity;
  const availableBiomassKg = selectedBatch?.biomassKg ?? tank.totalBiomassKg;
  const sourceAvgWeightG = selectedBatch?.avgWeightG ?? tank.avgWeightG ?? 0;
  const selectedBatchNumber = selectedBatch?.batchNumber ?? tank.primaryBatchNumber;

  const [rows, setRows] = useState<OutputRow[]>([
    emptyRow(sourceAvgWeightG),
    emptyRow(sourceAvgWeightG),
  ]);
  const [gradedAt, setGradedAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState<string>('');

  const recordGrading = useRecordGrading();
  const { toast } = useToast();

  const { data: availableTanks = [], isLoading: tanksLoading } = useAvailableTanks({
    excludeFullTanks: false,
  });

  const destinationTanks = useMemo(
    () => availableTanks.filter((t: AvailableTank) => t.id !== tank.equipmentId),
    [availableTanks, tank.equipmentId],
  );

  const totalQuantity = useMemo(
    () => rows.reduce((sum, row) => sum + (row.quantity || 0), 0),
    [rows],
  );

  const totalBiomassKg = useMemo(
    () => rows.reduce((sum, row) => sum + ((row.quantity || 0) * (row.avgWeightG || 0)) / 1000, 0),
    [rows],
  );

  const remainingInSource = Math.max(0, availableQuantity - totalQuantity);

  const errors = useMemo(() => {
    const errs: string[] = [];
    rows.forEach((row, index) => {
      if (!row.destinationTankId) errs.push(`Output ${index + 1}: select a destination tank`);
      if (row.quantity <= 0) errs.push(`Output ${index + 1}: quantity must be greater than 0`);
      if (row.avgWeightG <= 0) errs.push(`Output ${index + 1}: average weight must be greater than 0`);
    });
    const chosen = rows.map((r) => r.destinationTankId).filter(Boolean);
    if (new Set(chosen).size !== chosen.length) {
      errs.push('Each output must target a different destination tank');
    }
    if (totalQuantity > availableQuantity) {
      errs.push(
        `Total graded quantity (${totalQuantity.toLocaleString()}) exceeds ${isCombined ? 'batch' : 'source tank'} stock (${availableQuantity.toLocaleString()})`,
      );
    }
    return errs;
  }, [rows, totalQuantity, availableQuantity, isCombined]);

  const isValid = errors.length === 0 && rows.length > 0;

  const updateRow = useCallback((index: number, patch: Partial<OutputRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) =>
      prev.length >= MAX_OUTPUTS ? prev : [...prev, emptyRow(sourceAvgWeightG)],
    );
  }, [sourceAvgWeightG]);

  const removeRow = useCallback((index: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }, []);

  const resetForm = useCallback(() => {
    setRows([emptyRow(sourceAvgWeightG), emptyRow(sourceAvgWeightG)]);
    setGradedAt(new Date().toISOString().split('T')[0]);
    setNotes('');
    setSelectedBatchId(tank.primaryBatchId);
  }, [sourceAvgWeightG, tank.primaryBatchId]);

  const handleSubmit = async () => {
    if (!isValid) return;
    if (!selectedBatchId) {
      toast({ title: 'Validation Error', description: 'No batch assigned to this tank.', variant: 'error' });
      return;
    }

    const outputs: GradingOutputDraft[] = rows.map((row) => ({
      rowKey: row.rowId,
      destinationTankId: row.destinationTankId,
      quantity: row.quantity,
      avgWeightG: row.avgWeightG,
      sizeClass: row.sizeClass.trim() || undefined,
    }));

    try {
      await recordGrading.mutateAsync({
        batchId: selectedBatchId,
        sourceTankId: tank.equipmentId,
        gradedAt,
        notes: notes.trim() || undefined,
        outputs,
      });
      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      // The server error is operational truth here: on a mid-sequence failure it
      // names the outputs that ALREADY moved so the operator resubmits only the
      // remainder. Show it verbatim instead of a generic message.
      const message = error instanceof Error ? error.message : 'Failed to record grading.';
      console.error('[GradingModal] Grading failed:', message);
      toast({ title: 'Grading Error', description: message, variant: 'error' });
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Grade Fish" size="lg">
      <div className="space-y-6">
        {/* Source Tank Info Header */}
        <div className="bg-purple-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-purple-600 uppercase font-medium">Source Tank</p>
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
              <p className="text-sm text-gray-500">{availableBiomassKg.toFixed(1)} kg</p>
            </div>
          </div>
        </div>

        {/* Combined-tank batch scope (renders only when >1 batch shares the tank) */}
        <BatchScopeSelector
          batchDetails={tank.batchDetails}
          selectedBatchId={selectedBatchId}
          onChange={setSelectedBatchId}
          accent="purple"
        />

        {/* Output rows */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700">
              Grading Outputs ({rows.length}/{MAX_OUTPUTS})
            </h4>
            <button
              type="button"
              onClick={addRow}
              disabled={rows.length >= MAX_OUTPUTS}
              className="px-2 py-1 text-xs bg-purple-100 text-purple-700 hover:bg-purple-200 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            >
              + Add Output
            </button>
          </div>

          {rows.map((row, index) => (
            <div
              key={index}
              className="border border-gray-200 rounded-lg p-3 space-y-2"
              data-testid={`grading-output-${index}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500 uppercase">
                  Output {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  disabled={rows.length <= 1}
                  className="text-xs text-red-600 hover:text-red-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Remove
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label
                    htmlFor={`grading-destination-${index}`}
                    className="block text-xs font-medium text-gray-700"
                  >
                    Destination Tank <span className="text-purple-500">*</span>
                  </label>
                  {tanksLoading ? (
                    <div className="mt-1 text-sm text-gray-500">Loading tanks...</div>
                  ) : (
                    <select
                      id={`grading-destination-${index}`}
                      value={row.destinationTankId}
                      onChange={(e) => updateRow(index, { destinationTankId: e.target.value })}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                    >
                      <option value="">Select destination tank...</option>
                      {destinationTanks.map((t: AvailableTank) => {
                        const available = Math.max(0, t.maxBiomass - t.currentBiomass);
                        return (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.code}) - {available.toFixed(0)} kg available
                            {t.currentCount > 0
                              ? ` [${t.currentCount.toLocaleString()} fish]`
                              : ' [Empty]'}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>

                <div>
                  <label
                    htmlFor={`grading-quantity-${index}`}
                    className="block text-xs font-medium text-gray-700"
                  >
                    Quantity <span className="text-purple-500">*</span>
                  </label>
                  <input
                    type="number"
                    id={`grading-quantity-${index}`}
                    min="1"
                    max={availableQuantity}
                    value={row.quantity || ''}
                    onChange={(e) => updateRow(index, { quantity: parseInt(e.target.value) || 0 })}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                    placeholder="Fish count"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`grading-avgweight-${index}`}
                    className="block text-xs font-medium text-gray-700"
                  >
                    Avg Weight (g) <span className="text-purple-500">*</span>
                  </label>
                  <input
                    type="number"
                    id={`grading-avgweight-${index}`}
                    min="0.01"
                    step="0.1"
                    value={row.avgWeightG || ''}
                    onChange={(e) =>
                      updateRow(index, { avgWeightG: parseFloat(e.target.value) || 0 })
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                    placeholder="Measured size-class weight"
                  />
                </div>

                <div className="col-span-2">
                  <label
                    htmlFor={`grading-sizeclass-${index}`}
                    className="block text-xs font-medium text-gray-700"
                  >
                    Size Class
                  </label>
                  <input
                    type="text"
                    id={`grading-sizeclass-${index}`}
                    maxLength={64}
                    value={row.sizeClass}
                    onChange={(e) => updateRow(index, { sizeClass: e.target.value })}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                    placeholder="e.g. Small / Medium / Large or >250g"
                  />
                </div>
              </div>

              {row.quantity > 0 && row.avgWeightG > 0 && (
                <p className="text-xs text-gray-500">
                  Biomass: {((row.quantity * row.avgWeightG) / 1000).toFixed(2)} kg
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Date + Notes */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="gradedAt" className="block text-sm font-medium text-gray-700">
              Grading Date
            </label>
            <input
              type="date"
              id="gradedAt"
              value={gradedAt}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setGradedAt(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
            />
          </div>
          <div>
            <label htmlFor="gradingNotes" className="block text-sm font-medium text-gray-700">
              Notes
            </label>
            <input
              type="text"
              id="gradingNotes"
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
              placeholder="Optional operation notes"
            />
          </div>
        </div>

        {/* Totals summary */}
        {totalQuantity > 0 && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xs text-purple-600 uppercase">Total Graded</p>
                <p className="text-lg font-bold text-purple-700">
                  {totalQuantity.toLocaleString()} fish
                </p>
                <p className="text-xs text-purple-600">{totalBiomassKg.toFixed(1)} kg</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase">Source Before</p>
                <p className="text-lg font-bold text-gray-700">
                  {availableQuantity.toLocaleString()} fish
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase">Source After</p>
                <p className="text-lg font-bold text-gray-700">
                  {remainingInSource.toLocaleString()} fish
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Validation errors */}
        {errors.length > 0 && rows.some((r) => r.destinationTankId || r.quantity > 0) && (
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
            disabled={!isValid || recordGrading.isPending}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {recordGrading.isPending ? 'Grading...' : 'Grade Fish'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default GradingModal;
