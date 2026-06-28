/**
 * Tenant-Scoped Query Key Factory
 *
 * SECURITY: In a multi-tenant SaaS with shared browser sessions (admin
 * impersonation, tenant switching), the React Query cache is global per
 * browser tab. Without tenant-scoped query keys, switching tenants serves
 * stale data from the previous tenant's cache — a cross-tenant data leak.
 *
 * This module provides a single factory function that prefixes every query
 * key with ['tenant', tenantId, ...], ensuring:
 *   1. Cache entries are isolated per tenant
 *   2. Tenant switch invalidates all prior-tenant entries in one call
 *   3. Consistent key structure across all modules
 *
 * @see FE-CRITICAL-014, FE-CRITICAL-015, FE-CRITICAL-016
 */
import { sessionEpochSegment } from './session-epoch';

/**
 * Creates a tenant-scoped query key by prepending ['tenant', tenantId] to
 * the provided key segments. All React Query hooks in multi-tenant contexts
 * MUST use this factory instead of bare key arrays.
 *
 * @param tenantId - The current tenant's unique identifier
 * @param segments - The domain-specific query key segments (e.g., 'dashboard', 'stats')
 * @returns A readonly tuple with tenant prefix: ['tenant', tenantId, ...segments]
 *
 * @example
 * // Before (INSECURE — cross-tenant cache leak):
 * queryKey: ['dashboard', 'stats']
 *
 * // After (tenant-isolated):
 * queryKey: createTenantQueryKey(tenantId, 'dashboard', 'stats')
 * // => ['tenant', 'abc-123', 'dashboard', 'stats']
 *
 * @example
 * // Invalidate ALL queries for a tenant on logout/switch:
 * queryClient.removeQueries({ queryKey: ['tenant', oldTenantId] });
 */
export function createTenantQueryKey(
  tenantId: string | null | undefined,
  ...segments: readonly unknown[]
): readonly unknown[] {
  // `tenantId` is often `string | null` at the call site (useAuth() returns
  // null before authentication resolves). The `enabled: !!tenantId` guard
  // on every migrated useQuery prevents the resulting key from being used
  // to dispatch a network request while null; the cache entry under
  // ['tenant', null, ...] never materialises. Accepting the union at the
  // signature level eliminates the Phase-8.4 migration's type-error sprawl
  // at call sites that cannot narrow without refactoring.
  // Append the session epoch (cache generation) LAST so a tenant (re)entry —
  // e.g. a SUPER_ADMIN A→B→A impersonation round-trip — gets a FRESH generation
  // instead of the same tenant's pre-switch (possibly stale) cache. Appended (not
  // inserted after tenantId) so `domain` stays at index 2 and prefix-based
  // invalidations (['tenant', tenantId, …]) keep matching across generations.
  return ['tenant', tenantId, ...segments, sessionEpochSegment()] as const;
}
