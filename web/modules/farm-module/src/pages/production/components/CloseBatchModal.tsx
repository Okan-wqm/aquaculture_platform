/**
 * CloseBatchModal
 *
 * Two-step close workflow that respects the active-treatment
 * withdrawal gate added in phase 1.4. The first submit is optimistic
 * (no acknowledgement); if the backend rejects because the batch
 * still has one or more open medicine-withdrawal events, the modal
 * shows the blocking treatments and requires the operator to tick
 * the override checkbox before submitting again. That second submit
 * passes `acknowledgeActiveTreatments: true` so the backend writes
 * the override to the audit log.
 *
 * Phase 3 Tier 1 of the "Farm modülü kalan kör noktalar" plan.
 * Exercises the compliance gate from phase 1.4.
 */
import React, { useMemo, useState } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';

import {
  ActiveTreatmentInfo,
  BatchCloseReason,
  useCloseBatch,
} from '../../../hooks/useBatches';

interface CloseBatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  batchId: string;
  batchNumber: string;
  onSuccess?: () => void;
}

const REASON_OPTIONS: Array<{ value: BatchCloseReason; label: string }> = [
  { value: 'HARVEST_COMPLETED', label: 'Harvest completed' },
  { value: 'TOTAL_MORTALITY', label: 'Total mortality' },
  { value: 'DISEASE_OUTBREAK', label: 'Disease outbreak' },
  { value: 'COMMERCIAL_DECISION', label: 'Commercial decision' },
  { value: 'FAILED', label: 'Failed / abandoned' },
  { value: 'MERGED', label: 'Merged into another batch' },
  { value: 'OTHER', label: 'Other' },
];

interface WithdrawalBlock {
  treatments: ActiveTreatmentInfo[];
  message: string;
}

/**
 * Parse an error thrown by the closeBatch mutation into a structured
 * withdrawal-block payload when the backend indicates active
 * treatments. The backend's `BatchWithdrawalBlockedError` carries the
 * list in `extensions.activeTreatments`; if the graphql-request
 * client has stashed it somewhere else, fall back to the raw
 * message.
 */
function parseWithdrawalBlock(error: unknown): WithdrawalBlock | null {
  if (!error || typeof error !== 'object') return null;
  const maybe = error as {
    response?: {
      errors?: Array<{
        extensions?: {
          code?: string;
          activeTreatments?: ActiveTreatmentInfo[];
        };
        message?: string;
      }>;
    };
  };
  const first = maybe.response?.errors?.[0];
  if (first?.extensions?.code === 'BATCH_WITHDRAWAL_BLOCKED') {
    return {
      treatments: first.extensions.activeTreatments ?? [],
      message: first.message ?? 'Active withdrawal period prevents closing.',
    };
  }
  return null;
}

export const CloseBatchModal: React.FC<CloseBatchModalProps> = ({
  isOpen,
  onClose,
  batchId,
  batchNumber,
  onSuccess,
}) => {
  const [reason, setReason] = useState<BatchCloseReason>('HARVEST_COMPLETED');
  const [notes, setNotes] = useState<string>('');
  const [acknowledge, setAcknowledge] = useState<boolean>(false);
  const [blocker, setBlocker] = useState<WithdrawalBlock | null>(null);

  const closeBatch = useCloseBatch();
  const { toast } = useToast();

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (notes.trim().length > 2000) {
      errs.push('Notes cannot exceed 2000 characters.');
    }
    if (blocker && !acknowledge) {
      errs.push('Tick the override checkbox to close despite the active treatments.');
    }
    return errs;
  }, [notes, blocker, acknowledge]);

  const isValid = errors.length === 0;

  const resetForm = () => {
    setReason('HARVEST_COMPLETED');
    setNotes('');
    setAcknowledge(false);
    setBlocker(null);
  };

  const handleSubmit = async () => {
    if (!isValid) return;
    try {
      await closeBatch.mutateAsync({
        id: batchId,
        reason,
        notes: notes.trim() || undefined,
        acknowledgeActiveTreatments: blocker ? acknowledge : false,
      });
      toast({
        title: 'Batch closed',
        description: `Batch ${batchNumber} closed with reason ${reason}.`,
        variant: 'success',
      });
      resetForm();
      onSuccess?.();
      onClose();
    } catch (error) {
      const parsed = parseWithdrawalBlock(error);
      if (parsed) {
        setBlocker(parsed);
        setAcknowledge(false);
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Failed to close batch.';
      toast({ title: 'Error', description: message, variant: 'error' });
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Close Batch" size="md">
      <div className="space-y-6">
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-sm text-gray-500">Batch</p>
          <p className="font-medium text-gray-900">{batchNumber}</p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="close-reason" className="block text-sm font-medium text-gray-700">
              Close reason <span className="text-orange-500">*</span>
            </label>
            <select
              id="close-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as BatchCloseReason)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            >
              {REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="close-notes" className="block text-sm font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="close-notes"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
              placeholder="Contextual notes (written to the audit log)"
            />
          </div>
        </div>

        {blocker && (
          <div className="border border-red-300 bg-red-50 rounded-lg p-4 space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-red-900">
                Active medicine-withdrawal treatments block this close
              </h4>
              <p className="text-sm text-red-700 mt-1">{blocker.message}</p>
            </div>

            <ul className="space-y-2">
              {blocker.treatments.map((t) => (
                <li
                  key={t.eventCode}
                  className="text-sm text-red-800 bg-white border border-red-200 rounded p-2"
                >
                  <div className="font-mono text-xs text-red-500">{t.eventCode}</div>
                  <div className="font-medium">{t.productName}</div>
                  <div className="text-xs text-red-600">
                    Earliest harvest: {t.earliestHarvestDate} ({t.daysRemaining} day(s) left)
                  </div>
                </li>
              ))}
            </ul>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(e) => setAcknowledge(e.target.checked)}
                className="mt-0.5 rounded border-red-400 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm text-red-900">
                I acknowledge that closing this batch while a withdrawal period is
                still active breaches food-safety policy. Override will be written
                to the audit log with my user ID.
              </span>
            </label>
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
            disabled={!isValid || closeBatch.isPending}
            className={
              blocker && acknowledge
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-orange-600 hover:bg-orange-700'
            }
          >
            {closeBatch.isPending
              ? 'Closing…'
              : blocker && acknowledge
                ? 'Close with override'
                : 'Close batch'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default CloseBatchModal;
