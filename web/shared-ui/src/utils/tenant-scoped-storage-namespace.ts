/**
 * Tenant-scoped localStorage namespace + pure helpers.
 *
 * Single source of truth for the prefix under which `useTenantScopedStorage`
 * writes per-tenant UI state (MRU lists, report drafts, view prefs). Kept as a
 * dependency-free leaf module (no React) so that:
 *   - the React hook (`hooks/useTenantScopedStorage.ts`) and the logout sweep
 *     (`utils/logout-cleanup.ts`) both import it without an import cycle
 *     (logout-cleanup → hook → useAuth → AuthContext → logout-cleanup), and
 *   - the security-critical key-scoping + sweep logic is unit-testable without
 *     React or a DOM.
 */

/**
 * Namespace prefix for EVERY tenant-scoped localStorage key. `logoutCleanup`
 * sweeps all keys under this prefix so per-tenant — and sometimes PII-bearing
 * (regulatory report drafts) — state can never survive a logout or a tenant
 * switch on a shared browser.
 */
export const TENANT_SCOPED_STORAGE_NAMESPACE = 'aqua.tss';

/**
 * Build the namespaced, tenant-scoped localStorage key for `baseKey`, or `null`
 * when no tenant is resolved (so callers no-op rather than writing un-scoped).
 *
 * Format: `aqua.tss::<tenantId>::<baseKey>` — two tenants can never collide,
 * and every key is reachable by the logout sweep.
 */
export function tenantScopedStorageKey(
  baseKey: string,
  tenantId: string | null | undefined,
): string | null {
  return tenantId ? `${TENANT_SCOPED_STORAGE_NAMESPACE}::${tenantId}::${baseKey}` : null;
}

/**
 * Remove every tenant-scoped key from `storage`. Returns the number removed.
 * Used by `logoutCleanup` so the open-ended per-tenant namespace is cleared on
 * logout (the fixed auth-key deny-list cannot enumerate it).
 */
export function sweepStorageByPrefix(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem'>,
  prefix: string,
): number {
  let removed = 0;
  // Iterate backwards: removeItem shifts the remaining indices down.
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      storage.removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

export function sweepTenantScopedStorage(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem'>,
): number {
  return sweepStorageByPrefix(storage, `${TENANT_SCOPED_STORAGE_NAMESPACE}::`);
}
