/**
 * Sampling Modal — "Tartım örneklemesi" in the tank detail popup.
 *
 * Records a growth sample for the tank's production batch through the
 * real `recordGrowthSample` mutation (growth domain): individually weighed
 * sample fish (backend enforces ≥3), population size, and an opt-in batch
 * weight update so avgWeight/biomass follow the measurement.
 */
import React, { useMemo, useState } from 'react';
import { useI18n, useAuth } from '@aquaculture/shared-ui';
import { useRecordGrowthSample, type IndividualMeasurement } from '../../../hooks/useGrowth';
import { TankWithBatch } from '../types';

interface SamplingModalProps {
  isOpen: boolean;
  onClose: () => void;
  tank: TankWithBatch;
  onSuccess: () => void;
}

const MIN_INDIVIDUAL_MEASUREMENTS = 3;

export const SamplingModal: React.FC<SamplingModalProps> = ({
  isOpen,
  onClose,
  tank,
  onSuccess,
}) => {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const recordSample = useRecordGrowthSample();

  const [measurementDate, setMeasurementDate] = useState<string>(
    new Date().toISOString().split('T')[0],
  );
  const [weights, setWeights] = useState<string[]>(['', '', '']);
  const [populationSize, setPopulationSize] = useState<number>(tank.pieces ?? 0);
  const [updateBatchWeight, setUpdateBatchWeight] = useState(true);
  const [notes, setNotes] = useState('');

  const numberLocale = locale === 'tr' ? 'tr-TR' : 'en-US';
  const fmt = (value: number, decimals = 1): string =>
    value.toLocaleString(numberLocale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });

  const parsedWeights = useMemo(
    () => weights.map((w) => parseFloat(w)).filter((w) => !Number.isNaN(w) && w > 0),
    [weights],
  );

  const sampleAverage = useMemo(() => {
    if (parsedWeights.length === 0) return null;
    return parsedWeights.reduce((sum, w) => sum + w, 0) / parsedWeights.length;
  }, [parsedWeights]);

  const estimatedBiomass = useMemo(() => {
    if (sampleAverage === null || populationSize <= 0) return null;
    return (sampleAverage * populationSize) / 1000;
  }, [sampleAverage, populationSize]);

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (parsedWeights.length < MIN_INDIVIDUAL_MEASUREMENTS) {
      errs.push(t('tanksV2.sampling.minThree'));
    }
    if (weights.some((w) => w !== '' && (Number.isNaN(parseFloat(w)) || parseFloat(w) <= 0))) {
      errs.push(t('tanksV2.sampling.positiveWeights'));
    }
    return errs;
  }, [parsedWeights.length, weights, t]);

  const updateWeight = (index: number, value: string): void => {
    setWeights((prev) => prev.map((w, i) => (i === index ? value : w)));
  };

  const addWeight = (): void => setWeights((prev) => [...prev, '']);

  const removeWeight = (index: number): void => {
    setWeights((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (): Promise<void> => {
    if (!tank.batchId || errors.length > 0) return;

    const individualMeasurements: IndividualMeasurement[] = parsedWeights.map((weight, index) => ({
      sampleNumber: index + 1,
      weight,
    }));

    const measuredBy =
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || '';

    try {
      await recordSample.mutateAsync({
        batchId: tank.batchId,
        tankId: tank.id,
        measurementDate: new Date(`${measurementDate}T00:00:00`).toISOString(),
        measurementType: 'routine',
        measurementMethod: 'manual_scale',
        sampleSize: individualMeasurements.length,
        populationSize,
        individualMeasurements,
        measuredBy,
        notes: notes || undefined,
        updateBatchWeight,
      });
      onSuccess();
    } catch {
      // useRecordGrowthSample surfaces the server error through its error
      // state; the modal stays open so the operator can correct and retry.
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('tanksV2.sampling.title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-xl">
        <div className="border-b border-gray-100 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('tanksV2.sampling.title')}</h3>
          <p className="mt-0.5 text-sm text-gray-500">
            {tank.code} · {tank.batchNumber}
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          {/* Date */}
          <div>
            <label htmlFor="sampling-date" className="mb-1 block text-sm font-medium text-gray-700">
              {t('tanksV2.sampling.date')}
            </label>
            <input
              id="sampling-date"
              type="date"
              value={measurementDate}
              onChange={(e) => setMeasurementDate(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Individual weights */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">
                {t('tanksV2.sampling.weights')}
              </span>
              <button
                type="button"
                onClick={addWeight}
                className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
              >
                + {t('tanksV2.sampling.addWeight')}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {weights.map((weight, index) => (
                <div key={index} className="relative">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={weight}
                    onChange={(e) => updateWeight(index, e.target.value)}
                    placeholder={`${tank.avgWeight ?? 0}`}
                    aria-label={`${t('tanksV2.sampling.weights')} ${index + 1}`}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-8 text-sm focus:ring-2 focus:ring-blue-500"
                  />
                  {weights.length > MIN_INDIVIDUAL_MEASUREMENTS && (
                    <button
                      type="button"
                      onClick={() => removeWeight(index)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-600"
                      aria-label={`${t('tanksV2.popup.removeBatch')} ${index + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Population */}
          <div>
            <label
              htmlFor="sampling-population"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              {t('tanksV2.sampling.population')}
            </label>
            <input
              id="sampling-population"
              type="number"
              min="0"
              value={populationSize}
              onChange={(e) => setPopulationSize(parseInt(e.target.value, 10) || 0)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Computed preview */}
          {sampleAverage !== null && (
            <div className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900">
              <div>{t('tanksV2.sampling.computedAvg', { avg: fmt(sampleAverage, 2) })}</div>
              {estimatedBiomass !== null && (
                <div className="mt-0.5">
                  {t('tanksV2.sampling.computedBiomass', { biomass: fmt(estimatedBiomass, 1) })}
                </div>
              )}
            </div>
          )}

          {/* Update batch weight */}
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={updateBatchWeight}
              onChange={(e) => setUpdateBatchWeight(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('tanksV2.sampling.updateBatchWeight')}
          </label>

          {/* Notes */}
          <div>
            <label
              htmlFor="sampling-notes"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              {t('tanksV2.sampling.notes')}
            </label>
            <textarea
              id="sampling-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {errors.length > 0 && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {errors.map((err) => (
                <div key={err}>{err}</div>
              ))}
            </div>
          )}
          {recordSample.isError && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {(recordSample.error as Error).message}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t('feedingV2.mealBoard.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={errors.length > 0 || recordSample.isPending || !tank.batchId}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('tanksV2.sampling.submit')}
          </button>
        </div>
      </div>
    </div>
  );
};
