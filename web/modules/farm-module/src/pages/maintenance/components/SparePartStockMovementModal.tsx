/**
 * SparePartStockMovementModal — one spare-part stock movement (FARM-HIGH-338).
 *
 * WHY a component of its own: a spare-part movement is a storage-ledger
 * movement AT a storage location, so the form carries a location picker
 * (default: the part's own location) beside type and quantity. Keeping it
 * here leaves SparePartsPage a list + catalogue form.
 *
 * WHAT it sends: `recordSparePartStockMovement` with an explicit
 * `storageLocationId` every time — the operator sees, and can change, where
 * the stock moves instead of relying on a server-side default they cannot see.
 * A `transfer` adds the receiving `toStorageLocationId`: relocation is one
 * ledger TRANSFER through this manager-gated door (`transferStock` refuses
 * spare parts).
 *
 * The form buttons render through shared-ui message keys (useI18n, FE-HIGH-089).
 */
import React, { useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Select,
  formatErrorForToast,
  useI18n,
  useToast,
  type SelectOption,
} from '@aquaculture/shared-ui';
import {
  useRecordStockMovement,
  type SparePart,
  type SparePartStockMovementInput,
} from '../../../hooks/useMaintenance';
import type { StorageLocation } from '../../../hooks/useStorageLocations';

type MovementType = SparePartStockMovementInput['movementType'];

const MOVEMENT_TYPE_OPTIONS: { value: MovementType; label: string }[] = [
  { value: 'in', label: 'Stok Girişi' },
  { value: 'out', label: 'Stok Çıkışı' },
  { value: 'adjustment', label: 'Düzeltme (sayım)' },
];

/** Every movement type the form can send, the ledger `transfer` included. */
const MOVEMENT_TYPES: readonly MovementType[] = ['in', 'out', 'adjustment', 'transfer'];

function isMovementType(value: string): value is MovementType {
  return MOVEMENT_TYPES.some((movementType) => movementType === value);
}

/**
 * Picker options for the tenant's storage locations: every active location,
 * plus `keepId` even when it has since been deactivated, so a part's existing
 * assignment stays visible instead of silently rendering as "nothing chosen".
 */
export function buildStorageLocationOptions(
  locations: readonly StorageLocation[],
  keepId?: string | null,
): SelectOption[] {
  return locations
    .filter((location) => location.isActive || location.id === keepId)
    .map((location) => ({
      value: location.id,
      label: location.isActive
        ? `${location.name} (${location.code})`
        : `${location.name} (${location.code}) — pasif`,
    }));
}

export interface SparePartStockMovementModalProps {
  /** The part being moved; the page mounts the modal only while one is selected. */
  part: SparePart;
  /** The tenant's storage locations (useStorageLocationList). */
  locations: readonly StorageLocation[];
  onClose: () => void;
}

export const SparePartStockMovementModal: React.FC<SparePartStockMovementModalProps> = ({
  part,
  locations,
  onClose,
}) => {
  const { toast } = useToast();
  const { t } = useI18n();
  const movementMutation = useRecordStockMovement();

  const [movementType, setMovementType] = useState<MovementType>('in');
  const [quantity, setQuantity] = useState(0);
  const [storageLocationId, setStorageLocationId] = useState(part.storageLocationId ?? '');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [locationError, setLocationError] = useState<string | undefined>(undefined);
  const [toStorageLocationId, setToStorageLocationId] = useState('');
  const [destinationError, setDestinationError] = useState<string | undefined>(undefined);
  const isTransfer = movementType === 'transfer';

  // The ledger TRANSFER (FARM-HIGH-338): the one way a spare part changes
  // location, through the same manager-gated mutation as every other movement.
  const movementTypeOptions: SelectOption[] = [
    ...MOVEMENT_TYPE_OPTIONS,
    { value: 'transfer', label: t('maintenance.sparePartMovement.transfer') },
  ];
  // A transfer's destination is any other active location.
  const destinationOptions: SelectOption[] = [
    ...(toStorageLocationId
      ? []
      : [{ value: '', label: t('maintenance.sparePartMovement.destinationPlaceholder') }]),
    ...buildStorageLocationOptions(locations).filter(
      (option) => option.value !== storageLocationId,
    ),
  ];

  // The empty entry exists only while nothing is chosen: a part without a home
  // location must pick one, and the backend needs either this or the part's own.
  const locationOptions: SelectOption[] = [
    ...(storageLocationId ? [] : [{ value: '', label: 'Lokasyon seçin' }]),
    ...buildStorageLocationOptions(locations, part.storageLocationId),
  ];

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!storageLocationId) {
      setLocationError('Hareketin yapılacağı depolama lokasyonunu seçin.');
      return;
    }
    if (isTransfer && !toStorageLocationId) {
      setDestinationError(t('maintenance.sparePartMovement.destinationRequired'));
      return;
    }

    try {
      await movementMutation.mutateAsync({
        sparePartId: part.id,
        quantity,
        movementType,
        storageLocationId,
        ...(isTransfer ? { toStorageLocationId } : {}),
        reason: reason || undefined,
        notes: notes || undefined,
      });
      onClose();
    } catch (err) {
      toast({
        title: 'Stok hareketi kaydedilemedi',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Stok Hareketi - ${part.name}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg mb-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Mevcut Stok (tüm lokasyonlar)
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {part.quantity} {part.unit}
          </div>
          {part.onOrderQuantity > 0 && (
            <div className="text-sm text-info-600 dark:text-info-400">
              +{part.onOrderQuantity} {part.unit} siparişte
            </div>
          )}
        </div>
        <Select
          label="Depolama Lokasyonu"
          value={storageLocationId}
          onChange={(e) => {
            setStorageLocationId(e.target.value);
            setLocationError(undefined);
          }}
          options={locationOptions}
          error={locationError}
          required
        />
        <Select
          label="Hareket Tipi"
          value={movementType}
          onChange={(e) => {
            if (isMovementType(e.target.value)) setMovementType(e.target.value);
          }}
          options={movementTypeOptions}
        />
        {isTransfer && (
          <Select
            label={t('maintenance.sparePartMovement.destination')}
            value={toStorageLocationId}
            onChange={(e) => {
              setToStorageLocationId(e.target.value);
              setDestinationError(undefined);
            }}
            options={destinationOptions}
            error={destinationError}
            required
          />
        )}
        <Input
          label="Miktar"
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(Math.max(0, parseInt(e.target.value, 10) || 0))}
          required
          min={movementType === 'adjustment' ? 0 : 1}
          step={1}
          helperText={
            movementType === 'adjustment'
              ? 'Seçilen lokasyonda sayılan miktarı girin; fark tek bir düzeltme hareketi olarak işlenir.'
              : undefined
          }
        />
        <Input label="Sebep" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Input label="Notlar" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={movementMutation.isPending}>
            {movementMutation.isPending ? t('common.processing') : t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
