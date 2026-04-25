/**
 * UpdateMeterReadingButton — Tier 3 #8 (Scope C PR-8)
 *
 * Per-row "Sayaç Güncelle" affordance for METER_BASED schedules on
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
      errs.push('Sayaç okuması zorunlu.');
    } else if (Number.isNaN(meterParsed)) {
      errs.push('Sayaç okuması geçerli bir sayı olmalı.');
    } else if (meterParsed < 0) {
      errs.push('Sayaç okuması negatif olamaz.');
    } else if (lastMeter != null && meterParsed < lastMeter) {
      errs.push(
        `Yeni okuma (${meterParsed}) son bakım okumasından (${lastMeter}) küçük olamaz.`,
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
        title: 'Sayaç güncellendi',
        description: `${schedule.scheduleCode} için sayaç ${meterParsed} olarak kaydedildi.`,
        variant: 'success',
      });
      setIsOpen(false);
    } catch (err) {
      toast({
        title: 'Sayaç güncellenemedi',
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
        title="Sayaç okumasını güncelle (METER_BASED)"
      >
        Sayaç Güncelle
      </button>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Sayaç Okumasını Güncelle"
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
                <>Mevcut: kayıtlı okuma yok</>
              )}
              {lastMeter != null && (
                <> · son bakım okuması: {lastMeter}</>
              )}
              {schedule.nextMaintenanceMeterReading != null && (
                <> · sonraki bakım: {schedule.nextMaintenanceMeterReading}</>
              )}
            </p>
          </div>

          <div>
            <label
              htmlFor="meter-reading-input"
              className="block text-sm font-medium text-gray-700"
            >
              Yeni Sayaç Okuması{' '}
              <span className="text-red-600">*</span>
            </label>
            <input
              id="meter-reading-input"
              type="number"
              step="0.01"
              min={lastMeter ?? 0}
              value={meterRaw}
              onChange={(e) => setMeterRaw(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              İptal
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!isFormValid || isSubmitting}
              isLoading={isSubmitting}
            >
              Kaydet
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};

export default UpdateMeterReadingButton;
