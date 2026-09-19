/**
 * TransferModal Component
 *
 * Modal for transferring cleaner fish between tanks.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button, useToast, Input, Textarea } from '@aquaculture/shared-ui';
import {
  useTransferCleanerFish,
  useTankCleanerFish,
  CleanerFishBatch,
} from '../../../hooks/useCleanerFish';
import type { TankOption } from '../types';

interface TransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: CleanerFishBatch | null;
  sourceTankId: string | null;
  tanks: TankOption[];
  onSuccess: () => void;
}

export const TransferModal: React.FC<TransferModalProps> = ({
  isOpen,
  onClose,
  batch,
  sourceTankId,
  tanks,
  onSuccess,
}) => {
  // Form state
  const [destinationTankId, setDestinationTankId] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(0);
  const [transferredAt, setTransferredAt] = useState<string>(
    new Date().toISOString().split('T')[0],
  );
  const [reason, setReason] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  // Mutation
  const transferCleanerFish = useTransferCleanerFish();
  const { toast } = useToast();

  // Get source tank cleaner fish info
  const { data: sourceTankInfo } = useTankCleanerFish(sourceTankId || '');

  // Get the batch detail in source tank
  const batchDetail = useMemo(() => {
    if (!sourceTankInfo || !batch) return null;
    return sourceTankInfo.details.find((d) => d.batchId === batch.id);
  }, [sourceTankInfo, batch]);

  // Get source tank name
  const sourceTank = useMemo(() => {
    return tanks.find((t) => t.id === sourceTankId);
  }, [tanks, sourceTankId]);

  // Available destination tanks (exclude source)
  const destinationTanks = useMemo(() => {
    return tanks.filter((t) => t.id !== sourceTankId);
  }, [tanks, sourceTankId]);

  // Reset form
  const resetForm = useCallback(() => {
    setDestinationTankId('');
    setQuantity(0);
    setTransferredAt(new Date().toISOString().split('T')[0]);
    setReason('');
    setNotes('');
  }, []);

  // Validation
  const maxQuantity = batchDetail?.quantity || 0;
  const isValid =
    batch &&
    sourceTankId &&
    destinationTankId &&
    quantity > 0 &&
    quantity <= maxQuantity &&
    transferredAt;

  // Handle submit
  const handleSubmit = async () => {
    if (!isValid || !batch || !sourceTankId) return;

    try {
      await transferCleanerFish.mutateAsync({
        cleanerBatchId: batch.id,
        sourceTankId,
        destinationTankId,
        quantity,
        transferredAt,
        reason: reason || undefined,
        notes: notes || undefined,
      });

      resetForm();
      onSuccess();
      onClose();
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to transfer cleaner fish:', error);
      toast({
        title: 'Error',
        description: 'Failed to transfer cleaner fish. Please try again.',
        variant: 'error',
      });
    }
  };

  // Handle close
  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Transfer Cleaner Fish" size="md">
      <div className="space-y-6">
        {/* Source Tank Info */}
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-gray-900 dark:text-gray-100">
                {sourceTank?.name || 'Unknown Tank'}
              </h4>
              <p className="text-sm text-gray-500 dark:text-gray-400">{sourceTank?.code}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500 dark:text-gray-400">Source Tank</p>
            </div>
          </div>
        </div>

        {/* Batch Info */}
        {batchDetail && (
          <div className="bg-info-50 dark:bg-info-900/20 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-info-900 dark:text-info-100">
                  {batchDetail.batchNumber}
                </h4>
                <p className="text-sm text-info-600 dark:text-info-400">
                  {batchDetail.speciesName}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-info-600 dark:text-info-400">Available in Tank</p>
                <p className="text-lg font-semibold text-info-900 dark:text-info-100">
                  {batchDetail.quantity.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Destination Tank */}
        <div>
          <label
            htmlFor="destinationTank"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Destination Tank <span className="text-error-500">*</span>
          </label>
          <select
            id="destinationTank"
            value={destinationTankId}
            onChange={(e) => setDestinationTankId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm"
          >
            <option value="">Select destination tank...</option>
            {destinationTanks.map((tank) => (
              <option key={tank.id} value={tank.id}>
                {tank.name} ({tank.code})
              </option>
            ))}
          </select>
        </div>

        {/* Quantity */}
        <div>
          <label
            htmlFor="quantity"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Quantity to Transfer <span className="text-error-500">*</span>
          </label>
          <Input
            fullWidth
            type="number"
            id="quantity"
            min="1"
            max={maxQuantity}
            value={quantity || ''}
            onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
            placeholder="Enter quantity"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Max: {maxQuantity.toLocaleString()}
          </p>
        </div>

        {/* Transfer Date */}
        <div>
          <label
            htmlFor="transferredAt"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Transfer Date
          </label>
          <Input
            fullWidth
            type="date"
            id="transferredAt"
            value={transferredAt}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setTransferredAt(e.target.value)}
          />
        </div>

        {/* Reason */}
        <div>
          <label
            htmlFor="reason"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Transfer Reason
          </label>
          <Input
            fullWidth
            type="text"
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Rebalancing, Production needs..."
          />
        </div>

        {/* Notes */}
        <div>
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Notes
          </label>
          <Textarea
            fullWidth
            id="notes"
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes..."
          />
        </div>

        {/* Validation Error */}
        {quantity > maxQuantity && (
          <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3">
            <p className="text-sm text-error-600 dark:text-error-400">
              Quantity exceeds available stock ({maxQuantity.toLocaleString()})
            </p>
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
            disabled={!isValid || transferCleanerFish.isPending}
          >
            {transferCleanerFish.isPending ? 'Transferring...' : 'Transfer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default TransferModal;
