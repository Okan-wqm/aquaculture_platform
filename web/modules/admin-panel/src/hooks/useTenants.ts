/**
 * Tenant Hooks
 *
 * Hooks for fetching tenant data used by TenantSelect, TenantMultiSelect,
 * and other components that need tenant lists.
 */

import { useAdminQuery } from './useAdminQuery';
import { adminKeys } from './adminQueryKeys';
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
 *
 * On the shell's `QueryClient` (ADMIN-HIGH-121): the selectors that consume
 * this appear inside pages whose own reads are already there, and a tenant
 * roster held in a second, module-scoped cache is one more thing
 * `logoutCleanup()` has to remember. `error` is returned so a caller can say
 * the roster failed rather than showing an empty dropdown.
 */
const ACTIVE_TENANT_FILTERS = { status: TenantStatus.ACTIVE, limit: 500 } as const;

export function useActiveTenants(): {
  data: TenantOption[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const query = useAdminQuery<TenantOption[]>(
    adminKeys.tenants.list(ACTIVE_TENANT_FILTERS),
    async () => {
      const result = await tenantsApi.list({ ...ACTIVE_TENANT_FILTERS });
      return result.data.map((t: Tenant) => ({
        id: t.id,
        name: t.name,
        tier: t.tier,
        status: t.status,
      }));
    },
    { staleTime: 60_000 },
  );

  return {
    data: query.data,
    isLoading: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Search tenants by name.
 *
 * On the shell's `QueryClient` like the roster above, keyed by the query so
 * two searches cannot overwrite each other's result. The read is skipped
 * below two characters — the endpoint's own minimum — rather than fired and
 * discarded.
 */
export function useTenantSearch(query: string): {
  data: TenantOption[] | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const enabled = query.length >= 2;
  const result = useAdminQuery<TenantOption[]>(
    adminKeys.tenants.list({ search: query }),
    async ({ signal }) => {
      const found = await tenantsApi.search(query, 20, signal);
      return found.map((t: Tenant) => ({
        id: t.id,
        name: t.name,
        tier: t.tier,
        status: t.status,
      }));
    },
    { enabled, staleTime: 15_000 },
  );

  return {
    data: enabled ? result.data : [],
    isLoading: enabled && result.isPending,
    error: result.error,
  };
}

export type { TenantOption };
