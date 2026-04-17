/**
 * Hydroponics Configuration hooks
 * Handles queries and mutations for hydroponics configuration via GraphQL API.
 *
 * Follows the same patterns as useHarvestPlans.ts:
 * - useAuth() for token/tenantId
 * - graphqlClient.request() for GraphQL calls
 * - React Query for caching and invalidation
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey } from '@aquaculture/shared-ui';
import {
  CONFIGURATIONS_QUERY,
  CONFIGURATION_QUERY,
  CREATE_CONFIGURATION_MUTATION,
  UPDATE_CONFIGURATION_MUTATION,
  DELETE_CONFIGURATION_MUTATION,
} from '../graphql/hydroponics.operations';

// ============================================================================
// TYPES
// ============================================================================

export interface HydroponicsConfig {
  id: string;
  tenantId: string;
  configName: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHydroponicsConfigInput {
  configName?: string;
  settings?: Record<string, unknown>;
}

export interface UpdateHydroponicsConfigInput {
  id: string;
  configName?: string;
  settings?: Record<string, unknown>;
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

const HYDRO_CONFIG_KEY = 'hydroponicsConfig';

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Hook to list configurations with optional type filter
 */
export function useConfigurations(type?: string) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HYDRO_CONFIG_KEY, 'list', tenantId, type),
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }

      const data = await graphqlClient.request<{ hydroponicsConfigurations: HydroponicsConfig[] }>(
        CONFIGURATIONS_QUERY,
        type ? { type } : {}
      );
      return data.hydroponicsConfigurations;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

/**
 * Hook to fetch a single configuration by ID
 */
export function useConfiguration(id: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HYDRO_CONFIG_KEY, 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ hydroponicsConfiguration: HydroponicsConfig }>(
        CONFIGURATION_QUERY,
        { id }
      );
      return data.hydroponicsConfiguration;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

// ============================================================================
// HELPER: Invalidate all hydroponics config queries
// ============================================================================

function invalidateAllConfigQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({
    predicate: (query) =>
      Array.isArray(query.queryKey) && query.queryKey[0] === HYDRO_CONFIG_KEY,
  });
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Hook to create a new configuration
 */
export function useCreateConfiguration() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateHydroponicsConfigInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createHydroponicsConfiguration: HydroponicsConfig }>(
        CREATE_CONFIGURATION_MUTATION,
        { input }
      );
      return data.createHydroponicsConfiguration;
    },
    onSuccess: () => {
      invalidateAllConfigQueries(queryClient);
    },
  });
}

/**
 * Hook to update an existing configuration
 */
export function useUpdateConfiguration() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateHydroponicsConfigInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateHydroponicsConfiguration: HydroponicsConfig }>(
        UPDATE_CONFIGURATION_MUTATION,
        { input }
      );
      return data.updateHydroponicsConfiguration;
    },
    onSuccess: () => {
      invalidateAllConfigQueries(queryClient);
    },
  });
}

/**
 * Hook to delete a configuration
 */
export function useDeleteConfiguration() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deleteHydroponicsConfiguration: boolean }>(
        DELETE_CONFIGURATION_MUTATION,
        { id }
      );
      return data.deleteHydroponicsConfiguration;
    },
    onSuccess: () => {
      invalidateAllConfigQueries(queryClient);
    },
  });
}
