/**
 * UpdateBatchStatusModal
 *
 * Surfaces the `updateBatchStatus` mutation so operators can walk a
 * batch through its lifecycle states (QUARANTINE → ACTIVE → GROWING
 * → PRE_HARVEST → HARVESTING → HARVESTED → CLOSED, with FAILED /
 * TRANSFERRED side transitions). The backend state machine validates
 * the transition is allowed — e.g. you cannot jump from QUARANTINE
 * straight to HARVESTING. A rejection bubbles up as a GraphQL error
 * and is shown via toast.
 *
 * Phase 3 Tier 1 of the "Farm modülü kalan kör noktalar" plan.
 */
import React, { useMemo, useState } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';

import {
  BatchStatus,
  useUpdateBatchStatus,
} from '../../../hooks/useBatches';

interface UpdateBatchStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  batchId: string;
  batchNumber: string;
  currentStatus: BatchStatus;
  onSuccess?: () => void;
}

const STATUS_OPTIONS: Array<{ value: BatchStatus; label: string }> = [
  { value: 'QUARANTINE', label: 'Quarantine' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'GROWING', label: 'Growing' },
  { value: 'PRE_HARVEST', label: 'Pre-harvest' },
  { value: 'HARVESTING', label: 'Harvesting' },
  { value: 'HARVESTED', label: 'Harvested' },
  { value: 'TRANSFERRED', label: 'Transferred' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CLOSED', label: 'Closed' },
];

export const UpdateBatchStatusModal: React.FC<UpdateBatchStatusModalProps> = ({
  isOpen,
  onClose,
  batchId,
  batchNumber,
  currentStatus,
  onSuccess,
}) => {
  const [status, setStatus] = useState<BatchStatus>(currentStatus);
  const [reason, setReason] = useState<string>('');

  const updateStatus = useUpdateBatchStatus();
  const { toast } = useToast();

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (status === currentStatus) {
      errs.push('Target status must differ from the current status.');
    }
    if (reason.trim().length > 0 && reason.trim().length < 5) {
      errs.push('Reason must be at least 5 characters (or left blank).');
    }
    return errs;
  }, [status, currentStatus, reason]);

  const isValid = errors.length === 0;

  const handleSubmit = async () => {
    if (!isValid) return;
    try {
      await updateStatus.mutateAsync({
        id: batchId,
        status,
        reason: reason.trim() || undefined,
      });
      toast({
        title: 'Status updated',
        description: `Batch ${batchNumber} moved to ${status}.`,
        variant: 'success',
      });
      onSuccess?.();
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to update status.';
      toast({ title: 'Error', description: message, variant: 'error' });
    }
  };

  const handleClose = () => {
    setStatus(currentStatus);
    setReason('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Update Batch Status" size="md">
      <div className="space-y-6">
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-sm text-gray-500">Batch</p>
          <p className="font-medium text-gray-900">{batchNumber}</p>
          <p className="mt-2 text-sm text-gray-500">Current status</p>
          <p className="font-medium text-gray-900">{currentStatus}</p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="target-status"
              className="block text-sm font-medium text-gray-700"
            >
              Target status <span className="text-orange-500">*</span>
            </label>
            <select
              id="target-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as BatchStatus)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.value === currentStatus}
                >
                  {opt.label}
                  {opt.value === currentStatus ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="status-reason"
              className="block text-sm font-medium text-gray-700"
            >
              Reason (optional)
            </label>
            <textarea
              id="status-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm"
              placeholder="Explain the transition (written to the audit log)"
            />
          </div>
        </div>

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
            disabled={!isValid || updateStatus.isPending}
            className="bg-orange-600 hover:bg-orange-700"
          >
            {updateStatus.isPending ? 'Updating…' : 'Update status'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default UpdateBatchStatusModal;
