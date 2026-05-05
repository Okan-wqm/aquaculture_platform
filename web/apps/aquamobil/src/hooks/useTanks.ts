import { useQuery } from '@tanstack/react-query';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Tank } from '@/types';

// tenantId comes from X-Tenant-Id header (extracted from JWT by backend)
const TANK_PAGE_SIZE = 100;

const TANKS_QUERY = `
  query GetTanksWithBatches($filter: TankFilterInput) {
    tanks(filter: $filter) {
      items {
        id
        name
        code
        volume
        status
        currentBiomass
        maxBiomass
        batchMetrics {
          batchId
          batchNumber
          pieces
          avgWeight
          biomass
          density
          capacityUsedPercent
          isOverCapacity
          daysSinceStocking
        }
      }
      total
    }
  }
`;

async function fetchTanksPage(offset: number): Promise<{ items: Tank[]; total: number }> {
  const result = await graphqlRequest<{ tanks: { items: Tank[]; total: number } }>(TANKS_QUERY, {
    filter: {
      offset,
      limit: TANK_PAGE_SIZE,
      sortBy: 'name',
      sortOrder: 'ASC',
    },
  });

  if (!result.tanks?.items) {
    throw new Error('Invalid response: no tanks data');
  }

  return result.tanks;
}

export async function fetchAllTanks(): Promise<Tank[]> {
  const tanks: Tank[] = [];
  let total = Number.POSITIVE_INFINITY;

  // WHY: farm-service paginates `tanks` with a default limit of 20 and a max
  // limit of 100. Mobile home/detail/action screens need the complete tenant
  // tank set; otherwise rows that exist in the tenant schema never appear.
  while (tanks.length < total) {
    const page = await fetchTanksPage(tanks.length);
    total = page.total;

    if (page.items.length === 0 && tanks.length < total) {
      throw new Error(`Invalid response: tanks pagination stopped at ${tanks.length} of ${total}`);
    }

    tanks.push(...page.items);
  }

  return tanks;
}

export function useTanks() {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'tanks', tenantId),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      try {
        const tanks = await fetchAllTanks();
        // PERF-05: Write to IndexedDB only as an offline fallback.
        // React Query's own gcTime handles in-memory caching for the online path,
        // eliminating the duplicate cache layer.
        // SECURITY (FE-CRITICAL-002): tenantId required for tenant-isolated caching
        await cacheData(tenantId, 'tanks', tanks, 1000 * 60 * 60); // 1 hour TTL for offline use
        return tanks;
      } catch (error) {
        // Network failed — return IndexedDB cached data if available
        const cached = await getCachedData<Tank[]>(tenantId, 'tanks');
        if (cached) {
          return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 1, // 1 minute — more accurate for live inventory data
    gcTime: 1000 * 60 * 60, // 1 hour in-memory retention
    refetchOnWindowFocus: true, // refresh tank data when returning to the app
  });
}
