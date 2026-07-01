/**
 * messaging-query-keys — cache-key SSoT invariants (MSG-CRITICAL-055 regression guard).
 *
 * The bug: the reader (useMessages) addressed the per-channel message cache with
 * a user-scoped key `[...,'messages', user.id, channelId]` (MT-CRITICAL-051) while
 * every live/optimistic writer addressed a user.id-less key, so live messages,
 * edits, deletes, receipts, reconnect reconcile, and optimistic sends all wrote
 * to a cache entry nothing read. These tests pin the two invariants that make
 * that drift impossible:
 *   1. the read key and every write key are ONE factory output, so they are
 *      byte-for-byte identical for the same (tenant, user, channel);
 *   2. the family/invalidation prefix is a true prefix of the granular key, so a
 *      fire-and-forget invalidateQueries reaches the reader (React Query matches
 *      invalidation keys by prefix).
 */

import { describe, it, expect } from 'vitest';

import { messagesQueryKey, messagesFamilyKey } from '../messaging-query-keys';
import { TENANT_QUERY_KEY_ROOT } from '../tenant-query-keys';

const TENANT = 'tenant-abc';
const USER = 'user-123';
const CHANNEL = 'chan-9';

describe('messaging-query-keys — cache-key SSoT (MSG-CRITICAL-055)', () => {
  it('messagesQueryKey embeds the tenant prefix, then user.id, then channelId in fixed order', () => {
    expect(messagesQueryKey(TENANT, USER, CHANNEL)).toEqual([
      TENANT_QUERY_KEY_ROOT,
      TENANT,
      'messaging',
      'messages',
      USER,
      CHANNEL,
    ]);
  });

  it('is tenant-prefixed by construction (FE-CRITICAL-001 discipline upheld)', () => {
    const key = messagesQueryKey(TENANT, USER, CHANNEL);
    expect(key[0]).toBe(TENANT_QUERY_KEY_ROOT);
    expect(key[1]).toBe(TENANT);
  });

  it('the family key is a true prefix of the granular key, so invalidation reaches the reader', () => {
    const family = messagesFamilyKey(TENANT);
    const granular = messagesQueryKey(TENANT, USER, CHANNEL);
    // React Query invalidateQueries matches by array prefix: every element of
    // `family` must equal the same-index element of `granular`.
    expect(granular.slice(0, family.length)).toEqual([...family]);
  });

  it('the family key stops BEFORE the user.id/channelId slots (no channelId in the user.id slot)', () => {
    // The ChatRoomPage delete bug was `[...,'messages', channelId]` — channelId in
    // the user.id slot, which is NOT a prefix of the reader key. The family key
    // must be exactly `[...,'messages']`.
    expect(messagesFamilyKey(TENANT)).toEqual([
      TENANT_QUERY_KEY_ROOT,
      TENANT,
      'messaging',
      'messages',
    ]);
  });

  it('two callers with the same (tenant,user,channel) produce identical keys (reader == writer)', () => {
    const readerKey = messagesQueryKey(TENANT, USER, CHANNEL);
    const writerKey = messagesQueryKey(TENANT, USER, CHANNEL);
    expect(writerKey).toEqual(readerKey);
  });

  it('a different user.id yields a DIFFERENT key (shared-device membership isolation, MT-CRITICAL-051)', () => {
    expect(messagesQueryKey(TENANT, 'user-A', CHANNEL)).not.toEqual(
      messagesQueryKey(TENANT, 'user-B', CHANNEL),
    );
  });
});
