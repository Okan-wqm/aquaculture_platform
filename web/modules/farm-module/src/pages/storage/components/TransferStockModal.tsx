/**
 * Transfer Stock Modal
 *
 * A focused modal for location-to-location stock transfers within the same
 * aquaculture facility. This is separate from the general RecordStockMovementModal
 * because transfers are the most common daily operation — warehouse staff move
 * feed from the main silo to pond-side dispensers, chemicals from the hazmat
 * store to the treatment area, etc.
 *
 * Key difference from RecordStockMovementModal:
 *  - Always creates a TRANSFER movement (no movement type selection)
 *  - Both from and to locations are always required
 *  - The "to" location dropdown excludes the selected "from" location to prevent
 *    accidentally transferring stock to the same location (a no-op that would
 *    corrupt inventory audit trail)
 *  - Lot number and reason are optional (transfers do not change stock ownership
 *    or regulatory status)
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useToast } from '@aquaculture/shared-ui';
import {
  useTransferStock,
  StorageItemType,
  TransferStockInput,
} from '../../../hooks/useStorageInventory';
import { useStorageLocationList } from '../../../hooks/useStorageLocations';
import { useFeedList } from '../../../hooks/useFeeds';
import { useChemicalList } from '../../../hooks/useChemicals';
import { useConsumableList } from '../../../hooks/useConsumables';

/** Item type metadata for the select dropdown */
const ITEM_TYPE_OPTIONS: { value: StorageItemType; label: string }[] = [
  { value: StorageItemType.FEED, label: 'Feed' },
  { value: StorageItemType.CHEMICAL, label: 'Chemical' },
  { value: StorageItemType.CONSUMABLE, label: 'Consumable' },
  { value: StorageItemType.HEALTHCARE, label: 'Healthcare' },
];

