/**
 * Tenant-Scoped Query Key Factory — aquamobil local copy.
 *
 * Mirrors web/shared-ui/src/utils/tenant-query-keys.ts verbatim.
 * aquamobil is a standalone React Native bundle that does NOT
 * depend on @aquaculture/shared-ui (independent toolchain +
 * device bundle size), so the helper is duplicated here rather
 * than imported.
 *
 * Keep in sync with the shared-ui copy. Phase 8.4 of
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md
 * closes FE-CRITICAL-001 on both surfaces in parallel.
 */

/**
 * Root segment prefixing every tenant-scoped query key. Exported as the SSoT so
 * the logout cache wipe (useAuth.tsx) can target the entire tenant key space —
 * `queryClient.removeQueries({ queryKey: [TENANT_QUERY_KEY_ROOT, tenantId] })` —
 * without hardcoding the literal in two places (MT-CRITICAL-050).
 */
export const TENANT_QUERY_KEY_ROOT = 'tenant' as const;

/**
 * Creates a tenant-scoped query key by prepending ['tenant', tenantId]
 * to the provided key segments. All React Query hooks in multi-tenant
 * contexts MUST use this factory instead of bare key arrays.
 *
 * @example
 *   queryKey: createTenantQueryKey(tenantId, 'channels', 'list')
 *   // => ['tenant', 'abc-123', 'channels', 'list']
 *
 * Invalidate all queries for a tenant on logout / switch:
 *   queryClient.removeQueries({ queryKey: [TENANT_QUERY_KEY_ROOT, oldTenantId] });
 */
export function createTenantQueryKey(
  tenantId: string | null | undefined,
  ...segments: readonly unknown[]
): readonly unknown[] {
  // See web/shared-ui/src/utils/tenant-query-keys.ts for the rationale:
  // aquamobil's useAuth (web/apps/aquamobil/src/hooks/useAuth.tsx) also
  // returns `tenantId: string | null`. The `enabled: !!tenantId` guard
  // gates network dispatch while null; accepting the union here avoids
  // sprinkling non-null assertions across every consumer.
  return [TENANT_QUERY_KEY_ROOT, tenantId, ...segments] as const;
}
