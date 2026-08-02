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

interface TenantSessionBoundary {
  readonly tenantId: string;
  readonly sessionEpoch: number;
}

function tenantSessionBoundary(queryKey: readonly unknown[]): TenantSessionBoundary | null {
  const tenantId = queryKey[1];
  const epochSegment = queryKey[queryKey.length - 1];

  if (
    queryKey[0] !== 'tenant' ||
    typeof tenantId !== 'string' ||
    tenantId.length === 0 ||
    typeof epochSegment !== 'object' ||
    epochSegment === null ||
    !('__sessionEpoch' in epochSegment) ||
    typeof epochSegment.__sessionEpoch !== 'number' ||
    !Number.isSafeInteger(epochSegment.__sessionEpoch) ||
    epochSegment.__sessionEpoch < 0
  ) {
    return null;
  }

  return { tenantId, sessionEpoch: epochSegment.__sessionEpoch };
}

/**
 * True only when both keys belong to the same authenticated tenant-session
 * generation. Malformed, anonymous, and epoch-less keys fail closed.
 *
 * TanStack Query's generic `keepPreviousData` crosses every query-key change,
 * including tenant and logout/login boundaries. Tenant-aware observers use this
 * predicate before carrying prior data into a new query so pagination remains
 * smooth within one session without exposing a previous principal's cache.
 */
export function hasSameTenantSessionBoundary(
  previousQueryKey: readonly unknown[],
  currentQueryKey: readonly unknown[],
): boolean {
  const previous = tenantSessionBoundary(previousQueryKey);
  const current = tenantSessionBoundary(currentQueryKey);

  return (
    previous !== null &&
    current !== null &&
    previous.tenantId === current.tenantId &&
    previous.sessionEpoch === current.sessionEpoch
  );
}

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

/**
 * Tenant-scoped INVALIDATION prefix — like {@link createTenantQueryKey} but
 * WITHOUT the trailing session-epoch segment. Use this for
 * `invalidateQueries` / `removeQueries`, NOT `createTenantQueryKey`.
 *
 * WHY: `createTenantQueryKey` appends `{ __sessionEpoch }` LAST. As an
 * invalidation filter, TanStack does a LEFT-PREFIX match, so that trailing
 * object lands at the array position a full query key holds its filter/args.
 * A query stored under `['tenant', t, 'systems', 'list', filter, {epoch}]` is
 * therefore NOT matched by `['tenant', t, 'systems', 'list', {epoch}]` — the
 * element at index 4 is `{epoch}` in the filter but `filter` in the stored key.
 * The invalidation silently misses and the list shows stale data until staleTime
 * elapses (the "data doesn't refresh" symptom).
 *
 * This builder returns a clean domain prefix `['tenant', tenantId, ...segments]`
 * with no epoch, which left-prefix-matches EVERY stored key under those domain
 * segments regardless of trailing args or epoch generation. Matching across
 * generations is safe: stale generations are already orphaned + GC'd.
 *
 * RULE:
 *   - `useQuery` key            → `createTenantQueryKey`        (full, epoch'd)
 *   - `invalidate/removeQueries`→ `createTenantInvalidationKey` (prefix, no epoch)
 */
export function createTenantInvalidationKey(
  tenantId: string | null | undefined,
  ...segments: readonly unknown[]
): readonly unknown[] {
  return ['tenant', tenantId, ...segments] as const;
}
