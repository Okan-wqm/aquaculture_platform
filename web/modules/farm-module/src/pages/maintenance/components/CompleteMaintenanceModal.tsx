/**
 * CompleteMaintenanceModal — Tier 2 #5 (Scope C PR-5)
 *
 * Closes the cycle of a maintenance schedule directly (without ceremony
 * through a WorkOrder). Useful when the maintenance was performed
 * off-system (paper inspection, walk-around check, ad-hoc service) and
 * the operator just needs the schedule's stats to reflect reality:
 * `lastExecutedDate`, `executionCount`, `nextDueDate` (recomputed),
 * `lastMaintenanceMeterReading` (for METER_BASED) and an audit note.
 *
 * Architectural rationale — distinct from WO completion
 * -----------------------------------------------------
 * The existing `useCompleteWorkOrder` mutation ALREADY calls
 * `schedule.markCompleted()` in a transaction
 * (apps/farm-service/src/maintenance/services/work-order.service.ts:586).
 * If a WO is in flight, the operator should close the WO via "Tamamla"
 * on WorkOrdersPage — that path closes both the WO row and the
 * underlying schedule cycle atomically.
 *
 * `completeMaintenance` (this modal's mutation) is the alternate path
 * for schedules WITHOUT an open WO. Calling both for the same cycle
 * would double-count `executionCount` and `metrics.totalExecutions`.
 *
 * Validation rules
 * ----------------
 *   - notes: optional, <= 2000 chars (UI gate; backend doesn't bound it)
 *   - meterReading (METER_BASED only):
 *       - required when METER_BASED
 *       - >= 0 (backend enforces too)
 *       - >= schedule.lastMaintenanceMeterReading (UI gate; the entity's
 *         markCompleted will accept any value, but a non-increasing
 *         reading indicates operator data-entry error and should be
 *         caught client-side rather than corrupting the schedule's
 *         meter history)
 *   - schedule.status === 'ACTIVE' (UI gate; closing a PAUSED/EXPIRED
 *     schedule would compete with the schedule lifecycle)
 *
 * The checklistTemplate is rendered read-only as a record-of-work
 * reminder. It's a TEMPLATE on the schedule, not state — there's
 * nowhere to persist per-cycle ticked state on the schedule itself
 * (per-cycle state lives on WorkOrders' checklist field).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Modal,
  formatErrorForToast,
  useToast,
} from '@aquaculture/shared-ui';

import {
  CompleteMaintenanceInput,
  MaintenanceSchedule,
  useCompleteMaintenance,
} from '../../../hooks/useMaintenance';

interface CompleteMaintenanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  schedule: MaintenanceSchedule;
  onSuccess?: () => void;
}

const NOTES_MAX = 2000;

const CompleteMaintenanceModal: React.FC<CompleteMaintenanceModalProps> = ({
  isOpen,
  onClose,
  schedule,
  onSuccess,
}) => {
  const { toast } = useToast();
  const completeMutation = useCompleteMaintenance();

  const isMeterBased = schedule.recurrenceRule.type === 'METER_BASED';
  const lastMeter = schedule.lastMaintenanceMeterReading ?? null;

  const [meterReadingRaw, setMeterReadingRaw] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      setMeterReadingRaw(
        schedule.currentMeterReading != null
          ? String(schedule.currentMeterReading)
          : '',
      );
      setNotes('');
    }
  }, [isOpen, schedule.id, schedule.currentMeterReading]);

  const meterReadingParsed: number | null = useMemo(() => {
    if (!isMeterBased) return null;
    const trimmed = meterReadingRaw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, [isMeterBased, meterReadingRaw]);

  const errors: string[] = useMemo(() => {
    const errs: string[] = [];

    if (schedule.status !== 'ACTIVE') {
      errs.push(
        `Sadece aktif planlar tamamlanabilir; bu plan "${schedule.status}" durumunda.`,
      );
    }

    if (isMeterBased) {
      if (meterReadingParsed === null) {
        errs.push('A meter reading is required for meter-based schedules.');
      } else if (Number.isNaN(meterReadingParsed)) {
        errs.push('The meter reading must be a valid number.');
      } else if (meterReadingParsed < 0) {
        errs.push('The meter reading cannot be negative.');
      } else if (lastMeter != null && meterReadingParsed < lastMeter) {
        errs.push(
          `The new meter reading (${meterReadingParsed}) cannot be lower than the last reading (${lastMeter}).`,
        );
      }
    }

    if (notes.length > NOTES_MAX) {
      errs.push(`Notlar en fazla ${NOTES_MAX} karakter olabilir (${notes.length}).`);
    }

    return errs;
  }, [schedule.status, isMeterBased, meterReadingParsed, lastMeter, notes.length]);

  const isFormValid = errors.length === 0;
  const isSubmitting = completeMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid || isSubmitting) return;

    const input: CompleteMaintenanceInput = {
      scheduleId: schedule.id,
      ...(isMeterBased && meterReadingParsed != null && !Number.isNaN(meterReadingParsed)
        ? { meterReading: meterReadingParsed }
        : {}),
      ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
    };

    try {
      const updated = await completeMutation.mutateAsync(input);
      toast({
        title: 'Maintenance completed',
        description: `Schedule ${schedule.scheduleCode} was closed (completion #${updated.executionCount}).`,
        variant: 'success',
      });
      onSuccess?.();
      onClose();
    } catch (err) {
      toast({
        title: 'Could not complete the maintenance',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  const checklistItems = schedule.checklistTemplate?.items ?? [];

  return (
    <Modal
      className="sd-f2"
      isOpen={isOpen}
      onClose={onClose}
      title="Complete Maintenance"
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">Plan</p>
          <p className="font-medium text-gray-900">
            {schedule.scheduleCode} — {schedule.name}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Completed {schedule.executionCount} time(s) so far
            {schedule.lastExecutedDate && (
              <>
                {' '}
                · son: {new Date(schedule.lastExecutedDate).toLocaleDateString('en-GB')}
              </>
            )}
          </p>
        </div>

        {checklistItems.length > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700">
              Kontrol Listesi (referans)
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              This list is the schedule template — completing this cycle alone
              does not persist checklist states. Use the work-order flow for
              detailed check tracking.
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {checklistItems.map((item, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-gray-700"
                >
                  <span className="mt-0.5 inline-block h-4 w-4 rounded border border-gray-300 bg-white" />
                  <span>
                    {item.description}
                    {item.isRequired && (
                      <span className="ml-1 text-xs text-red-600">
                        (zorunlu)
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {isMeterBased && (
          <div>
            <label
              htmlFor="complete-maint-meter"
              className="block text-sm font-medium text-gray-700"
            >
              Meter Reading{' '}
              <span className="text-red-600">*</span>
            </label>
            <input
              id="complete-maint-meter"
              type="number"
              step="0.01"
              min={lastMeter ?? 0}
              value={meterReadingRaw}
              onChange={(e) => setMeterReadingRaw(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              required
            />
            {lastMeter != null && (
              <p className="mt-1 text-xs text-gray-500">
                Last reading: {lastMeter}
              </p>
            )}
          </div>
        )}

        <div>
          <label
            htmlFor="complete-maint-notes"
            className="block text-sm font-medium text-gray-700"
          >
            Notlar
          </label>
          <textarea
            id="complete-maint-notes"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={NOTES_MAX}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            placeholder="(optional) work done, observations, issues"
          />
          <p className="mt-1 text-xs text-gray-500">
            {notes.length} / {NOTES_MAX}
          </p>
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
            onClick={onClose}
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
            Complete Maintenance
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default CompleteMaintenanceModal;
