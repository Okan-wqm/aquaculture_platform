import { useMemo } from 'react';

import {
  TENANT_SCOPED_STORAGE_NAMESPACE,
  tenantScopedStorageKey,
} from '../utils/tenant-scoped-storage-namespace';

// Re-export so consumers can `import { TENANT_SCOPED_STORAGE_NAMESPACE } from
// '@aquaculture/shared-ui'` alongside the hook. SSoT lives in the leaf module.
export { TENANT_SCOPED_STORAGE_NAMESPACE };

export interface TenantScopedStorage<T> {
  /** Read + JSON-parse the value, or `null` when absent or no tenant is resolved. */
  read(): T | null;
  /** JSON-serialize + write the value. No-op when no tenant is resolved. */
  write(value: T): void;
  /** Remove this tenant's value. No-op when no tenant is resolved. */
  remove(): void;
}

/**
 * The ONE sanctioned accessor for per-tenant browser-local UI state (MRU
 * lists, drafts, view preferences).
 *
 * Why this hook exists (root-cause of the cross-tenant browser-storage leak
 * class): per-tenant state written with a flat constant key leaks across
 * tenants on a shared browser and survives logout. This hook makes the
 * correct behaviour structural:
 *
 *   - the key is namespaced AND tenant-scoped by construction
 *     (`aqua.tss::<tenantId>::<baseKey>`), so two tenants can never collide;
 *   - it NO-OPS without a resolved tenant, so nothing is ever written
 *     un-scoped (e.g. before login or after logout);
 *   - `logoutCleanup` sweeps the whole `aqua.tss::` namespace, so nothing
 *     survives logout / tenant switch.
 *
 * The returned accessor object is referentially stable across renders for a
 * given (tenant, baseKey), so it is safe to list in `useMemo`/`useEffect`/
 * `useCallback` dependency arrays.
 *
 * `tenantId` is supplied BY THE CALLER (from its own auth context) rather than
 * read internally, so the hook is auth-context-agnostic: the web shell passes
 * `useAuth().tenantId` from `@aquaculture/shared-ui`, while AquaMobil passes
 * `tenantId` from its own `useAuth` — both get correct isolation. Pass `null`
 * (e.g. before login) and every accessor no-ops.
 */
export function useTenantScopedStorage<T>(
  baseKey: string,
  tenantId: string | null | undefined,
): TenantScopedStorage<T> {
  return useMemo<TenantScopedStorage<T>>(() => {
    const key = tenantScopedStorageKey(baseKey, tenantId);

    return {
      read(): T | null {
        if (!key) return null;
        try {
          const raw = localStorage.getItem(key);
          if (raw === null) return null;
          const parsed: unknown = JSON.parse(raw);
          return parsed as T;
        } catch {
          return null;
        }
      },
      write(value: T): void {
        if (!key) return;
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {
          // localStorage quota exceeded / unavailable — non-fatal for UI prefs.
        }
      },
      remove(): void {
        if (!key) return;
        try {
          localStorage.removeItem(key);
        } catch {
          // localStorage unavailable — non-fatal.
        }
      },
    };
  }, [tenantId, baseKey]);
}
