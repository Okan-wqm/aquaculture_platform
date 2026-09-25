/**
 * Create Purchase Order Modal
 */
import React, { useState } from 'react';
import {
  Button,
  DataTable,
  DEFAULT_CURRENCY,
  formatCurrency,
  Input,
  Modal,
  Select,
  Textarea,
  ToggleButton,
  useToast,
  type DataTableColumn,
} from '@aquaculture/shared-ui';
import {
  useCreatePurchaseOrder,
  PurchaseOrderCategory,
  CreatePurchaseOrderInput,
} from '../../../hooks/usePurchaseOrders';
import { useFeedList } from '../../../hooks/useFeeds';
import { useChemicalList } from '../../../hooks/useChemicals';
import { useConsumableList } from '../../../hooks/useConsumables';
import { X } from 'lucide-react';

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

  type ItemRow = (typeof items)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'item',
      header: 'Item',
      render: (_value, item) => item.itemName,
    },
    {
      key: 'qty',
      header: 'Qty',
      render: (_value, item) => (
        <Input
          type="number"
          min="0.01"
          step="0.01"
          value={item.quantity}
          onChange={(e) => updateItem(item.itemId, 'quantity', parseFloat(e.target.value) || 0)}
        />
      ),
    },
    {
      key: 'unit',
      header: 'Unit',
      render: (_value, item) => item.unit,
    },
    {
      key: 'price',
      header: 'Price',
      render: (_value, item) => (
        <Input
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
        />
      ),
    },
    {
      key: 'total',
      header: 'Total',
      render: (_value, item) => (
        <>
          {item.unitPrice ? formatCurrency(item.unitPrice * item.quantity, DEFAULT_CURRENCY) : '-'}
        </>
      ),
    },
    {
      key: 'col',
      header: '',
      render: (_value, item) => (
        <>
          <Button variant="ghost" type="button" onClick={() => removeItem(item.itemId)}>
            <X className="w-4 h-4" aria-hidden="true" />
          </Button>
        </>
      ),
    },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Purchase Order" size="lg">
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Category *
            </label>
            <div className="mt-1 grid grid-cols-2 lg:grid-cols-4 gap-2">
              {CATEGORIES.map((cat) => (
                <ToggleButton
                  key={cat.value}
                  type="button"
                  onClick={() => {
                    setCategory(cat.value);
                    setItems([]);
                  }}
                  pressed={category === cat.value}
                  className="px-3 py-2 text-sm rounded-lg border transition-colors"
                  pressedClassName="bg-info-50 dark:bg-info-900/20 border-info-500 text-info-700 dark:text-info-300"
                  idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {cat.label}
                </ToggleButton>
              ))}
            </div>
          </div>

          {/* Supplier */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Supplier Name"
              fullWidth
              type="text"
              required
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
            />
            <Input
              label="Contact"
              fullWidth
              type="text"
              value={supplierContact}
              onChange={(e) => setSupplierContact(e.target.value)}
            />
          </div>

          {/* Expected Delivery */}
          <Input
            label="Expected Delivery Date"
            fullWidth
            type="date"
            value={expectedDeliveryDate}
            onChange={(e) => setExpectedDeliveryDate(e.target.value)}
          />

          {/* Add Items */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Items *
            </label>
            <div className="flex gap-2">
              <Select
                aria-label="Item to add"
                className="flex-1"
                value={selectedItemId}
                onChange={(e) => setSelectedItemId(e.target.value)}
                options={[
                  { value: '', label: 'Select item to add...' },
                  ...itemOptions
                    .filter((o) => !items.some((i) => i.itemId === o.id))
                    .map((opt) => ({
                      value: opt.id,
                      label: `${opt.name} ${opt.code ? `(${opt.code})` : ''}`,
                    })),
                ]}
              />
              <Button variant="primary" type="button" onClick={addItem} disabled={!selectedItemId}>
                Add
              </Button>
            </div>
          </div>

          {/* Items Table */}
          {items.length > 0 && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <DataTable<ItemRow>
                data={items}
                columns={itemRowColumns}
                keyExtractor={(item) => item.itemId}
                emptyMessage="No records found"
                searchable={false}
                sortable={false}
                stickyHeader={false}
              />
              {totalAmount > 0 && (
                <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                  Total: {formatCurrency(totalAmount, DEFAULT_CURRENCY)}
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <Textarea
            label="Notes"
            fullWidth
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!supplierName || items.length === 0 || createPO.isPending}
          >
            {createPO.isPending ? 'Creating...' : 'Create PO'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default CreatePurchaseOrderModal;
