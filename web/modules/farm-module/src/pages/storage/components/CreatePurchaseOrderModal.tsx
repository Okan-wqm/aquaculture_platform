/**
 * Create Purchase Order Modal
 */
import React, { useState } from 'react';
import { Modal, useToast, formatCurrency, DEFAULT_CURRENCY } from '@aquaculture/shared-ui';
import {
  useCreatePurchaseOrder,
  PurchaseOrderCategory,
  CreatePurchaseOrderInput,
} from '../../../hooks/usePurchaseOrders';
import { useFeedList } from '../../../hooks/useFeeds';
import { useChemicalList } from '../../../hooks/useChemicals';
import { useConsumableList } from '../../../hooks/useConsumables';

const CATEGORIES: { value: PurchaseOrderCategory; label: string }[] = [
  { value: PurchaseOrderCategory.FEED, label: 'Feed' },
  { value: PurchaseOrderCategory.CHEMICAL, label: 'Chemical' },
  { value: PurchaseOrderCategory.CONSUMABLE, label: 'Consumable' },
  { value: PurchaseOrderCategory.HEALTHCARE, label: 'Healthcare' },
];

interface LineItem {
  itemId: string;
  itemName: string;
  itemCode?: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const CreatePurchaseOrderModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [category, setCategory] = useState<PurchaseOrderCategory>(PurchaseOrderCategory.FEED);
  const [supplierName, setSupplierName] = useState('');
  const [supplierContact, setSupplierContact] = useState('');
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LineItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');

  const createPO = useCreatePurchaseOrder();
  const { toast } = useToast();
  const { data: feedsData } = useFeedList();
  const { data: chemicalsData } = useChemicalList();
  const { data: consumablesData } = useConsumableList();

  const getItemOptions = () => {
    switch (category) {
      case PurchaseOrderCategory.FEED:
        return (feedsData?.items || []).map((f) => ({
          id: f.id,
          name: f.name,
          code: f.code,
          unit: f.unit || 'kg',
        }));
      case PurchaseOrderCategory.CHEMICAL:
      case PurchaseOrderCategory.HEALTHCARE:
        return (chemicalsData?.items || []).map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          unit: c.unit || 'L',
        }));
      case PurchaseOrderCategory.CONSUMABLE:
        return (consumablesData?.items || []).map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          unit: c.unit || 'pcs',
        }));
      default:
        return [];
    }
  };

  const itemOptions = getItemOptions();

  const addItem = () => {
    const option = itemOptions.find((o) => o.id === selectedItemId);
    if (!option) return;
    if (items.some((i) => i.itemId === option.id)) return;
    setItems([
      ...items,
      {
        itemId: option.id,
        itemName: option.name,
        itemCode: option.code,
        quantity: 1,
        unit: option.unit,
        unitPrice: undefined,
      },
    ]);
    setSelectedItemId('');
  };

  const removeItem = (itemId: string) => {
    setItems(items.filter((i) => i.itemId !== itemId));
  };

  const updateItem = (
    itemId: string,
    field: keyof LineItem,
    value: string | number | undefined,
  ) => {
    setItems(items.map((i) => (i.itemId === itemId ? { ...i, [field]: value } : i)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supplierName || items.length === 0) return;

    const input: CreatePurchaseOrderInput = {
      category,
      supplierName,
      supplierContact: supplierContact || undefined,
      expectedDeliveryDate: expectedDeliveryDate || undefined,
      notes: notes || undefined,
      items: items.map((i) => ({
        itemId: i.itemId,
        itemName: i.itemName,
        itemCode: i.itemCode,
        quantity: i.quantity,
        unit: i.unit,
        unitPrice: i.unitPrice,
      })),
    };

    try {
      await createPO.mutateAsync(input);
      toast({
        title: 'Success',
        description: 'Purchase order created successfully.',
        variant: 'success',
      });
      onClose();
      resetForm();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to create PO:', err);
      toast({
        title: 'Error',
        description: 'Failed to create purchase order. Please try again.',
        variant: 'error',
      });
    }
  };

  const resetForm = () => {
    setCategory(PurchaseOrderCategory.FEED);
    setSupplierName('');
    setSupplierContact('');
    setExpectedDeliveryDate('');
    setNotes('');
    setItems([]);
    setSelectedItemId('');
  };

  const totalAmount = items.reduce(
    (sum, i) => sum + (i.unitPrice ? i.unitPrice * i.quantity : 0),
    0,
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Purchase Order" size="lg">
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Category *</label>
            <div className="mt-1 grid grid-cols-4 gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => {
                    setCategory(cat.value);
                    setItems([]);
                  }}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    category === cat.value
                      ? 'bg-blue-50 border-blue-500 text-blue-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Supplier */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Supplier Name *</label>
              <input
                type="text"
                required
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Contact</label>
              <input
                type="text"
                value={supplierContact}
                onChange={(e) => setSupplierContact(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>

          {/* Expected Delivery */}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Expected Delivery Date
            </label>
            <input
              type="date"
              value={expectedDeliveryDate}
              onChange={(e) => setExpectedDeliveryDate(e.target.value)}
              className="mt-1 block w-full max-w-xs border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>

          {/* Add Items */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Items *</label>
            <div className="flex gap-2">
              <select
                value={selectedItemId}
                onChange={(e) => setSelectedItemId(e.target.value)}
                className="flex-1 border border-gray-300 rounded-md py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select item to add...</option>
                {itemOptions
                  .filter((o) => !items.some((i) => i.itemId === o.id))
                  .map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.name} {opt.code ? `(${opt.code})` : ''}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={addItem}
                disabled={!selectedItemId}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </div>

          {/* Items Table */}
          {items.length > 0 && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Item
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Qty
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Unit
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Price
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Total
                    </th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {items.map((item) => (
                    <tr key={item.itemId}>
                      <td className="px-4 py-2 text-sm">{item.itemName}</td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={item.quantity}
                          onChange={(e) =>
                            updateItem(item.itemId, 'quantity', parseFloat(e.target.value) || 0)
                          }
                          className="w-20 border border-gray-300 rounded px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-500">{item.unit}</td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.unitPrice ?? ''}
                          onChange={(e) =>
                            updateItem(
                              item.itemId,
                              'unitPrice',
                              e.target.value ? parseFloat(e.target.value) : undefined,
                            )
                          }
                          placeholder="0.00"
                          className="w-24 border border-gray-300 rounded px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-4 py-2 text-sm font-medium">
                        {item.unitPrice
                          ? formatCurrency(item.unitPrice * item.quantity, DEFAULT_CURRENCY)
                          : '-'}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => removeItem(item.itemId)}
                          className="text-red-500 hover:text-red-700"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totalAmount > 0 && (
                <div className="bg-gray-50 px-4 py-2 text-right text-sm font-medium text-gray-900">
                  Total: {formatCurrency(totalAmount, DEFAULT_CURRENCY)}
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
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
            disabled={!supplierName || items.length === 0 || createPO.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {createPO.isPending ? 'Creating...' : 'Create PO'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default CreatePurchaseOrderModal;