/** Represents a selectable item from the feed/chemical/consumable lists */
interface ItemOption {
  id: string;
  name: string;
  code: string;
  unit: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const TransferStockModal: React.FC<Props> = ({ isOpen, onClose }) => {
  // Form state
  const [itemType, setItemType] = useState<StorageItemType>(StorageItemType.FEED);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [reason, setReason] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hooks
  const transferStock = useTransferStock();
  const { toast } = useToast();
  const { data: locationsData } = useStorageLocationList({ isActive: true });
  const { data: feedsData } = useFeedList();
  const { data: chemicalsData } = useChemicalList();
  const { data: consumablesData } = useConsumableList();

  const locations = locationsData?.items ?? [];

  /**
   * Reset form state whenever modal opens to prevent stale data
   * from a previous transfer leaking into a new one.
   */
  useEffect(() => {
    if (isOpen) {
      setItemType(StorageItemType.FEED);
      setSelectedItemId('');
      setQuantity('');
      setFromLocationId('');
      setToLocationId('');
      setLotNumber('');
      setReason('');
      setSubmitError(null);
    }
  }, [isOpen]);

  /**
   * Dynamically populate item options based on the selected item type.
   * Same logic as RecordStockMovementModal — HEALTHCARE shares the chemicals list.
   */
  const itemOptions: ItemOption[] = useMemo(() => {
    switch (itemType) {
      case StorageItemType.FEED:
        return (feedsData?.items ?? []).map(f => ({
          id: f.id,
          name: f.name,
          code: f.code,
          unit: f.unit || 'kg',
        }));
      case StorageItemType.CHEMICAL:
      case StorageItemType.HEALTHCARE:
        return (chemicalsData?.items ?? []).map(c => ({
          id: c.id,
          name: c.name,
          code: c.code,
          unit: c.unit || 'L',
        }));
      case StorageItemType.CONSUMABLE:
        return (consumablesData?.items ?? []).map(c => ({
          id: c.id,
          name: c.name,
          code: c.code,
          unit: c.unit || 'pcs',
        }));
      default:
        return [];
    }
  }, [itemType, feedsData, chemicalsData, consumablesData]);

  /**
   * Filter "to" locations to exclude the currently selected "from" location.
   * This prevents the user from creating a same-location transfer which would
   * be a no-op but still appear in the audit trail, confusing auditors.
   */
  const toLocationOptions = useMemo(
    () => locations.filter(loc => loc.id !== fromLocationId),
    [locations, fromLocationId],
  );

  /** Validate all required fields to control submit button enabled state */
  const isFormValid = useMemo(() => {
    const parsedQty = parseFloat(quantity);
    if (!selectedItemId) return false;
    if (isNaN(parsedQty) || parsedQty < 0.01) return false;
    if (!fromLocationId) return false;
    if (!toLocationId) return false;
    return true;
  }, [selectedItemId, quantity, fromLocationId, toLocationId]);

  /**
   * Clear item selection when item type changes, because feed items are not
   * valid chemical items and vice versa.
   */
  const handleItemTypeChange = useCallback((newType: StorageItemType) => {
    setItemType(newType);
    setSelectedItemId('');
  }, []);

  /**
   * When the "from" location changes, clear "to" location if it matches
   * the newly selected "from" (prevents same-location transfers).
   */
  const handleFromLocationChange = useCallback(
    (newFromId: string) => {
      setFromLocationId(newFromId);
      if (toLocationId === newFromId) {
        setToLocationId('');
      }
    },
    [toLocationId],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;
    setSubmitError(null);

    const input: TransferStockInput = {
      itemType,
      itemId: selectedItemId,
      quantity: parseFloat(quantity),
      fromLocationId,
      toLocationId,
      lotNumber: lotNumber.trim() || undefined,
      reason: reason.trim() || undefined,
    };

    try {
      await transferStock.mutateAsync(input);
      toast({
        title: 'Success',
        description: 'Stock transfer completed successfully.',
        variant: 'success',
      });
      onClose();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      if (import.meta.env.DEV) console.error('Failed to transfer stock:', err);
      setSubmitError(errorMessage);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        {/* Backdrop — clicking outside the modal closes it without submitting */}
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={onClose} />
        <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <form onSubmit={handleSubmit}>
            <div className="px-6 pt-5 pb-4 space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Transfer Stock</h3>

              {/* Inline error banner — shown when the GraphQL mutation fails */}
              {submitError && (
                <div className="rounded-md bg-red-50 border border-red-200 p-3">
                  <p className="text-sm text-red-700">{submitError}</p>
                </div>
              )}

              {/* Item Type — determines which item list is loaded */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Item Type *</label>
                <div className="mt-1 grid grid-cols-4 gap-2">
                  {ITEM_TYPE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleItemTypeChange(opt.value)}
                      className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                        itemType === opt.value
                          ? 'bg-blue-50 border-blue-500 text-blue-700'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Item selection — populated from the appropriate list hook */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Item *</label>
                <select
                  value={selectedItemId}
                  onChange={e => setSelectedItemId(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  <option value="">Select item...</option>
                  {itemOptions.map(opt => (
                    <option key={opt.id} value={opt.id}>
                      {opt.name} {opt.code ? `(${opt.code})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Quantity — minimum 0.01 enforced client-side */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Quantity *</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                  placeholder="0.00"
                  className="mt-1 block w-full max-w-xs border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>

              {/* From Location — source of the stock being transferred */}
              <div>
                <label className="block text-sm font-medium text-gray-700">From Location *</label>
                <select
                  value={fromLocationId}
                  onChange={e => handleFromLocationChange(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  <option value="">Select source location...</option>
                  {locations.map(loc => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name} ({loc.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* To Location — destination; excludes the selected "from" location */}
              <div>
                <label className="block text-sm font-medium text-gray-700">To Location *</label>
                <select
                  value={toLocationId}
                  onChange={e => setToLocationId(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  <option value="">Select destination location...</option>
                  {toLocationOptions.map(loc => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name} ({loc.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* Lot Number — optional for transfers (traceability already established at receipt) */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Lot Number</label>
                <input
                  type="text"
                  value={lotNumber}
                  onChange={e => setLotNumber(e.target.value)}
                  placeholder="Optional"
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>

              {/* Reason — optional for transfers (e.g., "Moving to pond-side dispenser") */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Reason</label>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="Optional — e.g., Moving feed closer to pond area"
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
            </div>

            {/* Footer with cancel/submit actions */}
            <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!isFormValid || transferStock.isPending}
                className="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {transferStock.isPending ? 'Transferring...' : 'Transfer Stock'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default TransferStockModal;
