import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Tank } from '@/types';

// tenantId comes from X-Tenant-Id header (extracted from JWT by backend)
const TANKS_QUERY = `
  query GetTanksWithBatches {
    tanks {
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

async function fetchTanks(): Promise<Tank[]> {
  const result = await graphqlRequest<{ tanks: { items: Tank[]; total: number } }>(TANKS_QUERY);

  if (!result.tanks?.items) {
    throw new Error('Invalid response: no tanks data');
  }

  return result.tanks.items;
}

export function useTanks() {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: ['tanks', tenantId],
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      try {
        const tanks = await fetchTanks();
        // PERF-05: Write to IndexedDB only as an offline fallback.
        // React Query's own gcTime handles in-memory caching for the online path,
        // eliminating the duplicate cache layer.
        await cacheData('tanks', tanks, 1000 * 60 * 60); // 1 hour TTL for offline use
        return tanks;
      } catch (error) {
        // Network failed — return IndexedDB cached data if available
        const cached = await getCachedData<Tank[]>('tanks');
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
