/**
 * ReleaseQuarantineModal (FARM-MEDIUM-402)
 *
 * Confirmation step for `releaseBatchFromQuarantine`: a quarantined batch
 * cannot be harvested, so ending the hold is a deliberate, audited manager
 * decision. The operator must give a reason (5-500 characters, the backend
 * DTO bounds); it is written to the batch status and the audit log.
 */
import React, { useState } from 'react';
import { Button, Modal, Textarea, useI18n } from '@aquaculture/shared-ui';

import { useReleaseBatchFromQuarantine } from '../../../hooks/useBatches';

interface ReleaseQuarantineModalProps {
  isOpen: boolean;
  onClose: () => void;
  batchId: string;
  batchNumber: string;
}

const MIN_REASON = 5;
const MAX_REASON = 500;

export const ReleaseQuarantineModal: React.FC<ReleaseQuarantineModalProps> = ({
  isOpen,
  onClose,
  batchId,
  batchNumber,
}) => {
  const { t } = useI18n();
  const release = useReleaseBatchFromQuarantine();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= MIN_REASON;
  const showReasonHint = trimmed.length !== 0 && !reasonValid;

  const handleClose = (): void => {
    setReason('');
    onClose();
  };

  const handleConfirm = (): void => {
    if (!reasonValid) return;
    // Success / failure toasts come from the hook; the modal stays open on failure.
    release.mutate({ batchId, reason: trimmed }, { onSuccess: handleClose });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('batch.quarantineRelease.title')}
      size="md"
    >
      <div className="space-y-4">
        <p className="font-medium text-gray-900 dark:text-gray-100">{batchNumber}</p>
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {t('batch.quarantineRelease.body')}
        </p>
        <div>
          <label
            htmlFor="quarantine-release-reason"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('batch.quarantineRelease.reason')}
          </label>
          <Textarea
            fullWidth
            id="quarantine-release-reason"
            rows={3}
            required
            maxLength={MAX_REASON}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('batch.quarantineRelease.reasonPlaceholder')}
          />
          {showReasonHint && (
            <p className="mt-1 text-xs text-error-600 dark:text-error-400">
              {t('batch.quarantineRelease.reasonTooShort')}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="secondary" onClick={handleClose}>
            {t('batch.quarantineRelease.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!reasonValid || release.isPending}
          >
            {t('batch.quarantineRelease.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default ReleaseQuarantineModal;
