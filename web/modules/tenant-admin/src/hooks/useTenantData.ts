/**
 * Custom Hooks for Tenant Admin Data
 *
 * Uses TanStack Query for data fetching and caching.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getMyTenant,
  getTenantStats,
  getMyTenantModules,
  getTenantUsers,
  getTenantDatabase,
  assignModuleManager,
  removeModuleManager,
  updateTenantSettings,
  type Tenant,
  type TenantStats,
  type TenantModule,
  type User,
  type TenantDatabaseInfo,
} from '../services/tenant-api.service';

// ============================================================================
// Query Keys
// ============================================================================

export const tenantKeys = {
  all: ['tenant'] as const,
  tenant: () => [...tenantKeys.all, 'info'] as const,
  stats: () => [...tenantKeys.all, 'stats'] as const,
  modules: () => [...tenantKeys.all, 'modules'] as const,
  users: (filters?: Record<string, unknown>) =>
    [...tenantKeys.all, 'users', filters] as const,
  database: () => [...tenantKeys.all, 'database'] as const,
};

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to get current tenant information
 */
export function useMyTenant() {
  return useQuery({
    queryKey: tenantKeys.tenant(),
    queryFn: getMyTenant,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get tenant statistics
 */
export function useTenantStats() {
  return useQuery({
    queryKey: tenantKeys.stats(),
    queryFn: getTenantStats,
    staleTime: 1 * 60 * 1000, // 1 minute
    refetchInterval: 60 * 1000, // Refetch every minute
  });
}

/**
 * Hook to get tenant modules
 */
export function useTenantModules() {
  return useQuery({
    queryKey: tenantKeys.modules(),
    queryFn: getMyTenantModules,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get tenant users
 */
export function useTenantUsers(options?: {
  status?: string;
  role?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: tenantKeys.users(options),
    queryFn: () => getTenantUsers(options),
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
}

/**
 * Hook to get tenant database information
 */
export function useTenantDatabase() {
  return useQuery({
    queryKey: tenantKeys.database(),
    queryFn: getTenantDatabase,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to assign module manager
 */
export function useAssignModuleManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ moduleId, userId }: { moduleId: string; userId: string }) =>
      assignModuleManager(moduleId, userId),
    onSuccess: () => {
      // Invalidate modules query to refetch
      queryClient.invalidateQueries({ queryKey: tenantKeys.modules() });
    },
  });
}

/**
 * Hook to remove module manager
 */
export function useRemoveModuleManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (moduleId: string) => removeModuleManager(moduleId),
    onSuccess: () => {
      // Invalidate modules query to refetch
      queryClient.invalidateQueries({ queryKey: tenantKeys.modules() });
    },
  });
}

/**
 * Hook to update tenant settings
 */
export function useUpdateTenantSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      input: Partial<
        Pick<
          Tenant,
          'name' | 'description' | 'logoUrl' | 'contactEmail' | 'contactPhone' | 'address' | 'settings'
        >
      >,
    ) => updateTenantSettings(input),
    onSuccess: (data) => {
      // Update tenant cache
      queryClient.setQueryData(tenantKeys.tenant(), data);
    },
  });
}

// ============================================================================
// Re-export types
// ============================================================================

export type { Tenant, TenantStats, TenantModule, User, TenantDatabaseInfo };
