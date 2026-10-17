/**
 * Tenant-scoped query keys for the dashboard's per-site queries.
 *
 * WHY: one site row reads several sources per site (useQueries), which
 * useTenantQuery — one query per call — cannot express. These keys are built
 * the way useTenantQuery builds its own: createTenantQueryKey over the
 * authenticated tenant (prefix + session epoch, FE-CRITICAL-014/015/016), and
 * nothing is fetched until a tenant session exists.
 */
import { createTenantInvalidationKey, createTenantQueryKey, useAuth } from '@aquaculture/shared-ui';
import { useCallback } from 'react';

export interface TenantKeys {
  /** The tenant-scoped key for these segments. */
  readonly key: (...segments: readonly unknown[]) => readonly unknown[];
  /** The prefix that invalidates every dashboard query under these segments. */
  readonly invalidation: (...segments: readonly unknown[]) => readonly unknown[];
  /** Whether a tenant session exists, the condition every query fires on. */
  readonly session: boolean;
}

export function useTenantKeys(): TenantKeys {
  const { token, tenantId } = useAuth();
  const authenticated = token && tenantId ? tenantId : null;
  const key = useCallback(
    (...segments: readonly unknown[]): readonly unknown[] =>
      createTenantQueryKey(authenticated, 'dashboard', ...segments),
    [authenticated],
  );
  const invalidation = useCallback(
    (...segments: readonly unknown[]): readonly unknown[] =>
      createTenantInvalidationKey(authenticated, 'dashboard', ...segments),
    [authenticated],
  );
  return { key, invalidation, session: authenticated !== null };
}
