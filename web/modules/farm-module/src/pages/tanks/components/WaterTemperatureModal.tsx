/**
 * Water Temperature Modal
 *
 * WHY: the daily feeding-rate calculation now reads the latest MANUAL water
 * temperature per tank (farm-service WaterTemperatureService — the temperature
 * multiplier of a feeding protocol). Operators had no discoverable place on the
 * Tanks page to enter it. WHAT: a compact per-tank quick entry that records a
 * single-parameter WaterQualityMeasurement (temperature) through the SAME
 * validated single-ingress create path used by the full Water Chemistry
 * RecordTab, so the feed-rate columns pick up the new value on the next refetch.
 *
 * Uses the dedicated `recordWaterTemperature(tankId, celsius)` mutation, NOT the
 * full `createWaterQualityMeasurement` path: temperature is a single standalone
 * observation, so it must not be forced through the multi-parameter strict
 * validation (which would reject on any tank where `temperature` is not mapped,
 * or where another required-mapped parameter is missing). The reading still lands
 * in `water_quality_measurements` (source MANUAL) and is read back by
 * WaterTemperatureService. Client-side we only guard NaN + physical bounds.
 */
import React, { useState, useCallback } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';
import { useRecordWaterTemperature } from '../../../hooks/useWaterQuality';

interface WaterTemperatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  tankId: string;
  tankName: string;
  onSuccess: () => void;
}

// Sensible physical bounds for aquaculture water temperature (°C).
const MIN_TEMPERATURE_C = 0;
const MAX_TEMPERATURE_C = 40;

export const WaterTemperatureModal: React.FC<WaterTemperatureModalProps> = ({
  isOpen,
  onClose,
  tankId,
  tankName,
  onSuccess,
}) => {
  const [temperature, setTemperature] = useState<string>('');
  const recordTemperature = useRecordWaterTemperature();
  const { toast } = useToast();

  const resetForm = useCallback((): void => {
    setTemperature('');
  }, []);

  const handleClose = useCallback((): void => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const value = parseFloat(temperature);

    if (Number.isNaN(value)) {
      toast({
        title: 'Validation Error',
        description: 'Enter a water temperature.',
        variant: 'error',
      });
      return;
    }

    if (value < MIN_TEMPERATURE_C || value > MAX_TEMPERATURE_C) {
      toast({
        title: 'Validation Error',
        description: `Temperature must be between ${MIN_TEMPERATURE_C} and ${MAX_TEMPERATURE_C} °C.`,
        variant: 'error',
      });
      return;
    }

    try {
      // Dedicated single-observation path: records a MANUAL temperature reading
      // without the full multi-parameter water-quality validation, so it works
      // on any tank (even one with no water-quality parameters mapped yet).
      await recordTemperature.mutateAsync({ tankId, celsius: value });

      toast({
        title: 'Temperature recorded',
        description: `${value} °C saved for ${tankName}.`,
        variant: 'success',
      });
      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to record temperature. Please try again.';
      toast({ title: 'Error', description: message, variant: 'error' });
    }
  }, [temperature, tankId, tankName, recordTemperature, toast, resetForm, onSuccess, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Record Water Temperature" size="sm">
      <div className="space-y-6">
        {/* Tank context */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="font-medium text-gray-900">{tankName}</h3>
          <p className="mt-1 text-sm text-gray-500">
            Records the latest manual water temperature used by the feeding-rate calculation.
          </p>
        </div>

        {/* Temperature input */}
        <div>
          <label htmlFor="water-temperature" className="block text-sm font-medium text-gray-700">
            Water Temperature (°C) <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            id="water-temperature"
            step="0.1"
            min={MIN_TEMPERATURE_C}
            max={MAX_TEMPERATURE_C}
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="e.g. 12.5"
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
            disabled={recordTemperature.isPending || temperature.trim() === ''}
          >
            {recordTemperature.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default WaterTemperatureModal;
