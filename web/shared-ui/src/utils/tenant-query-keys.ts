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
  tenantId: string,
  ...segments: readonly unknown[]
): readonly unknown[] {
  return ['tenant', tenantId, ...segments] as const;
}
