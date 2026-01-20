/**
 * CreateBatchModal Component
 *
 * Modal for creating a new cleaner fish batch.
 */
import React, { useState, useCallback } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import {
  useCreateCleanerBatch,
  CleanerFishSpecies,
  CleanerFishSourceType,
} from '../../../hooks/useCleanerFish';
import { SourceTypeLabels } from '../types';

interface CreateBatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  species: CleanerFishSpecies[];
  onSuccess: () => void;
}

export const CreateBatchModal: React.FC<CreateBatchModalProps> = ({
  isOpen,
  onClose,
  species,
  onSuccess,
}) => {
  // Form state
  const [speciesId, setSpeciesId] = useState<string>('');
  const [initialQuantity, setInitialQuantity] = useState<number>(0);
  const [initialAvgWeightG, setInitialAvgWeightG] = useState<number>(0);
  const [sourceType, setSourceType] = useState<CleanerFishSourceType>('farmed');
  const [sourceLocation, setSourceLocation] = useState<string>('');
  const [stockedAt, setStockedAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [purchaseCost, setPurchaseCost] = useState<number | undefined>();
  const [currency, setCurrency] = useState<string>('NOK');
  const [notes, setNotes] = useState<string>('');

  // Mutation
  const createBatch = useCreateCleanerBatch();

  // Reset form
  const resetForm = useCallback(() => {
    setSpeciesId('');
    setInitialQuantity(0);
    setInitialAvgWeightG(0);
    setSourceType('farmed');
    setSourceLocation('');
    setStockedAt(new Date().toISOString().split('T')[0]);
    setPurchaseCost(undefined);
    setCurrency('NOK');
    setNotes('');
  }, []);

  // Validation
  const isValid =
    speciesId && initialQuantity > 0 && initialAvgWeightG > 0 && stockedAt;

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid) return;

    try {
      await createBatch.mutateAsync({
        speciesId,
        initialQuantity,
        initialAvgWeightG,
        sourceType,
        sourceLocation: sourceLocation || undefined,
        stockedAt,
        purchaseCost,
        currency: purchaseCost ? currency : undefined,
        notes: notes || undefined,
      });

      resetForm();
      onSuccess();
    } catch (error) {
      console.error('Failed to create cleaner batch:', error);
      alert(error instanceof Error ? error.message : 'Failed to create batch');
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Cleaner Fish Batch" size="md">
      <div className="space-y-6">
        {/* Species Selection */}
        <div>
          <label htmlFor="species" className="block text-sm font-medium text-gray-700">
            Species <span className="text-red-500">*</span>
          </label>
          <select
            id="species"
            value={speciesId}
            onChange={(e) => setSpeciesId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="">Select a species...</option>
            {species.map((s) => (
              <option key={s.id} value={s.id}>
                {s.commonName} ({s.code})
              </option>
            ))}
          </select>
          {species.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">
              No cleaner fish species found. Add species with "isCleanerFish" enabled in Setup.
            </p>
          )}
        </div>

        {/* Quantity */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
              Initial Quantity <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="quantity"
              min="1"
              value={initialQuantity || ''}
              onChange={(e) => setInitialQuantity(parseInt(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter quantity"
            />
          </div>
          <div>
            <label htmlFor="avgWeight" className="block text-sm font-medium text-gray-700">
              Avg Weight (g) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="avgWeight"
              min="0.1"
              step="0.1"
              value={initialAvgWeightG || ''}
              onChange={(e) => setInitialAvgWeightG(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter weight"
            />
          </div>
        </div>

        {/* Calculated Biomass */}
        {initialQuantity > 0 && initialAvgWeightG > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-blue-800">Total Biomass</span>
              <span className="text-lg font-bold text-blue-600">
                {((initialQuantity * initialAvgWeightG) / 1000).toFixed(2)} kg
              </span>
            </div>
          </div>
        )}

        {/* Source Type */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="sourceType" className="block text-sm font-medium text-gray-700">
              Source Type
            </label>
            <select
              id="sourceType"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as CleanerFishSourceType)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              {Object.entries(SourceTypeLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sourceLocation" className="block text-sm font-medium text-gray-700">
              Source Location
            </label>
            <input
              type="text"
              id="sourceLocation"
              value={sourceLocation}
              onChange={(e) => setSourceLocation(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="e.g., Supplier name or location"
            />
          </div>
        </div>

        {/* Stocked Date */}
        <div>
          <label htmlFor="stockedAt" className="block text-sm font-medium text-gray-700">
            Stocked Date <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            id="stockedAt"
            value={stockedAt}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setStockedAt(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          />
        </div>

        {/* Purchase Cost */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="purchaseCost" className="block text-sm font-medium text-gray-700">
              Purchase Cost
            </label>
            <input
              type="number"
              id="purchaseCost"
              min="0"
              step="0.01"
              value={purchaseCost || ''}
              onChange={(e) => setPurchaseCost(parseFloat(e.target.value) || undefined)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Optional"
            />
          </div>
          <div>
            <label htmlFor="currency" className="block text-sm font-medium text-gray-700">
              Currency
            </label>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              <option value="NOK">NOK</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
              <option value="TRY">TRY</option>
            </select>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
            Notes
          </label>
          <textarea
            id="notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="Optional notes about this batch..."
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isValid || createBatch.isPending}
          >
            {createBatch.isPending ? 'Creating...' : 'Create Batch'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default CreateBatchModal;
