/**
 * StockViewPage -- Read-only stock inventory view.
 *
 * Displays current stock levels per storage location with expiry status badges.
 * This page is used by warehouse workers to quickly check what is available at
 * a given location before making a stock-out or transfer decision, and by
 * managers to verify stock levels during walk-throughs.
 *
 * Data is cached in IndexedDB for offline viewing so field workers can check
 * stock even without connectivity (common in cold stores and remote sites).
 * Pull-to-refresh re-fetches from the server when online.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Package,
  AlertCircle,
  Loader2,
  RefreshCw,
  MapPin,
} from 'lucide-react';
import { useState, useCallback, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { STOCK_AT_LOCATION, STORAGE_LOCATIONS } from '@/graphql/storage-operations';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';


// ============================================================================
// TYPES
// ============================================================================

interface StorageLocation {
  id: string;
  name: string;
  code: string;
}

/**
 * Mirrors a row of the farm-service `storageInventory` query
 * (StorageInventoryResponse). `itemName` is a denormalized, nullable field;
 * `storageInventory` returns a flat array — there is no `itemCode` on stored
 * inventory (item codes live only on purchase-order lines), so the card shows
 * the item type instead of a code.
 */
interface StockItem {
  id: string;
  itemName: string | null;
  itemType: string;
  quantity: number;
  unit: string;
  lotNumber: string | null;
  expiryDate: string | null;
}

// ============================================================================
// GRAPHQL
// ============================================================================

// ============================================================================
// HELPERS
// ============================================================================

/** Cache key for stock data — keyed by locationId for per-location offline access. */
function stockCacheKey(locationId: string): string {
  return `stock_at_${locationId}`;
}

/**
 * Compute expiry status for badge rendering.
 * - 'expired': past today
 * - 'warning': within 30 days
 * - 'ok': more than 30 days or no expiry set
 */
function getExpiryStatus(expiryDate: string | null): 'expired' | 'warning' | 'ok' {
  if (!expiryDate) return 'ok';
  const expiry = new Date(expiryDate);
  const now = new Date();
  const diffDays = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'expired';
  if (diffDays < 30) return 'warning';
  return 'ok';
}

function formatExpiryDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ============================================================================
// COMPONENT
// ============================================================================

