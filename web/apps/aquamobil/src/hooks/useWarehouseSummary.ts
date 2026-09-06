import { useQuery } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import { GET_WAREHOUSE_SUMMARY } from '@/graphql/operations';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { WarehouseSummary } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// WHY 1h TTL: warehouse data changes a few times per day (stock movements).
// Keeping stale data available offline for 1 hour lets field workers see
// approximate stock levels even without connectivity.
const CACHE_TTL_1H = 1000 * 60 * 60;

// WHY default constant: avoids re-creating the object on every render cycle
// while the authoritative query is still loading.
const DEFAULT_SUMMARY: WarehouseSummary = {
  totalItems: 0,
  lowStockAlertCount: 0,
  todaysMovementCount: 0,
  lowStockItems: [],
  recentMovements: [],
  feedCoverage: [],
};

/**
 * Fetches warehouse KPI data for the Warehouse hub page.
 *
 * WHY single query: unlike DailyOpsStats which aggregates 4 sources, the
 * warehouse hub gets all its data from one backend aggregate resolver. This
 * keeps the hook simple — one useQuery with IndexedDB offline fallback.
 *
 * Pattern follows useTanks.ts: network-first with IndexedDB fallback.
 */
export function useWarehouseSummary(): {
  summary: WarehouseSummary;
  isLoading: boolean;
} {
  const { tenantId, isAuthenticated } = useAuth();

  const cacheKey = `warehouseSummary-${tenantId}`;

  const { data, isLoading } = useQuery<WarehouseSummary>({
    // Tenant izolasyonu anahtar fabrikasının ['tenant', tenantId, ...] ön
    // ekinden gelir — payload segmentinde tenantId tekrarı kaldırıldı
    // (FARM-LOW-236 anahtar hijyeni).
    queryKey: createTenantQueryKey(tenantId, 'warehouseSummary'),
    queryFn: async () => {
      // WHY guard-throw: `enabled` gates execution on tenantId but does not
      // narrow its type to string. An explicit throw narrows it for the
      // tenant-isolated cache calls below without a non-null assertion.
      if (!tenantId) throw new Error('useWarehouseSummary: tenantId is required');
      try {
        const result = await graphqlRequest(
          GET_WAREHOUSE_SUMMARY,
        );
        const summary = result.warehouseSummary;

        // WHY fire-and-forget cache write: IndexedDB serves as offline fallback
        // only. React Query's gcTime handles the in-memory caching layer.
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId, cacheKey, summary, CACHE_TTL_1H);
        return summary;
      } catch (error) {
        // WHY IndexedDB fallback first: warehouse staff on fish farms often
        // have spotty connectivity. Showing stale stock levels is better than
        // showing nothing.
        const cached = await getCachedData<WarehouseSummary>(tenantId, cacheKey);
        if (cached) return cached;

        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    // WHY 5min staleTime: warehouse movements happen a few times per day.
    // 5 minutes keeps the data reasonably fresh without aggressive refetching.
    staleTime: 1000 * 60 * 5,
    // WHY 30min gcTime: the warehouse hub is a secondary page. 30 minutes
    // of in-memory retention covers typical browse-and-return navigation.
    gcTime: 1000 * 60 * 30,
  });

  return { summary: data ?? DEFAULT_SUMMARY, isLoading };
}
