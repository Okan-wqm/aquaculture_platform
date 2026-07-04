/**
 * Record Stock Movement Modal
 *
 * This is the primary data-entry modal for all manual stock operations in the
 * aquaculture storage system. Warehouse staff use it to record:
 *  - IN: goods receipt from suppliers (feed delivery, chemical restocking)
 *  - OUT: dispensing to production (feed to ponds, chemicals for treatment)
 *  - WASTE: disposal of expired/damaged stock (regulatory write-off)
 *  - ADJUSTMENT: inventory count corrections (audit reconciliation)
 *  - RETURN: returning unused stock to suppliers
 *
 * Business rules enforced:
 *  - Lot number is mandatory for FEED and CHEMICAL items per EU Regulation 178/2002
 *    (full traceability from farm to fork).
 *  - Expiry date is mandatory for FEED and HEALTHCARE items per HACCP food safety
 *    requirements (prevents feeding expired feed to fish stock).
 *  - Reason field is mandatory for WASTE and ADJUSTMENT movements to satisfy
 *    internal audit trail and ISO 22000 non-conformance documentation.
 *  - An idempotency key is generated on mount (not on submit) so that network
 *    retries do not create duplicate movements — critical for accurate inventory.
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Modal, useToast } from '@aquaculture/shared-ui';
import {
  useRecordStockMovement,
  StorageItemType,
  MovementType,
  RecordStockMovementInput,
} from '../../../hooks/useStorageInventory';
import { useStorageLocationList } from '../../../hooks/useStorageLocations';
import { useFeedList } from '../../../hooks/useFeeds';
import { useChemicalList } from '../../../hooks/useChemicals';
import { useConsumableList } from '../../../hooks/useConsumables';

/** Movement type metadata for the select dropdown */
const MOVEMENT_TYPE_OPTIONS: { value: MovementType; label: string; description: string }[] = [
  { value: MovementType.IN, label: 'Stock In', description: 'Goods receipt from supplier' },
  { value: MovementType.OUT, label: 'Stock Out', description: 'Dispensed to production' },
  {
    value: MovementType.WASTE,
    label: 'Waste / Write-Off',
    description: 'Expired or damaged disposal',
  },
  {
    value: MovementType.ADJUSTMENT,
    label: 'Adjustment',
    description: 'Inventory count correction',
  },
  { value: MovementType.RETURN, label: 'Return', description: 'Return to supplier' },
];

/** Item type metadata for the select dropdown */
const ITEM_TYPE_OPTIONS: { value: StorageItemType; label: string }[] = [
  { value: StorageItemType.FEED, label: 'Feed' },
  { value: StorageItemType.CHEMICAL, label: 'Chemical' },
  { value: StorageItemType.CONSUMABLE, label: 'Consumable' },
  { value: StorageItemType.HEALTHCARE, label: 'Healthcare' },
];

/**
 * Movement types that require a "from" location — stock leaves a known location.
 * OUT: dispensing from a storage location to production.
 * WASTE: disposing stock from a specific location.
 * ADJUSTMENT: correcting a specific location's balance.
 */
const NEEDS_FROM_LOCATION = new Set<MovementType>([
  MovementType.OUT,
  MovementType.WASTE,
  MovementType.ADJUSTMENT,
]);

/**
 * Movement types that require a "to" location — stock enters a known location.
 * IN: receiving goods into a storage location.
 * RETURN: returning stock to a supplier-side or quarantine location.
 * ADJUSTMENT: correcting a specific location's balance (both from and to).
 */
const NEEDS_TO_LOCATION = new Set<MovementType>([
  MovementType.IN,
  MovementType.RETURN,
  MovementType.ADJUSTMENT,
]);

/**
 * Item types that require a lot number per EU Regulation 178/2002.
 * Feed and chemicals must be fully traceable in the food production chain.
 */
const LOT_NUMBER_REQUIRED_TYPES = new Set<StorageItemType>([
  StorageItemType.FEED,
  StorageItemType.CHEMICAL,
]);

/**
 * Item types that require an expiry date per HACCP food safety standards.
 * Feed expiry affects fish health; healthcare products lose efficacy past expiry.
 */
const EXPIRY_DATE_REQUIRED_TYPES = new Set<StorageItemType>([
  StorageItemType.FEED,
  StorageItemType.HEALTHCARE,
]);

/**
 * Movement types that require a reason for audit trail purposes.
 * Waste and adjustments must be documented per ISO 22000 non-conformance procedures.
 */
const REASON_REQUIRED_TYPES = new Set<MovementType>([MovementType.WASTE, MovementType.ADJUSTMENT]);

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
  /** Pre-fill from stock tab context (e.g., user clicked "Add Stock" on the Feed tab) */
  defaultItemType?: StorageItemType;
  /** Pre-fill movement type (e.g., IN for Add Stock, WASTE for Write Off) */
  defaultMovementType?: MovementType;
  /** Pre-fill from row action (e.g., user clicked action button on a specific item row) */
  defaultItemId?: string;
  /** Display name for the pre-filled item so user sees context immediately */
  defaultItemName?: string;
}

