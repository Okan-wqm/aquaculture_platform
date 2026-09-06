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
  ArrowLeft,
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

import { BarcodeScanButton } from '@/components/BarcodeScanButton';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
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
      items { id name code }
    }
  }
`;

const TRANSFER_STOCK_MUTATION = gql`
  mutation TransferStock($input: TransferStockInput!) {
    transferStock(input: $input) {
      id quantity
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
  // MOB: the success heading used to be chosen by `isOnline`, not by what
  // actually happened. On the recoverable-transport fallback below the write
  // reaches the DEVICE QUEUE while isOnline is still true, so the user was
  // told "Recorded!" for a write the server had never seen. Holding the
  // operation id makes the screen report the operation's real state.
  const [queuedOperationId, setQueuedOperationId] = useState<string | null>(null);
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
  const selectedItem = useMemo(() => items.find((i) => i.id === selectedItemId), [items, selectedItemId]);
  const fromLocation = useMemo(() => locations.find((l) => l.id === fromLocationId), [locations, fromLocationId]);
  const toLocation = useMemo(() => locations.find((l) => l.id === toLocationId), [locations, toLocationId]);

  const filteredItems = useMemo(() => {
    if (!itemSearch.trim()) return items;
    const q = itemSearch.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q));
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
      case 1: return selectedItemType !== null && selectedItemId !== '';
      case 2: return fromLocationId !== '';
      case 3: return toLocationId !== '';
      case 4: return quantity !== '' && parseFloat(quantity) > 0;
      case 5: return true;
      default: return false;
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
        await graphqlRequest<{ transferStock: { id: string } }>(
          TRANSFER_STOCK_MUTATION,
          { input },
        );
        if (tenantId) {
          await invalidateSyncedOperationQueries(queryClient, tenantId, ['transferStock']);
        }
      } else {
        const { id: opId } = await addToQueue('transferStock', input);
        setQueuedOperationId(opId);
        return;
      }

      setShowSuccess(true);
      setTimeout(() => navigate('/storage'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to transfer stock';
      // Fallback only when an online transport failure occurred. Offline queue
      // write failures should surface instead of being retried recursively.
      if (isOnline && isRecoverableNetworkError(error)) {
        try {
          const { id: opId } = await addToQueue('transferStock', input);
          setQueuedOperationId(opId);
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
    selectedItem, fromLocation, toLocation, selectedItemType, selectedItemId,
    fromLocationId, toLocationId, quantity, isOnline, addToQueue, navigate,
    queryClient, tenantId,
  ]);

  // ---- Success screen ------------------------------------------------------

  // -- Queued screen ---------------------------------------------------------
  // A queued write is on the device, not in the database. QueuedStatusBadge
  // reports the operation's real state, so a rejection during sync surfaces as
  // "Sync Failed" instead of hiding behind the tick the user already left.
  if (queuedOperationId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-amber-50 dark:bg-amber-900/10 px-6">
        <div className="w-20 h-20 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-4">
          <Package size={48} className="text-amber-600" />
        </div>
        <h2 className="text-xl font-bold text-amber-700 dark:text-amber-300">Saved to device</h2>
        <p className="text-amber-600 dark:text-amber-400 text-sm mt-1 text-center">
          This transfer is not recorded until it reaches the server.
        </p>
        <div className="mt-4">
          <QueuedStatusBadge operationId={queuedOperationId} />
        </div>
        <button
          onClick={() => navigate('/storage')}
          className="mt-6 px-5 py-2.5 rounded-xl bg-amber-600 text-white font-medium touch-feedback"
        >
          Back to storage
        </button>
      </div>
    );
  }

  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-50 dark:bg-green-900/10">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-green-700 dark:text-green-300">
          Transfer Recorded!
        </h2>
        <p className="text-green-600 dark:text-green-400 text-sm mt-1">Returning to storage hub...</p>
      </div>
    );
  }

  const progress = (step / TOTAL_STEPS) * 100;

  // ---- Render --------------------------------------------------------------

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Gradient Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={handleBack} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <ArrowLeftRight size={22} />
            <div>
              <h1 className="text-lg font-bold">Stock Transfer</h1>
              <p className="text-xs text-white/80">Step {step} of {TOTAL_STEPS}</p>
            </div>
          </div>
        </div>
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
        {/* Step 1: Item Type + Item (combined for fewer taps) */}
        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Select item to transfer</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Choose the category and then the specific item.
            </p>

            {/* Item type selector */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              {ITEM_TYPES.map((it) => (
                <button
                  key={it.type}
                  onClick={() => {
                    setSelectedItemType(it.type);
                    setSelectedItemId('');
                    setItemSearch('');
                  }}
                  className={clsx(
                    'p-3 rounded-xl border-2 transition-all touch-feedback text-center',
                    selectedItemType === it.type
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                  )}
                >
                  <span className="text-xl block">{it.emoji}</span>
                  <span className={clsx(
                    'text-[10px] font-bold',
                    selectedItemType === it.type ? 'text-blue-700 dark:text-blue-300' : 'text-gray-600 dark:text-gray-400',
                  )}>
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
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search items..."
                    value={itemSearch}
                    onChange={(e) => setItemSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                  <BarcodeScanButton onScan={setItemSearch} />
                </div>
                {itemsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={24} className="animate-spin text-blue-600" />
                    <span className="ml-2 text-gray-500 text-sm">Loading...</span>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">
                    <Package size={32} className="mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No items found</p>
                  </div>
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
                        onClick={() => setSelectedItemId(item.id)}
                        className={clsx(
                          'w-full p-3.5 rounded-xl border-2 text-left transition-all touch-feedback',
                          selectedItemId === item.id
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                        )}
                      >
                        <span className={clsx(
                          'text-sm font-bold block',
                          selectedItemId === item.id ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-white',
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
              </>
            )}
          </div>
        )}

        {/* Step 2: From Location */}
        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">From location</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Where is the stock currently stored?
            </p>
            {locationsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={28} className="animate-spin text-blue-600" />
                <span className="ml-2 text-gray-500 text-sm">Loading locations...</span>
              </div>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {locations.map((loc) => (
                  <button
                    key={loc.id}
                    onClick={() => {
                      setFromLocationId(loc.id);
                      // Reset "to" if it was the same as the newly selected "from"
                      if (toLocationId === loc.id) setToLocationId('');
                    }}
                    className={clsx(
                      'w-full p-4 rounded-xl border-2 text-left transition-all touch-feedback',
                      fromLocationId === loc.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                    )}
                  >
                    <span className={clsx(
                      'text-sm font-bold block',
                      fromLocationId === loc.id ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-white',
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

        {/* Step 3: To Location */}
        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">To location</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Where should the stock be moved to?
            </p>
            {toLocationOptions.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <p className="text-sm">No other locations available</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {toLocationOptions.map((loc) => (
                  <button
                    key={loc.id}
                    onClick={() => setToLocationId(loc.id)}
                    className={clsx(
                      'w-full p-4 rounded-xl border-2 text-left transition-all touch-feedback',
                      toLocationId === loc.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900',
                    )}
                  >
                    <span className={clsx(
                      'text-sm font-bold block',
                      toLocationId === loc.id ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-white',
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

        {/* Step 4: Quantity */}
        {step === 4 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Transfer quantity</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              How much of {selectedItem?.name ?? 'this item'} are you transferring?
            </p>
            <div className="relative">
              <input
                ref={quantityInputRef}
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full text-center text-4xl font-bold py-6 rounded-2xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {selectedItem && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-lg text-gray-400 font-medium">
                  {selectedItem.unit}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Step 5: Confirm */}
        {step === 5 && (
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Confirm transfer</h2>
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">Item</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">{selectedItem?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">From</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">{fromLocation?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">To</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">{toLocation?.name ?? '-'}</span>
              </div>
              <div className="p-4 flex justify-between">
                <span className="text-sm text-gray-500">Quantity</span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">
                  {quantity} {selectedItem?.unit ?? ''}
                </span>
              </div>
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
                'bg-gradient-to-r from-blue-600 to-blue-500',
              )}
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={20} className="animate-spin" />
                  Transferring...
                </span>
              ) : (
                'Confirm Transfer'
              )}
            </button>
          </div>
        )}
      </div>

      {/* Bottom navigation buttons (except on confirm step) */}
      {step < 5 && (
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
                ? 'bg-blue-600 text-white shadow-card'
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
