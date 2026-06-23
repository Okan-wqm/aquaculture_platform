import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createTenantQueryKey, graphqlClient, useAuth } from '@aquaculture/shared-ui';

import {
  fetchMarineLayers,
  type MarineLayerDefinition,
  type MarineLayerId,
} from '../services/marineDataService';

interface SentinelHubStatus {
  isConfigured: boolean;
}

const SENTINEL_HUB_STATUS_QUERY = `
  query SentinelHubStatus {
    sentinelHubStatus {
      isConfigured
    }
  }
`;

export function useMarineLayers() {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'marine-data', 'layers'),
    queryFn: fetchMarineLayers,
    enabled: Boolean(isAuthenticated && tenantId),
    staleTime: 10 * 60 * 1000,
  });
}

export function useSentinelCredentialStatus() {
  const { tenantId, isAuthenticated } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'marine-data', 'sentinel-credential-status'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ sentinelHubStatus: SentinelHubStatus }>(
        SENTINEL_HUB_STATUS_QUERY,
      );
      return data.sentinelHubStatus.isConfigured;
    },
    enabled: Boolean(isAuthenticated && tenantId),
    staleTime: 60 * 1000,
  });
}

export function useMarineLayerLookup(layers: readonly MarineLayerDefinition[] | undefined) {
  return useMemo(() => {
    const byId = new Map<MarineLayerId, MarineLayerDefinition>();
    for (const layer of layers ?? []) {
      byId.set(layer.id, layer);
    }
    return byId;
  }, [layers]);
}
