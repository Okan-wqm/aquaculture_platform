/**
 * Session epoch — a monotonic cache-generation counter.
 *
 * WHY: tenant-scoped query keys (`['tenant', tenantId, …]`) isolate tenant A's
 * cache from tenant B's, but they do NOT distinguish two SESSIONS of the SAME
 * tenant. On a SUPER_ADMIN impersonation round-trip (A → B → A), switching back
 * to A reproduces A's exact key, so React Query serves A's PRE-switch cache —
 * which may be stale (it predates the excursion through B). The epoch is bumped
 * on every ACTUAL tenant change and on logout, and `createTenantQueryKey` weaves
 * the current value into every key, so each tenant (re)entry gets a FRESH cache
 * generation — the prior generation's entries are structurally orphaned and
 * garbage-collected. Defence-in-depth atop the tenant-scoped key prefix + the
 * logout `queryClient.clear()`.
 *
 * The epoch is appended (not inserted after tenantId) so the `domain` segment
 * stays at index 2 — `resolveStaleTime` and prefix-based
 * `invalidateQueries({ queryKey: ['tenant', tenantId, …] })` are unaffected.
 *
 * Module-level state is shared across all Module Federation remotes because
 * `web/shared-ui` is a federation singleton (federationSharedConfig).
 */

/** Opaque marker appended to every tenant-scoped query key. */
export interface SessionEpochSegment {
  readonly __sessionEpoch: number;
}

let sessionEpoch = 0;

/** Current cache generation. */
export function getSessionEpoch(): number {
  return sessionEpoch;
}

/** The trailing query-key segment carrying the current generation. */
export function sessionEpochSegment(): SessionEpochSegment {
  return { __sessionEpoch: sessionEpoch };
}

/**
 * Advance the cache generation. Call on an ACTUAL tenant change and on logout.
 * Returns the new value (useful for tests/observability).
 */
export function bumpSessionEpoch(): number {
  sessionEpoch += 1;
  return sessionEpoch;
}
