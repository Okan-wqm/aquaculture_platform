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
import { Modal, Button, useToast, Select, Textarea } from '@aquaculture/shared-ui';

import { BatchStatus, useUpdateBatchStatus } from '../../../hooks/useBatches';

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
      const message = error instanceof Error ? error.message : 'Failed to update status.';
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
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Batch</p>
          <p className="font-medium text-gray-900 dark:text-gray-100">{batchNumber}</p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Current status</p>
          <p className="font-medium text-gray-900 dark:text-gray-100">{currentStatus}</p>
        </div>

        <div className="space-y-4">
          <Select
            id="target-status"
            label="Target status"
            required
            value={status}
            onChange={(e) => setStatus(e.target.value as BatchStatus)}
            options={STATUS_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.value === currentStatus ? `${opt.label} (current)` : opt.label,
              disabled: opt.value === currentStatus,
            }))}
          />

          <div>
            <label
              htmlFor="status-reason"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Reason (optional)
            </label>
            <Textarea
              fullWidth
              id="status-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the transition (written to the audit log)"
            />
          </div>
        </div>

        {errors.length > 0 && (
          <div className="bg-accent-50 dark:bg-accent-900/20 border border-accent-200 dark:border-accent-800 rounded-lg p-3">
            <ul className="list-disc list-inside text-sm text-accent-600 dark:text-accent-400 space-y-1">
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
            className="bg-accent-600 hover:bg-accent-700"
          >
            {updateStatus.isPending ? 'Updating…' : 'Update status'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default UpdateBatchStatusModal;
