/**
 * Receive Delivery Modal - Mark PO items as received
 */
import React, { useRef, useState } from 'react';
import { Modal, useToast } from '@aquaculture/shared-ui';
import {
  useReceiveDelivery,
  PurchaseOrder,
  ReceiveDeliveryInput,
} from '../../../hooks/usePurchaseOrders';
import { useStorageLocationList } from '../../../hooks/useStorageLocations';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  purchaseOrder: PurchaseOrder | null;
}

interface ReceiptItemDraft {
  qty: number;
  lotNumber: string;
  expiryDate: string;
}

export const ReceiveDeliveryModal: React.FC<Props> = ({ isOpen, onClose, purchaseOrder }) => {
  const [storageLocationId, setStorageLocationId] = useState('');
  const [receivedItems, setReceivedItems] = useState<Record<string, ReceiptItemDraft>>({});
  // Retained across a transport failure so a retry cannot double-receive.
  // Any payload edit starts a new logical operation identity.
  const receiptOperationId = useRef<string | null>(null);

  const receiveDelivery = useReceiveDelivery();
  const { toast } = useToast();
  const { data: locations } = useStorageLocationList();

  if (!purchaseOrder) return null;

  const pendingItems = purchaseOrder.items.filter((i) => !i.isFullyReceived);

  const updateReceived = (purchaseOrderItemId: string, update: Partial<ReceiptItemDraft>) => {
    receiptOperationId.current = null;
    setReceivedItems((prev) => ({
      ...prev,
      [purchaseOrderItemId]: {
        ...prev[purchaseOrderItemId],
        qty: prev[purchaseOrderItemId]?.qty ?? 0,
        lotNumber: prev[purchaseOrderItemId]?.lotNumber ?? '',
        expiryDate: prev[purchaseOrderItemId]?.expiryDate ?? '',
        ...update,
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storageLocationId) return;

    const itemsToReceive = pendingItems
      .filter((i) => (receivedItems[i.id]?.qty || 0) > 0)
      .map((i) => ({
        purchaseOrderItemId: i.id,
        quantityReceived: receivedItems[i.id]?.qty || 0,
        lotNumber: receivedItems[i.id]?.lotNumber || undefined,
        expiryDate: receivedItems[i.id]?.expiryDate || undefined,
      }));

    if (itemsToReceive.length === 0) return;

    const operationId = receiptOperationId.current ?? crypto.randomUUID();
    receiptOperationId.current = operationId;
    const input: ReceiveDeliveryInput = {
      operationId,
      purchaseOrderId: purchaseOrder.id,
      storageLocationId,
      items: itemsToReceive,
    };

    try {
      await receiveDelivery.mutateAsync(input);
      toast({
        title: 'Success',
        description: 'Delivery received successfully.',
        variant: 'success',
      });
      receiptOperationId.current = null;
      onClose();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to receive delivery:', err);
      toast({
        title: 'Error',
        description: 'Failed to receive delivery. Please try again.',
        variant: 'error',
      });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Receive Delivery - ${purchaseOrder.orderNumber}`}
      description={`Supplier: ${purchaseOrder.supplierName}`}
      size="lg"
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Storage Location */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Storage Location *</label>
            <select
              value={storageLocationId}
              onChange={(e) => {
                receiptOperationId.current = null;
                setStorageLocationId(e.target.value);
              }}
              required
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">Select location...</option>
              {(locations?.items || []).map((loc: any) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name} ({loc.code})
                </option>
              ))}
            </select>
          </div>

          {/* Items */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Item
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Ordered
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Received
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Receive Now
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Lot #
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Expiry
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {pendingItems.map((item) => {
                  const remaining = Number(item.quantity) - Number(item.quantityReceived);
                  return (
                    <tr key={item.id}>
                      <td className="px-4 py-2 text-sm font-medium">{item.itemName}</td>
                      <td className="px-4 py-2 text-sm text-gray-500">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-500">{item.quantityReceived}</td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min="0"
                          max={remaining}
                          step="0.01"
                          value={receivedItems[item.id]?.qty ?? ''}
                          onChange={(e) =>
                            updateReceived(item.id, { qty: parseFloat(e.target.value) || 0 })
                          }
                          placeholder={String(remaining)}
                          className="w-20 border border-gray-300 rounded px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          value={receivedItems[item.id]?.lotNumber ?? ''}
                          onChange={(e) => updateReceived(item.id, { lotNumber: e.target.value })}
                          placeholder="LOT-"
                          className="w-24 border border-gray-300 rounded px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="date"
                          value={receivedItems[item.id]?.expiryDate ?? ''}
                          onChange={(e) => updateReceived(item.id, { expiryDate: e.target.value })}
                          className="w-32 border border-gray-300 rounded px-2 py-1 text-sm"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pendingItems.length === 0 && (
            <div className="text-center py-4 text-sm text-gray-500">
              All items have been received.
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              receiptOperationId.current = null;
              onClose();
            }}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!storageLocationId || pendingItems.length === 0 || receiveDelivery.isPending}
            className="px-4 py-2 bg-green-600 text-white rounded-md text-sm hover:bg-green-700 disabled:opacity-50"
          >
            {receiveDelivery.isPending ? 'Receiving...' : 'Confirm Receipt'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default ReceiveDeliveryModal;
