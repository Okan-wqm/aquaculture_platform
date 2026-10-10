/**
 * Messaging query-key SSoT — the per-channel message infinite-query cache family.
 *
 * MSG-CRITICAL-055: the reader (`useMessages`) and every live/optimistic writer
 * (`useMessageSocket` newMessage / messageUpdated / messageDeleted / readReceipt
 * + the reconnect reconcile, `useSendMessage`'s optimistic insert) MUST address
 * the SAME cache entry. MT-CRITICAL-051 added `userId` to the READ key for
 * shared-device membership isolation, but the writers were left on a
 * `userId`-less key, so every live message / edit / delete / receipt and every
 * optimistic bubble landed in a cache entry nothing read — the open chat never
 * converged live and the socket specs pinned the wrong (writer) key.
 *
 * This module is the single definition of that key shape. Both helpers build ON
 * TOP of `createTenantQueryKey`, so the tenant-prefix invariant (FE-CRITICAL-001)
 * is upheld by construction. Because `messagesQueryKey` has FIXED arity
 * `(tenantId, userId, channelId)`, a caller that drops the `userId` segment now
 * fails to compile — the exact drift MSG-CRITICAL-055 was is made impossible
 * (tier-1), where the previous variadic `createTenantQueryKey(...,'messages',channelId)`
 * silently accepted the wrong number of segments.
 */
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/**
 * The exact React Query key for one channel's message infinite-query cache.
 * The reader (`useMessages`) and every `setQueryData` writer address this key.
 *
 * `userId` is a REQUIRED positional argument (accepting null/undefined only for
 * the pre-auth window, when the reader is `enabled:false` anyway). Omitting the
 * argument is a compile-time error — the drift class MSG-CRITICAL-055 fixed.
 */
export function messagesQueryKey(
  tenantId: string | null | undefined,
  userId: string | null | undefined,
  channelId: string | null | undefined,
): readonly unknown[] {
  return createTenantQueryKey(tenantId, 'messaging', 'messages', userId, channelId);
}

/**
 * The prefix that partial-matches EVERY channel's `messagesQueryKey` regardless
 * of `userId`/`channelId` — for fire-and-forget `invalidateQueries` (React Query
 * matches invalidation keys by prefix). A key that appended `channelId` here
 * would place it in the `userId` slot and fail to prefix-match the reader — the
 * exact ChatRoomPage online-delete miss under MSG-CRITICAL-055.
 */
export function messagesFamilyKey(tenantId: string | null | undefined): readonly unknown[] {
  return createTenantQueryKey(tenantId, 'messaging', 'messages');
}
