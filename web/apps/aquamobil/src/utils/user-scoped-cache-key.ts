/**
 * User-Scoped Cache-Key Factory (SSoT) — MT-CRITICAL-051.
 *
 * WHY this exists:
 *   AquaMobil runs on SHARED field devices. The `cache_${tenantId}:${key}`
 *   namespace in offline-queue.ts isolates cache entries BETWEEN tenants, but
 *   NOT between two users of the SAME tenant on the SAME device. Every `my*`
 *   resolver (mySchedule, myTasks, myLeave*, myAttendance*) returns the CURRENT
 *   USER's private data, yet the historical cache keys encoded only the tenant.
 *   Result: user A's schedule/tasks/leave/attendance were served to user B
 *   offline after a logout→login on the same phone (the IndexedDB half of the
 *   cross-user leak; the React Query in-memory half is closed separately in
 *   useMySchedule et al. by adding user.id to the query key).
 *
 * WHAT this enforces (tier-1 — "make the wrong state impossible"):
 *   A `UserScopedCacheKey` is a BRANDED string that can ONLY be produced by
 *   {@link userScopedCacheKey}, whose first positional parameter is a REQUIRED
 *   `userId: string`. The user-scoped cache I/O helpers
 *   (`cacheUserData` / `getCachedUserData` in offline-queue.ts) accept ONLY this
 *   branded type, so a callsite that forgets the user dimension cannot be
 *   written — it fails to compile rather than leaking at runtime. There is no
 *   way to fabricate the brand without going through this builder.
 *
 * This is the single source of truth for the user partition dimension, the
 * sibling of `createTenantQueryKey` (the tenant partition dimension for React
 * Query keys). One builder, one concern.
 */

/**
 * Branded cache key proving the key embeds a user-id partition. The brand is a
 * compile-time-only phantom field (`unique symbol`) — at runtime the value is a
 * plain string, so it is written to IndexedDB verbatim with zero overhead. It
 * cannot be constructed by string-literal assignment; {@link userScopedCacheKey}
 * is the only producer.
 */
declare const userScopedBrand: unique symbol;
export type UserScopedCacheKey = string & { readonly [userScopedBrand]: true };

/**
 * Build a user-scoped IndexedDB cache key. The `userId` is REQUIRED and is
 * embedded as the first key segment, so two users of the same tenant never
 * share a cache namespace on a shared device.
 *
 * @example
 *   userScopedCacheKey(user.id, 'schedule', weekStartDate)
 *   // => 'u:<userId>:schedule:<weekStartDate>'  (branded UserScopedCacheKey)
 *
 * @param userId   - Current authenticated user id (REQUIRED partition dimension)
 * @param segments - Domain-specific key segments (e.g. 'schedule', a date)
 * @throws {Error} when `userId` is empty — a blank partition would collapse
 *   every user back onto one namespace, re-introducing the exact leak this SSoT
 *   prevents, so an empty id is a programmer error and fails loudly rather than
 *   silently degrading isolation.
 */
export function userScopedCacheKey(
  userId: string,
  ...segments: readonly (string | number)[]
): UserScopedCacheKey {
  if (!userId) {
    throw new Error(
      'userScopedCacheKey: userId is required — a user-scoped cache must encode the user partition',
    );
  }
  return `u:${userId}:${segments.join(':')}` as UserScopedCacheKey;
}
