/**
 * UpdateMeterReadingButton — Tier 3 #8 (Scope C PR-8)
 *
 * Per-row "Update Meter" affordance for METER_BASED schedules on
 * `MaintenanceSchedulesPage`. Distinct from the meter capture inside
 * `CompleteMaintenanceModal` (which closes a cycle) — this surface
 * exists for walk-around meter readings between maintenance events,
 * which the operator needs to register so the
 * `isMeterBasedMaintenanceDue()` calculation stays accurate.
 *
 * Visibility rules
 * ----------------
 *   - Hidden when `useCanMutate('updateMeterReading')` is false
 *     (operators without the role see nothing greyed out).
 *   - Hidden when the schedule isn't METER_BASED — backend would
 *     reject with "Bu plan meter bazlı değil"; surfacing a button
 *     that always errors out is a UX trap.
 *
 * Validation
 * ----------
 *   - Required, finite, >= 0 (mirrors backend `@Min(0)`).
 *   - >= `lastMaintenanceMeterReading` (UI gate; non-decreasing
 *     indicates operator data-entry error and would corrupt the
 *     schedule's meter history). The backend doesn't enforce
 *     non-decreasing — it just stores `currentMeterReading` — so
 *     this gate is the authoritative protection.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Modal,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import {
  type MaintenanceSchedule,
  useUpdateMeterReading,
} from '../../../hooks/useMaintenance';

interface UpdateMeterReadingButtonProps {
  schedule: MaintenanceSchedule;
}

const UpdateMeterReadingButton: React.FC<UpdateMeterReadingButtonProps> = ({
  schedule,
}) => {
  const canUpdate = useCanMutate('updateMeterReading');
  const { toast } = useToast();
  const updateMutation = useUpdateMeterReading();

  const [isOpen, setIsOpen] = useState(false);
  const [meterRaw, setMeterRaw] = useState<string>('');

  const isMeterBased = schedule.recurrenceRule.type === 'METER_BASED';
  const lastMeter = schedule.lastMaintenanceMeterReading ?? null;
  const currentMeter = schedule.currentMeterReading ?? null;

  // Reset form when the modal opens against a different schedule.
  useEffect(() => {
    if (isOpen) {
      setMeterRaw(currentMeter != null ? String(currentMeter) : '');
    }
  }, [isOpen, schedule.id, currentMeter]);

  const meterParsed: number | null = useMemo(() => {
    const trimmed = meterRaw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, [meterRaw]);

  const errors: string[] = useMemo(() => {
    const errs: string[] = [];
    if (meterParsed === null) {
      errs.push('A meter reading is required.');
    } else if (Number.isNaN(meterParsed)) {
      errs.push('The meter reading must be a valid number.');
    } else if (meterParsed < 0) {
      errs.push('The meter reading cannot be negative.');
    } else if (lastMeter != null && meterParsed < lastMeter) {
      errs.push(
        `The new reading (${meterParsed}) cannot be lower than the last one (${lastMeter}).`,
      );
    }
    return errs;
  }, [meterParsed, lastMeter]);

  const isFormValid = errors.length === 0;
  const isSubmitting = updateMutation.isPending;

  if (!canUpdate || !isMeterBased) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || isSubmitting || meterParsed === null) return;

    try {
      await updateMutation.mutateAsync({
        id: schedule.id,
        meterReading: meterParsed,
      });
      toast({
        title: 'Meter updated',
        description: `Meter for ${schedule.scheduleCode} saved as ${meterParsed}.`,
        variant: 'success',
      });
      setIsOpen(false);
    } catch (err) {
      toast({
        title: 'Could not update the meter',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="text-cyan-700 hover:text-cyan-900"
        title="Update the meter reading (METER_BASED)"
      >
        Update Meter
      </button>

      <Modal
        className="sd-f2"
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Update Meter Reading"
        size="sm"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500">Plan</p>
            <p className="font-medium text-gray-900">
              {schedule.scheduleCode} — {schedule.name}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {currentMeter != null ? (
                <>Mevcut: {currentMeter}</>
              ) : (
                <>Current: no recorded reading</>
              )}
              {lastMeter != null && (
                <> · last reading: {lastMeter}</>
              )}
              {schedule.nextMaintenanceMeterReading != null && (
                <> · next maintenance: {schedule.nextMaintenanceMeterReading}</>
              )}
            </p>
          </div>

          <div>
            <label
              htmlFor="meter-reading-input"
              className="block text-sm font-medium text-gray-700"
            >
              New Meter Reading{' '}
              <span className="text-red-600">*</span>
            </label>
            <input
              id="meter-reading-input"
              type="number"
              step="0.01"
              min={lastMeter ?? 0}
              value={meterRaw}
              onChange={(e) => setMeterRaw(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              required
              autoFocus
            />
          </div>

          {errors.length > 0 && (
            <ul className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800 space-y-1">
              {errors.map((msg, idx) => (
                <li key={idx}>• {msg}</li>
              ))}
            </ul>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!isFormValid || isSubmitting}
              isLoading={isSubmitting}
            >
              Save
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};

export default UpdateMeterReadingButton;