export const RecordStockMovementModal: React.FC<Props> = ({
  isOpen,
  onClose,
  defaultItemType,
  defaultMovementType,
  defaultItemId,
  defaultItemName,
}) => {
  /**
   * Idempotency key is generated once per modal open (not per submit).
   * This prevents duplicate movements when the user retries a failed network request
   * — the backend will reject a second mutation with the same idempotency key.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  // Form state
  const [movementType, setMovementType] = useState<MovementType>(
    defaultMovementType ?? MovementType.IN,
  );
  const [itemType, setItemType] = useState<StorageItemType>(
    defaultItemType ?? StorageItemType.FEED,
  );
  const [selectedItemId, setSelectedItemId] = useState(defaultItemId ?? '');
  const [quantity, setQuantity] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hooks
  const recordMovement = useRecordStockMovement();
  const { toast } = useToast();
  const { data: locationsData } = useStorageLocationList({ isActive: true });
  const { data: feedsData } = useFeedList();
  const { data: chemicalsData } = useChemicalList();
  const { data: consumablesData } = useConsumableList();

  const locations = locationsData?.items ?? [];

  /**
   * Regenerate idempotency key each time the modal opens.
   * This ensures each new modal session gets a fresh key while retries within
   * the same session reuse the same key (preventing duplicate movements).
   */
  useEffect(() => {
    if (isOpen) {
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [isOpen]);

  /**
   * Dynamically populate item options based on the selected item type.
   * HEALTHCARE items use the chemicals list because healthcare products
   * (antibiotics, vaccines, supplements) are stored alongside chemicals
   * in the aquaculture domain — they share regulatory storage requirements.
   */
  const itemOptions: ItemOption[] = useMemo(() => {
    switch (itemType) {
      case StorageItemType.FEED:
        return (feedsData?.items ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          code: f.code,
          unit: f.unit || 'kg',
        }));
      case StorageItemType.CHEMICAL:
      case StorageItemType.HEALTHCARE:
        return (chemicalsData?.items ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          unit: c.unit || 'L',
        }));
      case StorageItemType.CONSUMABLE:
        return (consumablesData?.items ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          unit: c.unit || 'pcs',
        }));
      default:
        return [];
    }
  }, [itemType, feedsData, chemicalsData, consumablesData]);

  /** Derived field visibility based on movement type */
  const showFromLocation = NEEDS_FROM_LOCATION.has(movementType);
  const showToLocation = NEEDS_TO_LOCATION.has(movementType);
  const isLotNumberRequired = LOT_NUMBER_REQUIRED_TYPES.has(itemType);
  const isExpiryDateRequired = EXPIRY_DATE_REQUIRED_TYPES.has(itemType);
  const isReasonRequired = REASON_REQUIRED_TYPES.has(movementType);

  /** Validate all required fields to control submit button enabled state */
  const isFormValid = useMemo(() => {
    const parsedQty = parseFloat(quantity);
    if (!selectedItemId) return false;
    if (isNaN(parsedQty) || parsedQty < 0.01) return false;
    if (showFromLocation && !fromLocationId) return false;
    if (showToLocation && !toLocationId) return false;
    if (isLotNumberRequired && !lotNumber.trim()) return false;
    if (isExpiryDateRequired && !expiryDate) return false;
    if (isReasonRequired && !reason.trim()) return false;
    return true;
  }, [
    selectedItemId,
    quantity,
    showFromLocation,
    fromLocationId,
    showToLocation,
    toLocationId,
    isLotNumberRequired,
    lotNumber,
    isExpiryDateRequired,
    expiryDate,
    isReasonRequired,
    reason,
  ]);

  /** Reset all form fields to defaults (called after successful submit) */
  const resetForm = useCallback(() => {
    setMovementType(defaultMovementType ?? MovementType.IN);
    setItemType(defaultItemType ?? StorageItemType.FEED);
    setSelectedItemId(defaultItemId ?? '');
    setQuantity('');
    setFromLocationId('');
    setToLocationId('');
    setLotNumber('');
    setExpiryDate('');
    setReason('');
    setReference('');
    setSubmitError(null);
  }, [defaultMovementType, defaultItemType, defaultItemId]);

  /**
   * Clear item selection when item type changes, because feed items are not
   * valid chemical items and vice versa. Prevents stale item references.
   */
  const handleItemTypeChange = useCallback((newType: StorageItemType) => {
    setItemType(newType);
    setSelectedItemId('');
    setLotNumber('');
    setExpiryDate('');
  }, []);

  /**
   * Clear location fields that become hidden when movement type changes.
   * Prevents submitting a fromLocationId when the movement type is IN
   * (which would be semantically incorrect — goods receipt has no source location).
   */
  const handleMovementTypeChange = useCallback((newType: MovementType) => {
    setMovementType(newType);
    if (!NEEDS_FROM_LOCATION.has(newType)) setFromLocationId('');
    if (!NEEDS_TO_LOCATION.has(newType)) setToLocationId('');
    if (!REASON_REQUIRED_TYPES.has(newType)) setReason('');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;
    setSubmitError(null);

    const input: RecordStockMovementInput = {
      movementType,
      itemType,
      itemId: selectedItemId,
      quantity: parseFloat(quantity),
      fromLocationId: showFromLocation ? fromLocationId : undefined,
      toLocationId: showToLocation ? toLocationId : undefined,
      lotNumber: lotNumber.trim() || undefined,
      expiryDate: expiryDate || undefined,
      reference: reference.trim() || undefined,
      reason: reason.trim() || undefined,
      // Include the idempotency key generated on mount — the backend uses this
      // to guarantee at-most-once execution on network retries or double-clicks.
      idempotencyKey,
    };

    try {
      const result = await recordMovement.mutateAsync(input);

      /**
       * If the backend returns condition warnings (e.g., temperature out of range
       * for the target location), show them as a warning toast so the operator
       * can take corrective action without blocking the movement.
       */
      if (result.warnings && result.warnings.length > 0) {
        const warningMessages = result.warnings.map((w) => w.message).join('; ');
        toast({
          title: 'Movement Recorded with Warnings',
          description: warningMessages,
          variant: 'warning',
        });
      } else {
        toast({
          title: 'Success',
          description: `Stock movement (${movementType}) recorded successfully.`,
          variant: 'success',
        });
      }

      resetForm();
      onClose();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      if (import.meta.env.DEV) console.error('Failed to record stock movement:', err);
      setSubmitError(errorMessage);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Record Stock Movement" size="lg">
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Inline error banner — shown when the GraphQL mutation fails */}
          {submitError && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3">
              <p className="text-sm text-red-700">{submitError}</p>
            </div>
          )}

          {/* Pre-filled item context banner — confirms which item the user is acting on */}
          {defaultItemName && (
            <div className="rounded-md bg-blue-50 border border-blue-200 p-3">
              <p className="text-sm text-blue-700">
                Recording movement for: <span className="font-medium">{defaultItemName}</span>
              </p>
            </div>
          )}

          {/* Movement Type — determines which fields are visible and required */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Movement Type *</label>
            <select
              value={movementType}
              onChange={(e) => handleMovementTypeChange(e.target.value as MovementType)}
              disabled={!!defaultMovementType}
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              {MOVEMENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.description}
                </option>
              ))}
            </select>
          </div>

          {/* Item Type — determines which item list is loaded */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Item Type *</label>
            <div className="mt-1 grid grid-cols-4 gap-2">
              {ITEM_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleItemTypeChange(opt.value)}
                  disabled={!!defaultItemType}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    itemType === opt.value
                      ? 'bg-blue-50 border-blue-500 text-blue-700'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  } disabled:opacity-60 disabled:cursor-not-allowed`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Item selection — populated from the appropriate list hook based on item type */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Item *</label>
            <select
              value={selectedItemId}
              onChange={(e) => setSelectedItemId(e.target.value)}
              disabled={!!defaultItemId}
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              <option value="">Select item...</option>
              {itemOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.name} {opt.code ? `(${opt.code})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Quantity — minimum 0.01 enforced client-side; backend also validates */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Quantity *</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0.00"
              className="mt-1 block w-full max-w-xs border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>

          {/* Location fields — shown/hidden based on movement type */}
          <div className="grid grid-cols-2 gap-4">
            {showFromLocation && (
              <div>
                <label className="block text-sm font-medium text-gray-700">From Location *</label>
                <select
                  value={fromLocationId}
                  onChange={(e) => setFromLocationId(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  <option value="">Select location...</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name} ({loc.code})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {showToLocation && (
              <div>
                <label className="block text-sm font-medium text-gray-700">To Location *</label>
                <select
                  value={toLocationId}
                  onChange={(e) => setToLocationId(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  <option value="">Select location...</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name} ({loc.code})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Lot Number — required for FEED and CHEMICAL per EU 178/2002 traceability */}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Lot Number {isLotNumberRequired ? '*' : ''}
            </label>
            <input
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              placeholder={
                isLotNumberRequired ? 'Required for traceability (EU 178/2002)' : 'Optional'
              }
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>

          {/* Expiry Date — required for FEED and HEALTHCARE per HACCP food safety */}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Expiry Date {isExpiryDateRequired ? '*' : ''}
            </label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="mt-1 block w-full max-w-xs border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>

          {/* Reason — required for WASTE and ADJUSTMENT for ISO 22000 audit trail */}
          {isReasonRequired && (
            <div>
              <label className="block text-sm font-medium text-gray-700">Reason *</label>
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Document the reason for this movement (audit trail)"
                className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          )}

          {/* Reference — optional link to external documents (delivery note, PO number) */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Reference</label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="PO number, delivery note, etc. (optional)"
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
        </div>

        {/* Footer with cancel/submit actions */}
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
            disabled={!isFormValid || recordMovement.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {recordMovement.isPending ? 'Recording...' : 'Record Movement'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default RecordStockMovementModal;
