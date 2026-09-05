/**
 * Tenant Hooks
 *
 * Hooks for fetching tenant data used by TenantSelect, TenantMultiSelect,
 * and other components that need tenant lists.
 */

import { useCallback } from 'react';
import { useAsyncData } from './useAsyncData';
import { tenantsApi, TenantStatus } from '../services/adminApi';
import type { Tenant } from '../services/types';

// ============================================================================
// Types
// ============================================================================

/** Lightweight tenant info used in selectors */
interface TenantOption {
  id: string;
  name: string;
  tier: string;
  status: string;
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Fetch active tenants for use in selectors.
 * Returns a flattened list of { id, name, tier, status }.
 */
export function useActiveTenants() {
  const fetcher = useCallback(async () => {
    const result = await tenantsApi.list({ status: TenantStatus.ACTIVE, limit: 500 });
    const tenants: TenantOption[] = result.data.map((t: Tenant) => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      status: t.status,
    }));
    return tenants;
  }, []);

  const asyncResult = useAsyncData<TenantOption[]>(fetcher, {
    cacheKey: 'active-tenants',
    cacheTTL: 60000, // 1 minute cache for tenant list
  });

  return {
    data: asyncResult.data,
    isLoading: asyncResult.loading,
    error: asyncResult.error,
    refetch: asyncResult.refresh,
  };
}

/**
 * Search tenants by name.
 */
export function useTenantSearch(query: string) {
  const fetcher = useCallback(async () => {
    if (!query || query.length < 2) return [];
    const result = await tenantsApi.search(query, 20);
    return (result || []).map((t: Tenant) => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      status: t.status,
    }));
  }, [query]);

  const asyncResult = useAsyncData<TenantOption[]>(fetcher, {
    immediate: query.length >= 2,
    cacheKey: query.length >= 2 ? `tenant-search-${query}` : undefined,
    cacheTTL: 15000,
  });

  return {
    data: asyncResult.data,
    isLoading: asyncResult.loading,
    error: asyncResult.error,
  };
}

export type { TenantOption };
