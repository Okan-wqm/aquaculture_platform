/**
 * StockMovementPage -- Mobile stock movement form (IN / OUT / WASTE).
 *
 * A step-by-step wizard that guides warehouse workers through recording a stock
 * movement one field at a time. This single-field-per-screen approach is critical
 * for mobile ergonomics: workers on the warehouse floor often operate one-handed
 * while carrying items, and large touch targets reduce mis-taps. The wizard
 * pattern also reduces cognitive load -- each step has a clear instruction and
 * a single decision to make.
 *
 * Movement type is determined by the `?type=IN|OUT|WASTE` URL parameter, which
 * adapts the form labels, required fields, and submit action accordingly.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { gql } from 'graphql-tag';
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  Trash2,
  CheckCircle,
  AlertCircle,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Search,
  Package,
} from 'lucide-react';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { BarcodeScanButton } from '@/components/BarcodeScanButton';
import { VirtualList } from '@/components/VirtualList';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { StockMovementType, StorageItemType, StockMovementInput } from '@/types';
import { isRecoverableNetworkError } from '@/utils/network-error';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// ============================================================================
// TYPES
// ============================================================================

interface StorageItem {
  id: string;
  name: string;
  code: string;
  unit: string;
  itemType: StorageItemType;
}

interface StorageLocation {
  id: string;
  name: string;
  code: string;
}

interface StorageInventoryItem {
  itemId: string;
  itemName?: string | null;
  unit: string;
  itemType: StorageItemType;
}

// ============================================================================
// GRAPHQL
// ============================================================================

/**
 * Fetch storage items filtered by item type. The backend returns items relevant
 * to the tenant's warehouse inventory (feed brands, chemical products, etc.).
 */
const STORAGE_ITEMS_QUERY = gql`
  query StorageInventoryItems($itemType: StorageItemType) {
    storageInventory(itemType: $itemType, limit: 100) {
      itemId
      itemName
      unit
      itemType
    }
  }
`;

/**
 * Fetch storage locations (warehouses, silos, cold stores, etc.) for the tenant.
 * Used to populate the location selector in both IN and OUT flows.
 */
const STORAGE_LOCATIONS_QUERY = gql`
  query StorageLocations {
    storageLocations {
      items { id name code }
    }
  }
`;

const RECORD_STOCK_MOVEMENT_MUTATION = gql`
  mutation RecordStockMovement($input: RecordStockMovementInput!) {
    recordStockMovement(input: $input) {
      id movementType quantity
    }
  }
`;

// ============================================================================
// CONSTANTS
// ============================================================================

// WHY: Movement type determines the header color, icon, and which fields are
// mandatory. WASTE requires a reason (for audit), Feed/Chemical require lot
// numbers (for traceability in food safety audits).
const MOVEMENT_CONFIG: Record<StockMovementType, { label: string; color: string; gradient: string; icon: typeof ArrowDownToLine }> = {
  IN: { label: 'Stock In', color: 'text-green-600', gradient: 'from-green-600 to-green-500', icon: ArrowDownToLine },
  OUT: { label: 'Stock Out', color: 'text-red-600', gradient: 'from-red-600 to-red-500', icon: ArrowUpFromLine },
  WASTE: { label: 'Write Off', color: 'text-gray-600', gradient: 'from-gray-600 to-gray-500', icon: Trash2 },
};

const ITEM_TYPES: Array<{ type: StorageItemType; label: string; emoji: string }> = [
  { type: 'FEED', label: 'Feed', emoji: '🐟' },
  { type: 'CHEMICAL', label: 'Chemical', emoji: '🧪' },
  { type: 'CONSUMABLE', label: 'Consumable', emoji: '📦' },
  { type: 'HEALTHCARE', label: 'Healthcare', emoji: '💊' },
];

