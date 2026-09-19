/**
 * Receive Delivery Modal - Mark PO items as received
 */
import React, { useState } from 'react';
import { Modal, useToast, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
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

export const ReceiveDeliveryModal: React.FC<Props> = ({ isOpen, onClose, purchaseOrder }) => {
  const [storageLocationId, setStorageLocationId] = useState('');
  const [receivedItems, setReceivedItems] = useState<
    Record<string, { qty: number; lotNumber: string; expiryDate: string }>
  >({});

  const receiveDelivery = useReceiveDelivery();
  const { toast } = useToast();
  const { data: locations } = useStorageLocationList();

  if (!purchaseOrder) return null;

  const pendingItems = purchaseOrder.items.filter((i) => !i.isFullyReceived);

  const updateReceived = (itemId: string, field: string, value: any) => {
    setReceivedItems((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        qty: prev[itemId]?.qty ?? 0,
        lotNumber: prev[itemId]?.lotNumber ?? '',
        expiryDate: prev[itemId]?.expiryDate ?? '',
        [field]: value,
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storageLocationId) return;

    const itemsToReceive = pendingItems
      .filter((i) => (receivedItems[i.itemId]?.qty || 0) > 0)
      .map((i) => ({
        itemId: i.itemId,
        quantityReceived: receivedItems[i.itemId]?.qty || 0,
        lotNumber: receivedItems[i.itemId]?.lotNumber || undefined,
        expiryDate: receivedItems[i.itemId]?.expiryDate || undefined,
      }));

    if (itemsToReceive.length === 0) return;

    const input: ReceiveDeliveryInput = {
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

  type ItemRow = (typeof pendingItems)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'item',
      header: 'Item',
      render: (_value, item) => item.itemName,
    },
    {
      key: 'ordered',
      header: 'Ordered',
      render: (_value, item) => (
        <>
          {item.quantity} {item.unit}
        </>
      ),
    },
    {
      key: 'received',
      header: 'Received',
      render: (_value, item) => item.quantityReceived,
    },
    {
      key: 'receiveNow',
      header: 'Receive Now',
      render: (_value, item) => {
        const remaining = Number(item.quantity) - Number(item.quantityReceived);
        return (
          <input
            type="number"
            min="0"
            max={remaining}
            step="0.01"
            value={receivedItems[item.itemId]?.qty ?? ''}
            onChange={(e) => updateReceived(item.itemId, 'qty', parseFloat(e.target.value) || 0)}
            placeholder={String(remaining)}
            className="w-20 border border-gray-300 rounded px-2 py-1 text-sm"
          />
        );
      },
    },
    {
      key: 'lot',
      header: 'Lot #',
      render: (_value, item) => (
        <input
          type="text"
          value={receivedItems[item.itemId]?.lotNumber ?? ''}
          onChange={(e) => updateReceived(item.itemId, 'lotNumber', e.target.value)}
          placeholder="LOT-"
          className="w-24 border border-gray-300 rounded px-2 py-1 text-sm"
        />
      ),
    },
    {
      key: 'expiry',
      header: 'Expiry',
      render: (_value, item) => (
        <input
          type="date"
          value={receivedItems[item.itemId]?.expiryDate ?? ''}
          onChange={(e) => updateReceived(item.itemId, 'expiryDate', e.target.value)}
          className="w-32 border border-gray-300 rounded px-2 py-1 text-sm"
        />
      ),
    },
  ];

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
              onChange={(e) => setStorageLocationId(e.target.value)}
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
          <DataTable<ItemRow>
            data={pendingItems}
            columns={itemRowColumns}
            keyExtractor={(item) => item.id}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />

          {pendingItems.length === 0 && (
            <div className="text-center py-4 text-sm text-gray-500">
              All items have been received.
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
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
