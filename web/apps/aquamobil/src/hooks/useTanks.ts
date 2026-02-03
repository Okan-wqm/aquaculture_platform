import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import type { Tank } from '@/types';

// tenantId comes from X-Tenant-Id header (extracted from JWT by backend)
const TANKS_QUERY = `
  query GetTanksWithBatches {
    tanks(filter: { status: ACTIVE }) {
      id
      name
      code
      volumeM3
      status
      currentBatch {
        id
        batchNumber
        speciesName
        currentQuantity
        averageWeight
        currentBiomassKg
        status
      }
    }
  }
`;

interface GraphQLResponse {
  data?: { tanks: Tank[] };
  errors?: Array<{ message: string }>;
}

async function fetchTanks(accessToken: string, tenantId: string): Promise<Tank[]> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': tenantId,
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

  if (!result.data?.tanks) {
    throw new Error('Invalid response: no tanks data');
  }

  return result.data.tanks;
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
        // Try to fetch from network
        const tanks = await fetchTanks(accessToken, tenantId);
        // Cache for offline use
        await cacheData('tanks', tanks, 1000 * 60 * 60); // 1 hour TTL
        return tanks;
      } catch (error) {
        // Fall back to cached data
        const cached = await getCachedData<Tank[]>('tanks');
        if (cached) {
          return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 60, // 1 hour
  });
}
