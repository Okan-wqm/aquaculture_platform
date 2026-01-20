/**
 * TransferModal Component
 *
 * Modal for transferring cleaner fish between tanks.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { useTransferCleanerFish, useTankCleanerFish, CleanerFishBatch } from '../../../hooks/useCleanerFish';

interface Tank {
  id: string;
  code: string;
  name: string;
}

interface TransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: CleanerFishBatch | null;
  sourceTankId: string | null;
  tanks: Tank[];
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
  const [transferredAt, setTransferredAt] = useState<string>(new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  // Mutation
  const transferCleanerFish = useTransferCleanerFish();

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
      console.error('Failed to transfer cleaner fish:', error);
      alert(error instanceof Error ? error.message : 'Failed to transfer cleaner fish');
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
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-gray-900">
                {sourceTank?.name || 'Unknown Tank'}
              </h4>
              <p className="text-sm text-gray-500">{sourceTank?.code}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">Source Tank</p>
            </div>
          </div>
        </div>

        {/* Batch Info */}
        {batchDetail && (
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-blue-900">{batchDetail.batchNumber}</h4>
                <p className="text-sm text-blue-600">{batchDetail.speciesName}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-blue-600">Available in Tank</p>
                <p className="text-lg font-semibold text-blue-900">
                  {batchDetail.quantity.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Destination Tank */}
        <div>
          <label htmlFor="destinationTank" className="block text-sm font-medium text-gray-700">
            Destination Tank <span className="text-red-500">*</span>
          </label>
          <select
            id="destinationTank"
            value={destinationTankId}
            onChange={(e) => setDestinationTankId(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
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
          <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
            Quantity to Transfer <span className="text-red-500">*</span>
          </label>
          <input
            type="number"
            id="quantity"
            min="1"
            max={maxQuantity}
            value={quantity || ''}
            onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="Enter quantity"
          />
          <p className="mt-1 text-xs text-gray-500">
            Max: {maxQuantity.toLocaleString()}
          </p>
        </div>

        {/* Transfer Date */}
        <div>
          <label htmlFor="transferredAt" className="block text-sm font-medium text-gray-700">
            Transfer Date
          </label>
          <input
            type="date"
            id="transferredAt"
            value={transferredAt}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setTransferredAt(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          />
        </div>

        {/* Reason */}
        <div>
          <label htmlFor="reason" className="block text-sm font-medium text-gray-700">
            Transfer Reason
          </label>
          <input
            type="text"
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="e.g., Rebalancing, Production needs..."
          />
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
            Notes
          </label>
          <textarea
            id="notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            placeholder="Optional notes..."
          />
        </div>

        {/* Validation Error */}
        {quantity > maxQuantity && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-600">
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
