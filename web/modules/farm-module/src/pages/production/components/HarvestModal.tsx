/**
 * Harvest Modal
 * Records fish harvest from a tank
 *
 * Note: This modal prepares data for harvest operations.
 * The backend createHarvestRecord mutation may need to be implemented.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { TankBatch } from '../types/batch.types';
import { useCreateHarvestRecord, QualityGrade } from '../../../hooks/useBatches';

// Quality grade labels
const QualityGradeLabels: Record<string, string> = {
  PREMIUM: 'Premium',
  GRADE_A: 'Grade A',
  GRADE_B: 'Grade B',
  GRADE_C: 'Grade C',
  REJECT: 'Reject',
};

interface HarvestModalProps {
  isOpen: boolean;
  onClose: () => void;
  tank: TankBatch;
  onSuccess: () => void;
}

export const HarvestModal: React.FC<HarvestModalProps> = ({
  isOpen,
  onClose,
  tank,
  onSuccess,
}) => {
  // Form state
  const [quantity, setQuantity] = useState<number>(0);
  const [avgWeightG, setAvgWeightG] = useState<number>(tank.avgWeightG || 0);
  const [qualityGrade, setQualityGrade] = useState<QualityGrade>('GRADE_A');
  const [pricePerKg, setPricePerKg] = useState<number | null>(null);
  const [buyerName, setBuyerName] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [harvestDate, setHarvestDate] = useState<string>(new Date().toISOString().split('T')[0]);

  // Mutation hook
  const createHarvestRecord = useCreateHarvestRecord();

  // Calculate total biomass
  const calculatedBiomass = useMemo(() => {
    if (quantity > 0 && avgWeightG > 0) {
      return (quantity * avgWeightG) / 1000; // kg
    }
    return 0;
  }, [quantity, avgWeightG]);

  // Calculate total value
  const totalValue = useMemo(() => {
    if (calculatedBiomass > 0 && pricePerKg && pricePerKg > 0) {
      return calculatedBiomass * pricePerKg;
    }
    return null;
  }, [calculatedBiomass, pricePerKg]);

  // Calculate post-operation state
  const postOperationState = useMemo(() => {
    const newQuantity = Math.max(0, tank.totalQuantity - quantity);
    const newBiomass = Math.max(0, tank.totalBiomassKg - calculatedBiomass);
    return {
      quantity: newQuantity,
      biomass: newBiomass,
    };
  }, [tank.totalQuantity, tank.totalBiomassKg, quantity, calculatedBiomass]);

  // Validation
  const errors = useMemo(() => {
    const errs: string[] = [];
    if (quantity <= 0) {
      errs.push('Quantity must be greater than 0');
    }
    if (quantity > tank.totalQuantity) {
      errs.push(`Quantity cannot exceed tank stock (${tank.totalQuantity.toLocaleString()})`);
    }
    if (avgWeightG <= 0) {
      errs.push('Average weight must be greater than 0');
    }
    if (!notes.trim()) {
      errs.push('Please add harvest notes');
    }
    return errs;
  }, [quantity, tank.totalQuantity, avgWeightG, notes]);

  const isValid = errors.length === 0;

  // Reset form
  const resetForm = useCallback(() => {
    setQuantity(0);
    setAvgWeightG(tank.avgWeightG || 0);
    setQualityGrade('GRADE_A');
    setPricePerKg(null);
    setBuyerName('');
    setNotes('');
    setHarvestDate(new Date().toISOString().split('T')[0]);
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
      await createHarvestRecord.mutateAsync({
        batchId: tank.primaryBatchId,
        tankId: tank.equipmentId,
        quantityHarvested: quantity,
        averageWeight: avgWeightG,
        totalBiomass: calculatedBiomass,
        qualityGrade,
        harvestDate,
        pricePerKg: pricePerKg || undefined,
        buyerName: buyerName || undefined,
        notes,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to record harvest:', error);
      const message = error instanceof Error ? error.message : 'Failed to record harvest';
      if (message.includes('createHarvestRecord')) {
        alert('Harvest recording is not yet implemented in the backend. Please contact system administrator.');
      } else {
        alert(message);
      }
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Record Harvest" size="lg">
      <div className="space-y-6">
        {/* Tank Info Header */}
        <div className="bg-purple-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-purple-600 uppercase font-medium">Harvest from</p>
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
        <div className="grid grid-cols-2 gap-4">
          {/* Quantity */}
          <div>
            <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
              Harvest Quantity <span className="text-purple-500">*</span>
            </label>
            <input
              type="number"
              id="quantity"
              min="1"
              max={tank.totalQuantity}
              value={quantity || ''}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
              placeholder="Number of fish"
            />
            {/* Quick select buttons */}
            <div className="mt-2 flex gap-2">
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
              Average Weight (g) <span className="text-purple-500">*</span>
            </label>
            <input
              type="number"
              id="avgWeight"
              min="0"
              step="0.1"
              value={avgWeightG || ''}
              onChange={(e) => setAvgWeightG(parseFloat(e.target.value) || 0)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
              placeholder="Average weight per fish"
            />
            <p className="mt-1 text-xs text-gray-500">
              Tank average: {tank.avgWeightG?.toFixed(1) || 0} g
            </p>
          </div>
        </div>

        {/* Biomass Calculation */}
        {quantity > 0 && avgWeightG > 0 && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-purple-800">Total Harvest Biomass</span>
              <span className="text-xl font-bold text-purple-600">
                {calculatedBiomass.toFixed(2)} kg
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {/* Quality Grade */}
          <div>
            <label htmlFor="qualityGrade" className="block text-sm font-medium text-gray-700">
              Quality Grade <span className="text-purple-500">*</span>
            </label>
            <select
              id="qualityGrade"
              value={qualityGrade}
              onChange={(e) => setQualityGrade(e.target.value as QualityGrade)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
            >
              {Object.entries(QualityGradeLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Harvest Date */}
          <div>
            <label htmlFor="harvestDate" className="block text-sm font-medium text-gray-700">
              Harvest Date
            </label>
            <input
              type="date"
              id="harvestDate"
              value={harvestDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setHarvestDate(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Price per Kg */}
          <div>
            <label htmlFor="pricePerKg" className="block text-sm font-medium text-gray-700">
              Price per Kg (optional)
            </label>
            <input
              type="number"
              id="pricePerKg"
              min="0"
              step="0.01"
              value={pricePerKg || ''}
              onChange={(e) => setPricePerKg(e.target.value ? parseFloat(e.target.value) : null)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
              placeholder="Enter price"
            />
          </div>

          {/* Buyer Name */}
          <div>
            <label htmlFor="buyerName" className="block text-sm font-medium text-gray-700">
              Buyer Name (optional)
            </label>
            <input
              type="text"
              id="buyerName"
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
              placeholder="Enter buyer name"
            />
          </div>
        </div>

        {/* Total Value Calculation */}
        {totalValue !== null && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-green-800">Estimated Total Value</span>
              <span className="text-xl font-bold text-green-600">
                ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
            Harvest Notes <span className="text-purple-500">*</span>
          </label>
          <textarea
            id="notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
            placeholder="Document harvest details, conditions, observations..."
          />
        </div>

        {/* Pre/Post Operation State */}
        {quantity > 0 && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Tank Status After Harvest</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">Before</p>
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="text-gray-600">Stock:</span>{' '}
                    <span className="font-medium">{tank.totalQuantity.toLocaleString()}</span>
                  </p>
                  <p className="text-sm">
                    <span className="text-gray-600">Biomass:</span>{' '}
                    <span className="font-medium">{tank.totalBiomassKg.toFixed(1)} kg</span>
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">After</p>
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="text-gray-600">Stock:</span>{' '}
                    <span className="font-medium text-purple-600">
                      {postOperationState.quantity.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-sm">
                    <span className="text-gray-600">Biomass:</span>{' '}
                    <span className="font-medium text-purple-600">
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
            disabled={!isValid || createHarvestRecord.isPending}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {createHarvestRecord.isPending ? 'Recording...' : 'Record Harvest'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default HarvestModal;