export function StockViewPage(): JSX.Element {
  const navigate = useNavigate();
  const { accessToken, tenantId, isAuthenticated } = useAuth();
  const { isOnline } = useOfflineQueue();
  const queryClient = useQueryClient();

  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Pull-to-refresh touch tracking
  const touchStartY = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // ---- Data fetching -------------------------------------------------------

  const { data: locationsData, isLoading: locationsLoading } = useQuery<StorageLocation[]>({
    queryKey: createTenantQueryKey(tenantId, 'storage-locations', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest(
        STORAGE_LOCATIONS,
      );
      return result.storageLocations?.items ?? [];
    },
    // Allow offline access via React Query stale cache so workers can still
    // select a location and view cached stock at remote cage sites.
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60,
  });
  // WHY useMemo: a fresh `?? []` literal each render gives `locations` a new
  // identity, forcing the downstream `selectedLocation` useMemo to recompute on
  // every render. Memoizing on `locationsData` keeps the reference stable.
  const locations = useMemo(() => locationsData ?? [], [locationsData]);

  const { data: stockData, isLoading: stockLoading, refetch: refetchStock } = useQuery<StockItem[]>({
    queryKey: createTenantQueryKey(tenantId, 'stock-at-location', selectedLocationId, tenantId),
    queryFn: async () => {
      // WHY guard tenantId here: `enabled` below already gates this query on
      // `!!tenantId`, so the query never runs without one — but the type system
      // can't see that. Narrowing to a non-null const both satisfies the type
      // checker for the tenant-isolated cache calls (FE-CRITICAL-002) and fails
      // loudly if the precondition is ever broken by a future refactor.
      if (!tenantId) {
        throw new Error('StockViewPage: tenantId missing despite enabled gate');
      }
      // Attempt server fetch first
      if (isOnline) {
        const result = await graphqlRequest(
          STOCK_AT_LOCATION,
          { locationId: selectedLocationId },
        );
        const items = result.storageInventory ?? [];
        // Cache for offline viewing (1-hour TTL, acceptable staleness for stock counts)
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId, stockCacheKey(selectedLocationId), items, 1000 * 60 * 60);
        return items;
      }
      // Offline: load from cache
      const cached = await getCachedData<StockItem[]>(tenantId, stockCacheKey(selectedLocationId));
      return cached ?? [];
    },
    enabled: !!selectedLocationId && isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });
  const stock = stockData ?? [];

  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === selectedLocationId),
    [locations, selectedLocationId],
  );

  // ---- Pull-to-refresh handler ---------------------------------------------

  const handleRefresh = useCallback(async () => {
    if (!selectedLocationId || isRefreshing || !isOnline) return;
    setIsRefreshing(true);
    try {
      await refetchStock();
      // Also invalidate the query client cache to force fresh data
      await queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'stock-at-location', selectedLocationId) });
    } finally {
      setIsRefreshing(false);
    }
  }, [selectedLocationId, isRefreshing, isOnline, refetchStock, queryClient, tenantId]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
    // Trigger refresh if user pulls down from top of list
    if (deltaY > 80 && scrollTop <= 0) {
      // Fire-and-forget: pull-to-refresh is a UI gesture; errors surface via the
      // refetch's own error state, so the promise is intentionally not awaited.
      void handleRefresh();
    }
  }, [handleRefresh]);

  // ---- Render --------------------------------------------------------------

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Gradient Header */}
      <div className="bg-gradient-to-r from-cyan-600 to-cyan-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5 flex-1">
            <Package size={22} />
            <div>
              <h1 className="text-lg font-bold">View Stock</h1>
              <p className="text-xs text-white/80">
                {selectedLocation ? selectedLocation.name : 'Select a location'}
              </p>
            </div>
          </div>
          {selectedLocationId && isOnline && (
            <button
              onClick={() => { void handleRefresh(); }}
              disabled={isRefreshing}
              className="p-2 rounded-xl hover:bg-white/10 touch-feedback"
            >
              <RefreshCw size={18} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
      </div>

      {/* Location Selector */}
      <div className="px-4 pt-4">
        {/* WHY a group caption, not a <label>: this control is a single-select
            group of location buttons, not one labelable input. A <label> with
            no for-target trips jsx-a11y/label-has-associated-control. The correct
            semantics are a labelled group — the caption id is referenced by the
            button container's aria-labelledby so assistive tech announces the
            group's purpose. */}
        <p
          id="stock-location-selector-label"
          className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2"
        >
          Storage Location
        </p>
        {locationsLoading ? (
          <div className="flex items-center gap-2 py-3">
            <Loader2 size={16} className="animate-spin text-cyan-600" />
            <span className="text-sm text-gray-500">Loading locations...</span>
          </div>
        ) : (
          <div
            role="group"
            aria-labelledby="stock-location-selector-label"
            className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide"
          >
            {locations.map((loc) => (
              <button
                key={loc.id}
                onClick={() => setSelectedLocationId(loc.id)}
                className={clsx(
                  'flex-shrink-0 px-4 py-2.5 rounded-xl border-2 transition-all touch-feedback text-sm font-semibold whitespace-nowrap',
                  selectedLocationId === loc.id
                    ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-300'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400',
                )}
              >
                <MapPin size={14} className="inline mr-1.5" />
                {loc.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Stock List */}
      <div
        ref={scrollContainerRef}
        className="flex-1 px-4 pt-4 overflow-y-auto"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {!selectedLocationId && (
          <div className="text-center py-16 text-gray-400">
            <MapPin size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Select a location</p>
            <p className="text-sm mt-1">Choose a storage location above to view stock</p>
          </div>
        )}

        {selectedLocationId && stockLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={28} className="animate-spin text-cyan-600" />
            <span className="ml-2 text-gray-500 text-sm">Loading stock...</span>
          </div>
        )}

        {selectedLocationId && !stockLoading && stock.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <Package size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No stock at this location</p>
            {!isOnline && (
              <p className="text-sm mt-1">You are offline -- showing cached data</p>
            )}
          </div>
        )}

        {selectedLocationId && !stockLoading && stock.length > 0 && (
          <>
            {/* Pull-to-refresh indicator */}
            {isRefreshing && (
              <div className="flex items-center justify-center py-2 mb-2">
                <Loader2 size={16} className="animate-spin text-cyan-600" />
                <span className="ml-2 text-xs text-gray-500">Refreshing...</span>
              </div>
            )}

            {/* Offline data age indicator */}
            {!isOnline && (
              <div className="mb-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-2.5 flex items-center gap-2 border border-amber-200 dark:border-amber-800">
                <AlertCircle size={14} className="text-amber-500 flex-shrink-0" />
                <span className="text-amber-600 dark:text-amber-300 text-xs">
                  Showing cached data. Pull down to refresh when online.
                </span>
              </div>
            )}

            <div className="space-y-2.5 pb-6">
              {stock.map((item) => {
                const expiryStatus = getExpiryStatus(item.expiryDate);
                return (
                  <div
                    key={item.id}
                    className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate">
                          {item.itemName ?? item.itemType}
                        </h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {item.itemType}
                        </p>
                      </div>
                      <div className="text-right ml-3">
                        <span className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                          {item.quantity}
                        </span>
                        <span className="text-xs text-gray-500 ml-1">{item.unit}</span>
                      </div>
                    </div>

                    {/* Lot + Expiry row */}
                    <div className="flex items-center gap-3 mt-2.5">
                      {item.lotNumber && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-md">
                          Lot: {item.lotNumber}
                        </span>
                      )}
                      {item.expiryDate && (
                        <span
                          className={clsx(
                            'text-xs px-2 py-0.5 rounded-md font-medium',
                            expiryStatus === 'expired' && 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
                            expiryStatus === 'warning' && 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
                            expiryStatus === 'ok' && 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
                          )}
                        >
                          {expiryStatus === 'expired' ? 'EXPIRED' : `Exp: ${formatExpiryDate(item.expiryDate)}`}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
