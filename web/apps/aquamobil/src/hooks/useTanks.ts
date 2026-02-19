import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
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

interface GraphQLResponse {
  data?: { tanks: { items: Tank[]; total: number } };
  errors?: Array<{ message: string }>;
}

async function fetchTanks(accessToken: string, tenantId: string): Promise<Tank[]> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': tenantId,
      // SEC-06: CSRF defense header
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      query: TANKS_QUERY,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result = await response.json() as GraphQLResponse;

  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors[0]?.message || 'Failed to fetch tanks');
  }

  if (!result.data?.tanks?.items) {
    throw new Error('Invalid response: no tanks data');
  }

  return result.data.tanks.items;
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
        const tanks = await fetchTanks(accessToken, tenantId);
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
