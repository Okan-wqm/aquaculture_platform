/**
 * StockTransferPage -- Location-to-location stock transfer form.
 *
 * Simpler than StockMovementPage because transfers have a fixed semantic:
 * move quantity X of item Y from location A to location B. No lot/expiry
 * handling is needed here because the stock retains its existing lot metadata.
 *
 * The "from" and "to" location dropdowns enforce mutual exclusion (you cannot
 * transfer stock to the same location it currently resides in), preventing
 * accidental no-op transfers that would create confusing audit trails.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { gql } from 'graphql-tag';
import {
  ArrowLeftRight,
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
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { BarcodeScanButton } from '@/components/BarcodeScanButton';
import { Button, Card, EmptyState } from '@/components/ui';
import { VirtualList } from '@/components/VirtualList';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { StorageItemType, StockTransferInput } from '@/types';
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

const TRANSFER_STOCK_MUTATION = gql`
  mutation TransferStock($input: TransferStockInput!) {
    transferStock(input: $input) {
      id
      quantity
    }
  }
`;

// ============================================================================
// CONSTANTS
// ============================================================================

const ITEM_TYPES: Array<{ type: StorageItemType; label: string; emoji: string }> = [
  { type: 'FEED', label: 'Feed', emoji: '🐟' },
  { type: 'CHEMICAL', label: 'Chemical', emoji: '🧪' },
  { type: 'CONSUMABLE', label: 'Consumable', emoji: '📦' },
  { type: 'HEALTHCARE', label: 'Healthcare', emoji: '💊' },
];

const TOTAL_STEPS = 5;

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

export function StockTransferPage(): JSX.Element {
  const navigate = useNavigate();
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const { isOnline, addToQueue } = useOfflineQueue();
  const queryClient = useQueryClient();

  // Wizard state
  const [step, setStep] = useState(1);
  const [selectedItemType, setSelectedItemType] = useState<StorageItemType | null>(null);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [itemSearch, setItemSearch] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // WHY ref + focus effect (not autoFocus): the quantity step renders a single
  // field that should receive focus the moment the step opens so the worker can
  // type immediately one-handed. autoFocus is a jsx-a11y/no-autofocus violation;
  // the step-keyed focus effect below reproduces the behaviour cleanly.
  const quantityInputRef = useRef<HTMLInputElement>(null);

  // Focus the quantity field when entering step 4 (replaces removed autoFocus).
  useEffect(() => {
    if (step === 4) quantityInputRef.current?.focus();
  }, [step]);

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
    // from gcTime (1h). Workers at remote sites can still browse cached items.
    enabled: isAuthenticated && !!accessToken && !!tenantId && !!selectedItemType,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  // WHY useMemo: a fresh `?? []` literal each render gives `items` a new identity,
  // forcing every downstream useMemo that depends on it to recompute. Memoizing
  // on `itemsData` keeps the reference stable across renders.
  const items = useMemo(() => itemsData ?? [], [itemsData]);

  const { data: locationsData, isLoading: locationsLoading } = useQuery<StorageLocation[]>({
    queryKey: createTenantQueryKey(tenantId, 'storage-locations', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ storageLocations: { items: StorageLocation[] } }>(
        STORAGE_LOCATIONS_QUERY,
      );
      return result.storageLocations?.items ?? [];
    },
    // Same offline strategy: serve stale cache when offline
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  // WHY useMemo: same stable-identity rationale as `items` above — keeps the
  // `locations` reference stable for the downstream fromLocation/toLocation/
  // toLocationOptions useMemo dependency arrays.
  const locations = useMemo(() => locationsData ?? [], [locationsData]);

  // Derived values
  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId),
    [items, selectedItemId],
  );
  const fromLocation = useMemo(
    () => locations.find((l) => l.id === fromLocationId),
    [locations, fromLocationId],
  );
  const toLocation = useMemo(
    () => locations.find((l) => l.id === toLocationId),
    [locations, toLocationId],
  );

  const filteredItems = useMemo(() => {
    if (!itemSearch.trim()) return items;
    const q = itemSearch.toLowerCase();
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q),
    );
  }, [items, itemSearch]);

  // WHY: Exclude the "from" location from the "to" list to prevent no-op transfers
  // that would create confusing audit trail entries with zero net effect.
  const toLocationOptions = useMemo(
    () => locations.filter((l) => l.id !== fromLocationId),
    [locations, fromLocationId],
  );

  // ---- Navigation helpers --------------------------------------------------

  const canAdvance = useCallback((): boolean => {
    switch (step) {
      case 1:
        return selectedItemType !== null && selectedItemId !== '';
      case 2:
        return fromLocationId !== '';
      case 3:
        return toLocationId !== '';
      case 4:
        return quantity !== '' && parseFloat(quantity) > 0;
      case 5:
        return true;
      default:
        return false;
    }
  }, [step, selectedItemType, selectedItemId, fromLocationId, toLocationId, quantity]);

  const handleNext = useCallback(() => {
    if (!canAdvance()) return;
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }, [canAdvance]);

  const handleBack = useCallback(() => {
    if (step === 1) {
      navigate(-1);
      return;
    }
    setStep((s) => Math.max(s - 1, 1));
  }, [step, navigate]);

  // ---- Submit handler ------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    // WHY guard selectedItemType here: the wizard cannot reach the confirm step
    // without a chosen item type (step 1's canAdvance requires selectedItemType
    // !== null), but the type system can't see that invariant. Narrowing it to a
    // non-null const satisfies the type checker and fails loudly if a future
    // refactor ever violates the precondition.
    if (!selectedItem || !fromLocation || !toLocation || selectedItemType === null) return;
    const itemType = selectedItemType;

    setIsSubmitting(true);
    setSubmitError(null);

    // Generate once for this submit attempt. The offline queue adds a command
    // envelope when queued; online direct submissions still need server-side
    // idempotency for timeout/retry safety.
    const input: StockTransferInput = {
      itemType,
      itemId: selectedItemId,
      fromLocationId,
      toLocationId,
      quantity: parseFloat(quantity),
      idempotencyKey: crypto.randomUUID(),
    };

    try {
      if (isOnline) {
        await graphqlRequest<{ transferStock: { id: string } }>(TRANSFER_STOCK_MUTATION, { input });
        if (tenantId) {
          await invalidateSyncedOperationQueries(queryClient, tenantId, ['transferStock']);
        }
      } else {
        await addToQueue('transferStock', input);
      }

      setShowSuccess(true);
      setTimeout(() => navigate('/storage'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to transfer stock';
      // Fallback only when an online transport failure occurred. Offline queue
      // write failures should surface instead of being retried recursively.
      if (isOnline && isRecoverableNetworkError(error)) {
        try {
          await addToQueue('transferStock', input);
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
    fromLocation,
    toLocation,
    selectedItemType,
    selectedItemId,
    fromLocationId,
    toLocationId,
    quantity,
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
          {isOnline ? 'Transfer Recorded!' : 'Queued for Sync'}
        </h2>
        <p className="text-ink-2 text-body mt-1">Returning to storage hub...</p>
      </div>
    );
  }

  const progress = (step / TOTAL_STEPS) * 100;

  // ---- Render --------------------------------------------------------------

  return (
    <div className="min-h-screen flex flex-col">
      {/* v4: the blue gradient bar becomes the shared header. The step counter
          keeps its place as the subtitle and the progress rail sits directly
          under it, now drawn in the accent instead of translucent white. The
          step machine is untouched — handleBack is the same callback. */}
      <AppHeader
        title="Stock Transfer"
        subtitle={`Step ${step} of ${TOTAL_STEPS}`}
        onBack={handleBack}
        showAvatar={false}
        actions={<ArrowLeftRight size={20} className="text-type-transfer" aria-hidden />}
      />
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
        {/* Step 1: Item Type + Item (combined for fewer taps) */}
        {step === 1 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">Select item to transfer</h2>
            <p className="text-body text-ink-2 mb-4">
              Choose the category and then the specific item.
            </p>

            {/* Item type selector */}
            <div className="grid grid-cols-4 gap-2 mb-4">
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
                    'p-3 min-h-touch rounded-xl border-2 transition-all touch-feedback text-center',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                    selectedItemType === it.type
                      ? 'border-acc bg-acc-dim'
                      : 'border-line bg-surface-1',
                  )}
                >
                  <span className="text-xl block">{it.emoji}</span>
                  {/* Was a 10px label — below the sunlight floor, and on the ratchet. */}
                  <span
                    className={clsx(
                      'text-meta font-bold',
                      selectedItemType === it.type ? 'text-acc' : 'text-ink-2',
                    )}
                  >
                    {it.label}
                  </span>
                </button>
              ))}
            </div>

            {/* Item list */}
            {selectedItemType && (
              <>
                <div className="flex items-stretch gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search
                      size={18}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
                    />
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
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={24} className="animate-spin text-acc" />
                    <span className="ml-2 text-ink-2 text-body">Loading...</span>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <EmptyState
                    icon={<Package size={22} />}
                    title="No items found"
                    className="py-8"
                  />
                ) : (
                  /* MOB-MEDIUM-012: virtualized — inventories can be hundreds of SKUs. */
                  <VirtualList
                    items={filteredItems}
                    getKey={(item) => item.id}
                    estimateSize={() => 72}
                    gapPx={8}
                    className="max-h-[40vh]"
                    renderItem={(item) => (
                      <button
                        type="button"
                        aria-pressed={selectedItemId === item.id}
                        onClick={() => setSelectedItemId(item.id)}
                        className={clsx(
                          'w-full p-3.5 min-h-touch rounded-xl border-2 text-left transition-all touch-feedback',
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
              </>
            )}
          </div>
        )}

        {/* Step 2: From Location */}
        {step === 2 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">From location</h2>
            <p className="text-body text-ink-2 mb-4">Where is the stock currently stored?</p>
            {locationsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={28} className="animate-spin text-acc" />
                <span className="ml-2 text-ink-2 text-body">Loading locations...</span>
              </div>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {locations.map((loc) => (
                  <button
                    key={loc.id}
                    type="button"
                    aria-pressed={fromLocationId === loc.id}
                    onClick={() => {
                      setFromLocationId(loc.id);
                      // Reset "to" if it was the same as the newly selected "from"
                      if (toLocationId === loc.id) setToLocationId('');
                    }}
                    className={clsx(
                      'w-full p-4 min-h-touch rounded-xl border-2 text-left transition-all touch-feedback',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                      fromLocationId === loc.id
                        ? 'border-acc bg-acc-dim'
                        : 'border-line bg-surface-1',
                    )}
                  >
                    <span
                      className={clsx(
                        'text-body font-bold block',
                        fromLocationId === loc.id ? 'text-acc' : 'text-ink-1',
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

        {/* Step 3: To Location */}
        {step === 3 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">To location</h2>
            <p className="text-body text-ink-2 mb-4">Where should the stock be moved to?</p>
            {toLocationOptions.length === 0 ? (
              <EmptyState
                icon={<Package size={22} />}
                title="No other locations available"
                description="A transfer needs a second location to move stock into."
              />
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {toLocationOptions.map((loc) => (
                  <button
                    key={loc.id}
                    type="button"
                    aria-pressed={toLocationId === loc.id}
                    onClick={() => setToLocationId(loc.id)}
                    className={clsx(
                      'w-full p-4 min-h-touch rounded-xl border-2 text-left transition-all touch-feedback',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                      toLocationId === loc.id
                        ? 'border-acc bg-acc-dim'
                        : 'border-line bg-surface-1',
                    )}
                  >
                    <span
                      className={clsx(
                        'text-body font-bold block',
                        toLocationId === loc.id ? 'text-acc' : 'text-ink-1',
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

        {/* Step 4: Quantity */}
        {step === 4 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-2">Transfer quantity</h2>
            <p className="text-body text-ink-2 mb-6">
              How much of {selectedItem?.name ?? 'this item'} are you transferring?
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
          </div>
        )}

        {/* Step 5: Confirm */}
        {step === 5 && (
          <div>
            <h2 className="text-head font-bold text-ink-1 mb-4">Confirm transfer</h2>
            <Card className="divide-y divide-line">
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">Item</span>
                <span className="text-body font-bold text-ink-1">{selectedItem?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">From</span>
                <span className="text-body font-bold text-ink-1">{fromLocation?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">To</span>
                <span className="text-body font-bold text-ink-1">{toLocation?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-body text-ink-2">Quantity</span>
                <span className="text-body font-bold text-ink-1">
                  {quantity} {selectedItem?.unit ?? ''}
                </span>
              </div>
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
                  Transferring...
                </>
              ) : (
                'Confirm Transfer'
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Bottom navigation buttons (except on confirm step) */}
      {step < 5 && (
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
