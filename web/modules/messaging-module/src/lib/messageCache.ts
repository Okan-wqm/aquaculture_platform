/**
 * Pure cache-shape helpers for the messaging panel (FAZ 3.2/3.3).
 *
 * The messages cache is an INFINITE query whose pages keep the SERVER's native
 * per-page order (newest-first items, pages[0] = newest window, later pages
 * progressively older via cursor). The render-side oldest-first invariant is
 * established at exactly ONE point — flattenChannelMessagesPages — which
 * reverses page order AND within-page item order. Every write (WS merge,
 * optimistic send, delete) goes through these helpers so the invariant and the
 * 200-item page-0 cap hold on every path. No React, no network: unit-testable.
 */
import type { Channel, Message } from '../types/messaging';

/** One page of the infinite messages query (server shape; items newest-first). */
export interface ChannelMessagesPage {
  items: Message[];
  hasMore: boolean;
  cursor: string | null;
}

/**
 * FAZ 3.2 pages cap: a live stream must not grow pages[0] unboundedly while a
 * room stays open — beyond 200 rows the OLDEST items are dropped (they remain
 * fetchable again through cursor pagination).
 */
export const MESSAGES_PAGE_0_CAP = 200;

/**
 * Chronological comparison by createdAt. ISO-8601 strings compare correctly
 * lexicographically; Date.parse is the fallback for non-ISO edge values so a
 * malformed timestamp never crashes a cache write.
 */
export function compareByCreatedAt(a: Message, b: Message): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  }
  return ta - tb;
}

/**
 * THE single reversal point (FAZ 3.3 sorting invariant): pages are stored in
 * server order (pages[0] newest window, items newest-first); flattening walks
 * pages oldest-window-first and reverses each page's items, producing one
 * oldest-first array for rendering. Out-of-order arrivals are tolerated by the
 * comparative insert below — this flatten NEVER re-sorts.
 */
export function flattenChannelMessagesPages(
  pages: readonly ChannelMessagesPage[] | undefined,
): Message[] {
  if (!pages?.length) return [];
  const out: Message[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    const page = pages[i];
    if (!page) continue;
    for (let j = page.items.length - 1; j >= 0; j -= 1) {
      out.push(page.items[j] as Message);
    }
  }
  return out;
}

/**
 * Insert `incoming` into a NEWEST-FIRST items array at its createdAt position
 * (comparative — out-of-order arrival lands in the right slot), dropping any
 * row with the same id first (socket echo / idempotent replay dedupe) and the
 * matching optimistic temp row when the wire echo carries its idempotencyKey.
 */
export function insertMessageIntoPage(items: readonly Message[], incoming: Message): Message[] {
  const tempId = incoming.idempotencyKey ? `temp-${incoming.idempotencyKey}` : null;
  const kept = items.filter(
    (m) => m.id !== incoming.id && (tempId === null || m.id !== tempId),
  );
  let index = 0;
  while (index < kept.length && compareByCreatedAt(kept[index] as Message, incoming) >= 0) {
    index += 1;
  }
  return [...kept.slice(0, index), incoming, ...kept.slice(index)];
}

/** Drop the page's oldest overflow (items are newest-first → overflow is at the end). */
export function capPageItems(items: readonly Message[], cap = MESSAGES_PAGE_0_CAP): Message[] {
  return items.length > cap ? items.slice(0, cap) : [...items];
}

/**
 * Merge one message into the infinite cache: replace-or-insert on page 0
 * (dedupe + comparative sort + cap), leaving older pages untouched.
 */
export function upsertMessageIntoPages(
  pages: readonly ChannelMessagesPage[] | undefined,
  message: Message,
): ChannelMessagesPage[] {
  if (!pages?.length) return pages ? [...pages] : [];
  return pages.map((page, index) =>
    index === 0
      ? { ...page, items: capPageItems(insertMessageIntoPage(page.items, message)) }
      : { ...page },
  );
}

/**
 * In-place update of an existing row (messageUpdated): id-matched spread
 * across all pages. The incoming sender is preferred ONLY when enriched — an
 * id-only/absent wire sender must not wipe the cached display name
 * (no-PII oracle note; mobile MSG-MEDIUM-052 parity).
 */