// WHY: Lot numbers are mandatory for Feed and Chemical to comply with
// aquaculture food safety regulations (traceability from farm to fork).
// Healthcare items require expiry dates for pharmaceutical compliance.
const LOT_REQUIRED_TYPES: StorageItemType[] = ['FEED', 'CHEMICAL'];
const EXPIRY_REQUIRED_TYPES: StorageItemType[] = ['FEED', 'HEALTHCARE'];

// Total wizard steps: itemType -> item -> quantity -> location -> lot/expiry -> notes (WASTE) -> confirm
const TOTAL_STEPS = 7;

function toStorageItems(inventory: StorageInventoryItem[]): StorageItem[] {
  const byItemId = new Map<string, StorageItem>();
  for (const item of inventory) {
    if (!byItemId.has(item.itemId)) {
      byItemId.set(item.itemId, {
        id: item.itemId,
        name: item.itemName || item.itemId,
        code: item.itemId.slice(0, 8),
        unit: item.unit,
        itemType: item.itemType,
      });
    }
  }
  return Array.from(byItemId.values());
}

// ============================================================================
// COMPONENT
// ============================================================================

export function StockMovementPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const { isOnline, addToQueue } = useOfflineQueue();
  const queryClient = useQueryClient();

  // Parse movement type from URL, default to IN for safety
  const rawType = searchParams.get('type') ?? 'IN';
  const movementType: StockMovementType = (rawType === 'OUT' || rawType === 'WASTE') ? rawType : 'IN';
  const config = MOVEMENT_CONFIG[movementType];
  const MovementIcon = config.icon;

  // Wizard state
  const [step, setStep] = useState(1);
  const [selectedItemType, setSelectedItemType] = useState<StorageItemType | null>(null);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [itemSearch, setItemSearch] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // WHY refs + focus effect (not autoFocus): each wizard step renders a single
  // field meant to receive focus the moment its step opens, so the worker can
  // type immediately one-handed. The autoFocus attribute is an a11y anti-pattern
  // (jsx-a11y/no-autofocus); the step-keyed focus effect below reproduces the
  // exact behaviour without the lint violation.
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const lotNumberInputRef = useRef<HTMLInputElement>(null);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);

  // ---- Data fetching -------------------------------------------------------

  const { data: itemsData, isLoading: itemsLoading } = useQuery<StorageItem[]>({
    queryKey: createTenantQueryKey(tenantId, 'storage-items', selectedItemType, tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ storageInventory: StorageInventoryItem[] }>(
        STORAGE_ITEMS_QUERY,
        { itemType: selectedItemType },
      );
      return toStorageItems(result.storageInventory ?? []);
    },
    // Data fetches when online; when offline, React Query serves the stale cache
    // from gcTime (1h). This ensures the form is usable at remote cage sites with
    // intermittent connectivity -- workers can still browse cached items.
    enabled: isAuthenticated && !!accessToken && !!tenantId && !!selectedItemType,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  // WHY useMemo: a fresh `?? []` literal each render gives `items` a new identity,
  // which would force every downstream useMemo that depends on it to recompute on
  // every render. Memoizing on `itemsData` keeps the reference stable.
  const items = useMemo(() => itemsData ?? [], [itemsData]);

  const { data: locationsData, isLoading: locationsLoading } = useQuery<StorageLocation[]>({
    queryKey: createTenantQueryKey(tenantId, 'storage-locations', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ storageLocations: { items: StorageLocation[] } }>(
        STORAGE_LOCATIONS_QUERY,
      );
      return result.storageLocations?.items ?? [];
    },
    // Same offline strategy as items: serve stale cache when offline
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  // WHY useMemo: same stable-identity rationale as `items` above — keeps the
  // `locations` reference stable across renders for the downstream useMemo deps.
  const locations = useMemo(() => locationsData ?? [], [locationsData]);

  // Derived values
  const selectedItem = useMemo(() => items.find((i) => i.id === selectedItemId), [items, selectedItemId]);
  const selectedLocation = useMemo(() => locations.find((l) => l.id === selectedLocationId), [locations, selectedLocationId]);

  // Filtered items for the searchable list
  const filteredItems = useMemo(() => {
    if (!itemSearch.trim()) return items;
    const q = itemSearch.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q));
  }, [items, itemSearch]);

  // WHY: Lot number is required for feed and chemicals to satisfy food safety
  // traceability regulations. Expiry date is required for feed and healthcare
  // products to prevent use of expired stock.
  const needsLot = selectedItemType ? LOT_REQUIRED_TYPES.includes(selectedItemType) : false;
  const needsExpiry = selectedItemType ? EXPIRY_REQUIRED_TYPES.includes(selectedItemType) : false;
  const needsNotes = movementType === 'WASTE';

  // Focus the active step's primary field on entry (replaces removed autoFocus).
  useEffect(() => {
    if (step === 3) quantityInputRef.current?.focus();
    else if (step === 5 && needsLot) lotNumberInputRef.current?.focus();
    else if (step === 6) notesInputRef.current?.focus();
    // WHY depend on needsLot: the lot field only mounts on step 5 when a lot is
    // required, so focus must only be attempted under that same condition.
  }, [step, needsLot]);

  // ---- Navigation helpers --------------------------------------------------

  const canAdvance = useCallback((): boolean => {
    switch (step) {
      case 1: return selectedItemType !== null;
      case 2: return selectedItemId !== '';
      case 3: return quantity !== '' && parseFloat(quantity) > 0;
      case 4: return selectedLocationId !== '';
      case 5: {
        if (needsLot && !lotNumber.trim()) return false;
        if (needsExpiry && !expiryDate) return false;
        return true;
      }
      case 6: {
        if (needsNotes && !notes.trim()) return false;
        return true;
      }
      case 7: return true;
      default: return false;
    }
  }, [step, selectedItemType, selectedItemId, quantity, selectedLocationId, lotNumber, expiryDate, notes, needsLot, needsExpiry, needsNotes]);

  const handleNext = useCallback(() => {
    if (!canAdvance()) return;

    // Skip lot/expiry step if not needed for this item type
    if (step === 4 && !needsLot && !needsExpiry) {
      // Skip to notes step or confirm step
      if (!needsNotes) {
        setStep(7); // Jump to confirm
      } else {
        setStep(6); // Jump to notes
      }
      return;
    }

    // Skip notes step if not WASTE
    if (step === 5 && !needsNotes) {
      setStep(7);
      return;
    }

    if (step === 6 && !needsNotes) {
      setStep(7);
      return;
    }

    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }, [step, canAdvance, needsLot, needsExpiry, needsNotes]);

  const handleBack = useCallback(() => {
    if (step === 1) {
      navigate(-1);
      return;
    }

    // Reverse-skip logic matching the forward skip
    if (step === 7 && !needsNotes && !needsLot && !needsExpiry) {
      setStep(4);
      return;
    }
    if (step === 7 && !needsNotes) {
      setStep(5);
      return;
    }
    if (step === 6 && !needsLot && !needsExpiry) {
      setStep(4);
      return;
    }

    setStep((s) => Math.max(s - 1, 1));
  }, [step, navigate, needsNotes, needsLot, needsExpiry]);

  // ---- Submit handler ------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    // WHY guard selectedItemType here: the wizard cannot reach the confirm step
    // without a chosen item type (step 1's canAdvance requires it), but the type
    // system can't see that invariant. Narrowing it to a non-null const both
    // satisfies the type checker and fails loudly if the precondition is ever
    // violated by a future refactor.
    if (!selectedItem || !selectedLocation || selectedItemType === null) return;
    const itemType = selectedItemType;

    setIsSubmitting(true);
    setSubmitError(null);

    // Backend uses separate fromLocationId / toLocationId:
    // - IN: stock arrives at toLocationId (destination warehouse)
    // - OUT / WASTE: stock leaves fromLocationId (source warehouse)
    const input: StockMovementInput = {
      movementType,
      itemType,
      itemId: selectedItemId,
      quantity: parseFloat(quantity),
      ...(movementType === 'IN'
        ? { toLocationId: selectedLocationId }
        : { fromLocationId: selectedLocationId }),
      idempotencyKey: crypto.randomUUID(),
      ...(lotNumber.trim() ? { lotNumber: lotNumber.trim() } : {}),
      ...(expiryDate ? { expiryDate } : {}),
      ...(movementType === 'WASTE' && notes.trim() ? { reason: notes.trim() } : {}),
    };

    try {
      if (isOnline) {
        await graphqlRequest<{ recordStockMovement: { id: string } }>(
          RECORD_STOCK_MOVEMENT_MUTATION,
          { input },
        );
        if (tenantId) {
          await invalidateSyncedOperationQueries(queryClient, tenantId, ['recordStockMovement']);
        }
      } else {
        // Queue for later sync when offline
        await addToQueue('recordStockMovement', input);
      }

      setShowSuccess(true);
      setTimeout(() => navigate('/storage'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record stock movement';
      // Fallback only when an online transport failure occurred. If the offline
      // queue itself failed, retrying the same queue write would hide the cause.
      if (isOnline && isRecoverableNetworkError(error)) {
        try {
          await addToQueue('recordStockMovement', input);
          setShowSuccess(true);
          setTimeout(() => navigate('/storage'), 1500);
          return;
        } catch (queueError) {
          setSubmitError(queueError instanceof Error ? queueError.message : 'Failed to queue operation');
          return;
        }
      }
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    selectedItem, selectedLocation, movementType, selectedItemType, selectedItemId,
    quantity, selectedLocationId, lotNumber, expiryDate, notes, isOnline,
    addToQueue, navigate, queryClient, tenantId,
  ]);

  // ---- Success screen ------------------------------------------------------

  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-50 dark:bg-green-900/10">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-green-700 dark:text-green-300">
          {isOnline ? 'Movement Recorded!' : 'Queued for Sync'}
        </h2>
        <p className="text-green-600 dark:text-green-400 text-sm mt-1">Returning to storage hub...</p>
      </div>
    );
  }

  // ---- Progress bar --------------------------------------------------------

  // Calculate effective progress considering skipped steps
  const effectiveSteps = 4 + (needsLot || needsExpiry ? 1 : 0) + (needsNotes ? 1 : 0) + 1; // +1 for confirm
  const effectiveStep = (() => {
    if (step <= 4) return step;
    if (step === 5) return 5;
    if (step === 6) return needsLot || needsExpiry ? 6 : 5;
    return effectiveSteps; // confirm step
  })();
  const progress = (effectiveStep / effectiveSteps) * 100;

  // ---- Render --------------------------------------------------------------

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Gradient Header */}
      <div className={`bg-gradient-to-r ${config.gradient} text-white`}>
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={handleBack} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <MovementIcon size={22} />
            <div>
              <h1 className="text-lg font-bold">{config.label}</h1>
              <p className="text-xs text-white/80">Step {effectiveStep} of {effectiveSteps}</p>
            </div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1 bg-white/20">
          <div
            className="h-full bg-white/80 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Error Banner */}
      {submitError && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{submitError}</span>
        </div>
      )}

      {/* Step Content */}
      <div className="flex-1 px-4 pt-6 pb-safe-bottom">
        {/* Step 1: Item Type */}
        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">What type of item?</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Select the category of the stock item you are {movementType === 'IN' ? 'receiving' : movementType === 'OUT' ? 'dispensing' : 'writing off'}.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {ITEM_TYPES.map((it) => (
                <button
                  key={it.type}
                  onClick={() => {
                    setSelectedItemType(it.type);
                    setSelectedItemId('');
                    setItemSearch('');
                  }}
                  className={clsx(
                    'p-5 rounded-2xl border-2 transition-all touch-feedback active:scale-[0.97]',
                    selectedItemType === it.type
                      ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                  )}
                >
                  <span className="text-3xl block mb-2">{it.emoji}</span>
                  <span className={clsx(
                    'text-sm font-bold',
                    selectedItemType === it.type ? 'text-teal-700 dark:text-teal-300' : 'text-gray-700 dark:text-gray-300',
                  )}>
                    {it.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Item Selector (searchable list) */}
        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Select item</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Choose the specific product from your inventory.
            </p>
            {/* Search bar + scan-to-find (MOB-MEDIUM-010): a scanned barcode/QR
                fills the search, matching items by their printed code. */}
            <div className="flex items-stretch gap-2 mb-4">
              <div className="relative flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search items..."
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <BarcodeScanButton onScan={setItemSearch} />
            </div>
            {itemsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={28} className="animate-spin text-teal-600" />
                <span className="ml-2 text-gray-500 text-sm">Loading items...</span>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <Package size={40} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">{items.length === 0 ? 'No items found for this type' : 'No matches'}</p>
              </div>
            ) : (
              /* MOB-MEDIUM-012: virtualized — inventories can be hundreds of SKUs. */
              <VirtualList
                items={filteredItems}
                getKey={(item) => item.id}
                estimateSize={() => 76}
                gapPx={8}
                className="max-h-[50vh]"
                renderItem={(item) => (
                  <button
                    onClick={() => setSelectedItemId(item.id)}
                    className={clsx(
                      'w-full p-4 rounded-xl border-2 text-left transition-all touch-feedback',
                      selectedItemId === item.id
                        ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                    )}
                  >
                    <span className={clsx(
                      'text-sm font-bold block',
                      selectedItemId === item.id ? 'text-teal-700 dark:text-teal-300' : 'text-gray-900 dark:text-white',
                    )}>
                      {item.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {item.code} &middot; {item.unit}
                    </span>
                  </button>
                )}
              />
            )}
          </div>
        )}

        {/* Step 3: Quantity + Unit */}
        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Enter quantity</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              How much are you {movementType === 'IN' ? 'receiving' : movementType === 'OUT' ? 'dispensing' : 'writing off'}?
            </p>
            <div className="relative">
              <input
                ref={quantityInputRef}
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full text-center text-4xl font-bold py-6 rounded-2xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
              />
              {selectedItem && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-lg text-gray-400 font-medium">
                  {selectedItem.unit}
                </span>
              )}
            </div>
            {selectedItem && (
              <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-3">
                {selectedItem.name}
              </p>
            )}
          </div>
        )}

        {/* Step 4: Location Selector */}
        {step === 4 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
              {movementType === 'IN' ? 'Destination location' : 'Source location'}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {movementType === 'IN'
                ? 'Where will this stock be stored?'
                : 'Where is this stock located?'}
            </p>
            {locationsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={28} className="animate-spin text-teal-600" />
                <span className="ml-2 text-gray-500 text-sm">Loading locations...</span>
              </div>
            ) : locations.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <p className="text-sm">No storage locations configured</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {locations.map((loc) => (
                  <button
                    key={loc.id}
                    onClick={() => setSelectedLocationId(loc.id)}
                    className={clsx(
                      'w-full p-4 rounded-xl border-2 text-left transition-all touch-feedback',
                      selectedLocationId === loc.id
                        ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                    )}
                  >
                    <span className={clsx(
                      'text-sm font-bold block',
                      selectedLocationId === loc.id ? 'text-teal-700 dark:text-teal-300' : 'text-gray-900 dark:text-white',
                    )}>
                      {loc.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{loc.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 5: Lot Number + Expiry Date */}
        {step === 5 && (needsLot || needsExpiry) && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Traceability details</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Required for food safety and pharmaceutical compliance.
            </p>
            {needsLot && (
              <div className="mb-5">
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  Lot / Batch Number {needsLot && <span className="text-red-500">*</span>}
                </label>
                <input
                  ref={lotNumberInputRef}
                  type="text"
                  placeholder="e.g. LOT-2026-0328-A"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            )}
            {needsExpiry && (
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  Expiry Date {needsExpiry && <span className="text-red-500">*</span>}
                </label>
                <input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            )}
          </div>
        )}

        {/* Step 6: Notes / Reason (required for WASTE) */}
        {step === 6 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
              {needsNotes ? 'Reason for write-off' : 'Notes (optional)'}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              {needsNotes
                ? 'A reason is required for audit trail compliance.'
                : 'Add any additional notes about this movement.'}
            </p>
            <textarea
              ref={notesInputRef}
              placeholder={needsNotes ? 'e.g. Feed damaged by water ingress...' : 'Optional notes...'}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
            />
          </div>
        )}

        {/* Step 7: Confirm + Submit */}
        {step === 7 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Confirm details</h2>
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">Type</span>
                <span className={`text-sm font-bold ${config.color}`}>{config.label}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">Item</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">{selectedItem?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">Quantity</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">
                  {quantity} {selectedItem?.unit ?? ''}
                </span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">Location</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">{selectedLocation?.name ?? '-'}</span>
              </div>
              {lotNumber && (
                <div className="p-4 flex justify-between">
                  <span className="text-sm text-gray-500">Lot Number</span>
                  <span className="text-sm font-bold text-gray-900 dark:text-white">{lotNumber}</span>
                </div>
              )}
              {expiryDate && (
                <div className="p-4 flex justify-between">
                  <span className="text-sm text-gray-500">Expiry Date</span>
                  <span className="text-sm font-bold text-gray-900 dark:text-white">{expiryDate}</span>
                </div>
              )}
              {notes && (
                <div className="p-4">
                  <span className="text-sm text-gray-500 block mb-1">{movementType === 'WASTE' ? 'Reason' : 'Notes'}</span>
                  <span className="text-sm text-gray-900 dark:text-white">{notes}</span>
                </div>
              )}
            </div>

            {!isOnline && (
              <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 flex items-center gap-2 border border-amber-200 dark:border-amber-800">
                <AlertCircle size={16} className="text-amber-500 flex-shrink-0" />
                <span className="text-amber-600 dark:text-amber-300 text-xs">
                  You are offline. This will be queued and synced when connected.
                </span>
              </div>
            )}

            <button
              onClick={() => { void handleSubmit(); }}
              disabled={isSubmitting}
              className={clsx(
                'w-full mt-6 py-4 rounded-2xl font-bold text-white text-base shadow-card transition-all active:scale-[0.98] touch-feedback',
                isSubmitting ? 'opacity-50' : '',
                `bg-gradient-to-r ${config.gradient}`,
              )}
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={20} className="animate-spin" />
                  Submitting...
                </span>
              ) : (
                `Confirm ${config.label}`
              )}
            </button>
          </div>
        )}
      </div>

      {/* Bottom navigation buttons (except on confirm step) */}
      {step < 7 && (
        <div className="px-4 pb-6 pb-safe-bottom flex gap-3">
          <button
            onClick={handleBack}
            className="flex-1 py-3.5 rounded-xl border-2 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 font-semibold text-sm touch-feedback transition-all active:scale-[0.98] flex items-center justify-center gap-1"
          >
            <ChevronLeft size={18} />
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={!canAdvance()}
            className={clsx(
              'flex-1 py-3.5 rounded-xl font-semibold text-sm touch-feedback transition-all active:scale-[0.98] flex items-center justify-center gap-1',
              canAdvance()
                ? 'bg-teal-600 text-white shadow-card'
                : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600',
            )}
          >
            Next
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
