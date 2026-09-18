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

import { AppHeader } from '@/components/AppHeader';
import { BarcodeScanButton } from '@/components/BarcodeScanButton';
import { Button, Card, EmptyState } from '@/components/ui';
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
      items {
        id
        name
        code
      }
    }
  }
`;

const RECORD_STOCK_MOVEMENT_MUTATION = gql`
  mutation RecordStockMovement($input: RecordStockMovementInput!) {
    recordStockMovement(input: $input) {
      id
      movementType
      quantity
    }
  }
`;

// ============================================================================
// CONSTANTS
// ============================================================================

// WHY: Movement type determines the header color, icon, and which fields are
// mandatory. WASTE requires a reason (for audit), Feed/Chemical require lot
// numbers (for traceability in food safety audits).
//
// v4: the per-type gradient is gone — the header is the app's flat one and the
// CTA is the accent, because teal carries every action regardless of what is
// being recorded. What survives is `color`, the type's own tint, now on the
// header icon and the confirm screen's Type row: receiving confirms (ok),
// dispensing is a watch (warn), and a write-off is a loss (crit). It used to be
// grey, which made the destructive movement the quietest one on the screen.
const MOVEMENT_CONFIG: Record<
  StockMovementType,
  { label: string; color: string; icon: typeof ArrowDownToLine }
> = {
  IN: { label: 'Stock In', color: 'text-ok', icon: ArrowDownToLine },
  OUT: { label: 'Stock Out', color: 'text-warn', icon: ArrowUpFromLine },
  WASTE: { label: 'Write Off', color: 'text-crit', icon: Trash2 },
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
  const movementType: StockMovementType = rawType === 'OUT' || rawType === 'WASTE' ? rawType : 'IN';
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
  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId),
    [items, selectedItemId],
  );
  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === selectedLocationId),
    [locations, selectedLocationId],
  );

  // Filtered items for the searchable list
  const filteredItems = useMemo(() => {
    if (!itemSearch.trim()) return items;
    const q = itemSearch.toLowerCase();
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q),
    );
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
      case 1:
        return selectedItemType !== null;
      case 2:
        return selectedItemId !== '';
      case 3:
        return quantity !== '' && parseFloat(quantity) > 0;
      case 4:
        return selectedLocationId !== '';
      case 5: {
        if (needsLot && !lotNumber.trim()) return false;
        if (needsExpiry && !expiryDate) return false;
        return true;
      }
      case 6: {
        if (needsNotes && !notes.trim()) return false;
        return true;
      }
      case 7:
        return true;
      default:
        return false;
    }
  }, [
    step,
    selectedItemType,
    selectedItemId,
    quantity,
    selectedLocationId,
    lotNumber,
    expiryDate,
    notes,
    needsLot,
    needsExpiry,
    needsNotes,
  ]);

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
          setSubmitError(
            queueError instanceof Error ? queueError.message : 'Failed to queue operation',
          );
          return;
        }
      }
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    selectedItem,
    selectedLocation,
    movementType,
    selectedItemType,
    selectedItemId,
    quantity,
    selectedLocationId,
    lotNumber,
    expiryDate,
    notes,
    isOnline,
    addToQueue,
    navigate,
    queryClient,
    tenantId,
  ]);

  // ---- Success screen ------------------------------------------------------

  if (showSuccess) {
    return (
      // The page tint is gone — the ground belongs to <body>. Green stays where
      // it means something: on the confirmation mark and its headline.
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="w-20 h-20 bg-surface-2 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-ok" />
        </div>
        <h2 className="text-head font-bold text-ok">
          {isOnline ? 'Movement Recorded!' : 'Queued for Sync'}
        </h2>
        <p className="text-ink-2 text-body mt-1">Returning to storage hub...</p>
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
    <div className="min-h-screen flex flex-col">
      {/* v4: the per-type gradient bar becomes the shared header. The step
          counter keeps its place as the subtitle, the movement icon keeps its
          place on the right in the type's own tint, and the progress rail sits
          directly under the header. The step machine is untouched — handleBack
          is the same callback it always was. */}
      <AppHeader
        title={config.label}
        subtitle={`Step ${effectiveStep} of ${effectiveSteps}`}
        onBack={handleBack}
        showAvatar={false}
        actions={<MovementIcon size={20} className={config.color} aria-hidden />}
      />
      {/* Progress bar */}
      <div className="h-1 bg-surface-2">
        <div
          className="h-full bg-acc transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Error Banner */}
      {submitError && (
        <Card className="mx-4 mt-3 p-3 flex items-center gap-2 border-crit">
          <AlertCircle size={18} className="text-crit flex-shrink-0" />
          <span className="text-crit text-body">{submitError}</span>
        </Card>
      )}

      {/* Step Content */}
      <div className="flex-1 px-4 pt-6 pb-safe-bottom">
        {/* Step 1: Item Type */}
        {step === 1 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">What type of item?</h2>
            <p className="text-body text-ink-2 mb-6">
              Select the category of the stock item you are{' '}
              {movementType === 'IN'
                ? 'receiving'
                : movementType === 'OUT'
                  ? 'dispensing'
                  : 'writing off'}
              .
            </p>
            <div className="grid grid-cols-2 gap-3">
              {ITEM_TYPES.map((it) => (
                <button
                  key={it.type}
                  type="button"
                  aria-pressed={selectedItemType === it.type}
                  onClick={() => {
                    setSelectedItemType(it.type);
                    setSelectedItemId('');
                    setItemSearch('');
                  }}
                  className={clsx(
                    'p-5 min-h-touch rounded-2xl border-2 transition-all touch-feedback active:scale-[0.97]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                    selectedItemType === it.type
                      ? 'border-acc bg-acc-dim'
                      : 'border-line bg-surface-1',
                  )}
                >
                  <span className="text-3xl block mb-2">{it.emoji}</span>
                  <span
                    className={clsx(
                      'text-body font-bold',
                      selectedItemType === it.type ? 'text-acc' : 'text-ink-1',
                    )}
                  >
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
            <h2 className="text-head font-bold text-ink-1 mb-2">Select item</h2>
            <p className="text-body text-ink-2 mb-4">
              Choose the specific product from your inventory.
            </p>
            {/* Search bar + scan-to-find (MOB-MEDIUM-010): a scanned barcode/QR
                fills the search, matching items by their printed code. */}
            <div className="flex items-stretch gap-2 mb-4">
              <div className="relative flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
                <input
                  type="text"
                  placeholder="Search items..."
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  className="w-full min-h-touch pl-10 pr-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc"
                />
              </div>
              <BarcodeScanButton onScan={setItemSearch} />
            </div>
            {itemsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={28} className="animate-spin text-acc" />
                <span className="ml-2 text-ink-2 text-body">Loading items...</span>
              </div>
            ) : filteredItems.length === 0 ? (
              <EmptyState
                icon={<Package size={22} />}
                title={items.length === 0 ? 'No items found for this type' : 'No matches'}
                description={
                  items.length === 0
                    ? undefined
                    : 'Nothing in this category matches that search or scan.'
                }
              />
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
                    type="button"
                    aria-pressed={selectedItemId === item.id}
                    onClick={() => setSelectedItemId(item.id)}
                    className={clsx(
                      'w-full p-4 min-h-touch rounded-xl border-2 text-left transition-all touch-feedback',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                      selectedItemId === item.id
                        ? 'border-acc bg-acc-dim'
                        : 'border-line bg-surface-1',
                    )}
                  >
                    <span
                      className={clsx(
                        'text-body font-bold block',
                        selectedItemId === item.id ? 'text-acc' : 'text-ink-1',
                      )}
                    >
                      {item.name}
                    </span>
                    <span className="text-meta text-ink-3">
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
            <h2 className="text-head font-bold text-ink-1 mb-2">Enter quantity</h2>
            <p className="text-body text-ink-2 mb-6">
              How much are you{' '}
              {movementType === 'IN'
                ? 'receiving'
                : movementType === 'OUT'
                  ? 'dispensing'
                  : 'writing off'}
              ?
            </p>
            <div className="relative">
              {/* The v4 hero numeral: mono at 700 so the digits are tabular and
                  the figure is readable at arm's length. */}
              <input
                ref={quantityInputRef}
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full text-center text-hero font-mono font-bold tabular-nums py-6 rounded-2xl border-2 border-line bg-surface-1 text-ink-1 focus:outline-none focus:ring-2 focus:ring-acc focus:border-transparent"
              />
              {selectedItem && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-title text-ink-3 font-medium">
                  {selectedItem.unit}
                </span>
              )}
            </div>
            {selectedItem && (
              <p className="text-center text-body text-ink-2 mt-3">{selectedItem.name}</p>
            )}
          </div>
        )}

        {/* Step 4: Location Selector */}
        {step === 4 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">
              {movementType === 'IN' ? 'Destination location' : 'Source location'}
            </h2>
            <p className="text-body text-ink-2 mb-4">
              {movementType === 'IN'
                ? 'Where will this stock be stored?'
                : 'Where is this stock located?'}
            </p>
            {locationsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={28} className="animate-spin text-acc" />
                <span className="ml-2 text-ink-2 text-body">Loading locations...</span>
              </div>
            ) : locations.length === 0 ? (
              <EmptyState
                icon={<Package size={22} />}
                title="No storage locations configured"
                description="A movement has to land somewhere — add a location in the web app first."
              />
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {locations.map((loc) => (
                  <button
                    key={loc.id}
                    type="button"
                    aria-pressed={selectedLocationId === loc.id}
                    onClick={() => setSelectedLocationId(loc.id)}
                    className={clsx(
                      'w-full p-4 min-h-touch rounded-xl border-2 text-left transition-all touch-feedback',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                      selectedLocationId === loc.id
                        ? 'border-acc bg-acc-dim'
                        : 'border-line bg-surface-1',
                    )}
                  >
                    <span
                      className={clsx(
                        'text-body font-bold block',
                        selectedLocationId === loc.id ? 'text-acc' : 'text-ink-1',
                      )}
                    >
                      {loc.name}
                    </span>
                    <span className="text-meta text-ink-3">{loc.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 5: Lot Number + Expiry Date */}
        {step === 5 && (needsLot || needsExpiry) && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">Traceability details</h2>
            <p className="text-body text-ink-2 mb-6">
              Required for food safety and pharmaceutical compliance.
            </p>
            {needsLot && (
              <div className="mb-5">
                <label className="block text-body font-semibold text-ink-1 mb-2">
                  Lot / Batch Number {needsLot && <span className="text-crit">*</span>}
                </label>
                <input
                  ref={lotNumberInputRef}
                  type="text"
                  placeholder="e.g. LOT-2026-0328-A"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                  className="w-full min-h-touch px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc"
                />
              </div>
            )}
            {needsExpiry && (
              <div>
                <label className="block text-body font-semibold text-ink-1 mb-2">
                  Expiry Date {needsExpiry && <span className="text-crit">*</span>}
                </label>
                <input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full min-h-touch px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc"
                />
              </div>
            )}
          </div>
        )}

        {/* Step 6: Notes / Reason (required for WASTE) */}
        {step === 6 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">
              {needsNotes ? 'Reason for write-off' : 'Notes (optional)'}
            </h2>
            <p className="text-body text-ink-2 mb-6">
              {needsNotes
                ? 'A reason is required for audit trail compliance.'
                : 'Add any additional notes about this movement.'}
            </p>
            <textarea
              ref={notesInputRef}
              placeholder={
                needsNotes ? 'e.g. Feed damaged by water ingress...' : 'Optional notes...'
              }
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc resize-none"
            />
          </div>
        )}

        {/* Step 7: Confirm + Submit */}
        {step === 7 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-4">Confirm details</h2>
            <Card className="divide-y divide-line">
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">Type</span>
                <span className={clsx('text-body font-bold', config.color)}>{config.label}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">Item</span>
                <span className="text-body font-bold text-ink-1">{selectedItem?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">Quantity</span>
                <span className="text-body font-bold text-ink-1">
                  {quantity} {selectedItem?.unit ?? ''}
                </span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">Location</span>
                <span className="text-body font-bold text-ink-1">
                  {selectedLocation?.name ?? '-'}
                </span>
              </div>
              {lotNumber && (
                <div className="p-4 flex justify-between">
                  <span className="text-body text-ink-2">Lot Number</span>
                  <span className="text-body font-bold text-ink-1">{lotNumber}</span>
                </div>
              )}
              {expiryDate && (
                <div className="p-4 flex justify-between">
                  <span className="text-body text-ink-2">Expiry Date</span>
                  <span className="text-body font-bold text-ink-1">{expiryDate}</span>
                </div>
              )}
              {notes && (
                <div className="p-4">
                  <span className="text-body text-ink-2 block mb-1">
                    {movementType === 'WASTE' ? 'Reason' : 'Notes'}
                  </span>
                  <span className="text-body text-ink-1">{notes}</span>
                </div>
              )}
            </Card>

            {!isOnline && (
              <Card className="mt-4 p-3 flex items-center gap-2 border-warn">
                <AlertCircle size={16} className="text-warn flex-shrink-0" />
                <span className="text-warn text-meta">
                  You are offline. This will be queued and synced when connected.
                </span>
              </Card>
            )}

            <Button
              variant="primary"
              size="save"
              block
              className="mt-6 font-bold"
              onClick={() => {
                void handleSubmit();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  Submitting...
                </>
              ) : (
                `Confirm ${config.label}`
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Bottom navigation buttons (except on confirm step) */}
      {step < 7 && (
        <div className="px-4 pb-6 pb-safe-bottom flex gap-3">
          <Button variant="ghost" onClick={handleBack} className="flex-1 border border-line">
            <ChevronLeft size={18} />
            Back
          </Button>
          <Button
            variant="primary"
            onClick={handleNext}
            disabled={!canAdvance()}
            className="flex-1"
          >
            Next
            <ChevronRight size={18} />
          </Button>
        </div>
      )}
    </div>
  );
}