export function updateMessageInPages(
  pages: readonly ChannelMessagesPage[] | undefined,
  incoming: Message,
): ChannelMessagesPage[] {
  if (!pages?.length) return pages ? [...pages] : [];
  let found = false;
  const next = pages.map((page) => ({
    ...page,
    items: page.items.map((m) => {
      if (m.id !== incoming.id) return m;
      found = true;
      // Sticky delete (V1 B9): a parallel-dispatched edit arriving after a
      // tombstone must not resurrect the message — the wire edit predates the
      // delete in channel order.
      if (m.isDeleted && !incoming.isDeleted) return m;
      return { ...m, ...incoming, sender: incoming.sender ?? m.sender };
    }),
  }));
  // An edit of a message the cache never held (page trimmed / fresh cache):
  // fall through to a sorted insert instead of silently dropping the edit.
  return found ? next : upsertMessageIntoPages(next, incoming);
}

/**
 * Soft-delete marker (messageDeleted): isDeleted + content:null. The room
 * already filters deleted rows; the marker keeps the id stable for later
 * refetch convergence.
 */
export function markMessageDeletedInPages(
  pages: readonly ChannelMessagesPage[] | undefined,
  messageId: string,
): ChannelMessagesPage[] {
  if (!pages?.length) return pages ? [...pages] : [];
  return pages.map((page) => ({
    ...page,
    items: page.items.map((m) =>
      m.id === messageId ? { ...m, isDeleted: true, content: null } : m,
    ),
  }));
}

// ----------------------------------------------------------------------------
// Channels cache mutations (unread badge + lastMessage preview, FAZ 3.2)
// ----------------------------------------------------------------------------

/**
 * Apply a live incoming message to the channel list cache — NO refetch:
 *  - lastMessage preview moves to the incoming message;
 *  - unreadCount +1 only when the channel is NOT the open one AND the sender
 *    is someone else (my own message never counts as unread for me).
 */
export function applyIncomingMessageToChannels(
  channels: readonly Channel[] | undefined,
  message: Message,
  options: { isActiveChannel: boolean; myUserId: string | null | undefined },
): Channel[] {
  if (!channels) return [];
  return channels.map((channel) => {
    if (channel.id !== message.channelId) return channel;
    const bumpUnread =
      !options.isActiveChannel && message.senderId !== options.myUserId;
    return {
      ...channel,
      lastMessage: message,
      unreadCount: bumpUnread ? (channel.unreadCount ?? 0) + 1 : channel.unreadCount,
      updatedAt: message.createdAt,
    };
  });
}

/** Replace the list preview only when the edit targeted the current lastMessage. */
export function applyMessageUpdatedToChannels(
  channels: readonly Channel[] | undefined,
  message: Message,
): Channel[] {
  if (!channels) return [];
  return channels.map((channel) =>
    channel.id === message.channelId && channel.lastMessage?.id === message.id
      ? { ...channel, lastMessage: message, updatedAt: message.createdAt }
      : channel,
  );
}

/**
 * Deleting a message fixes the preview: when the deleted row WAS the
 * lastMessage, fall back to the newest remaining non-deleted row of that
 * channel's loaded pages (when cached — the deleted row itself excluded),
 * else null — the next natural channels fetch converges on server truth.
 */
export function applyMessageDeletedToChannels(
  channels: readonly Channel[] | undefined,
  channelId: string,
  messageId: string,
  /** Lazily-read thread pages of the affected channel (may be uncached). */
  readPages: () => readonly ChannelMessagesPage[] | undefined,
): Channel[] {
  if (!channels) return [];
  return channels.map((channel) => {
    if (channel.id !== channelId || channel.lastMessage?.id !== messageId) return channel;
    const remaining = flattenChannelMessagesPages(readPages()).filter(
      (m) => !m.isDeleted && m.id !== messageId,
    );
    const replacement = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    return { ...channel, lastMessage: replacement };
  });
}

/** Snap one channel's unread badge to 0 (own read receipt confirmed by server). */
export function zeroUnreadForChannel(
  channels: readonly Channel[] | undefined,
  channelId: string,
): Channel[] {
  if (!channels) return [];
  return channels.map((channel) =>
    channel.id === channelId ? { ...channel, unreadCount: 0 } : channel,
  );
}
