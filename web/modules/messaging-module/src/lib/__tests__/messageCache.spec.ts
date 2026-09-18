/**
 * messageCache specs — FAZ 3.2/3.3 DoD: the sorting invariant, dedupe, the
 * 200-item page cap, unread-bump rules (active/inactive/own message), the
 * deleted-marker + preview fix, and the single-point flatten reversal.
 */
import { describe, expect, it } from 'vitest';

import type { Channel, Message } from '../../types/messaging';
import {
  MESSAGES_PAGE_0_CAP,
  applyIncomingMessageToChannels,
  applyMessageDeletedToChannels,
  applyMessageUpdatedToChannels,
  capPageItems,
  flattenChannelMessagesPages,
  insertMessageIntoPage,
  markMessageDeletedInPages,
  updateMessageInPages,
  upsertMessageIntoPages,
  zeroUnreadForChannel,
  type ChannelMessagesPage,
} from '../messageCache';

const CHANNEL = 'cccccccc-3333-4444-8555-666666666666';
const ME = 'bbbbbbbb-2222-4333-8444-555555555555';
const OTHER = 'u2';

function makeMessage(id: string, createdAt: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: CHANNEL,
    senderId: OTHER,
    content: `content-${id}`,
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    createdAt,
    editedAt: null,
    metadata: null,
    sender: null,
    ...overrides,
  };
}

/** A page in SERVER order (newest-first items). */
function makePage(ids: string[], createdAts: string[] = []): ChannelMessagesPage {
  const items = ids.map((id, i) => makeMessage(id, createdAts[i] ?? `2026-09-16T10:0${i}:00Z`));
  return { items, hasMore: false, cursor: null };
}

describe('flattenChannelMessagesPages (single reversal point)', () => {
  it('reverses page order AND within-page order into one oldest-first array', () => {
    // pages[0] = newest window [m3, m2] (newest-first), pages[1] = older [m1, m0].
    const pages = [
      makePage(['m3', 'm2'], ['2026-09-16T10:03:00Z', '2026-09-16T10:02:00Z']),
      makePage(['m1', 'm0'], ['2026-09-16T10:01:00Z', '2026-09-16T10:00:00Z']),
    ];
    expect(flattenChannelMessagesPages(pages).map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('returns [] for empty/undefined pages without throwing', () => {
    expect(flattenChannelMessagesPages(undefined)).toEqual([]);
    expect(flattenChannelMessagesPages([])).toEqual([]);
  });
});

describe('insertMessageIntoPage (comparative sort + dedupe)', () => {
  const PAGE = [
    makeMessage('c', '2026-09-16T10:03:00Z'),
    makeMessage('a', '2026-09-16T10:01:00Z'),
  ];

  it('inserts the NEWEST message at the front (newest-first page)', () => {
    const next = insertMessageIntoPage(PAGE, makeMessage('d', '2026-09-16T10:04:00Z'));
    expect(next.map((m) => m.id)).toEqual(['d', 'c', 'a']);
  });

  it('inserts an out-of-order message at its createdAt slot (arrival order irrelevant)', () => {
    const next = insertMessageIntoPage(PAGE, makeMessage('b', '2026-09-16T10:02:00Z'));
    expect(next.map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  it('REPLACES the row with the same id instead of duplicating (socket echo)', () => {
    const updated = makeMessage('c', '2026-09-16T10:03:00Z', { content: 'edited' });
    const next = insertMessageIntoPage(PAGE, updated);
    expect(next.map((m) => m.id)).toEqual(['c', 'a']);
    expect(next[0]?.content).toBe('edited');
  });

  it('drops the optimistic temp row when the echo carries its idempotencyKey', () => {
    const withTemp = [makeMessage('temp-key-1', '2026-09-16T10:03:30Z'), ...PAGE];
    const echo = makeMessage('srv-9', '2026-09-16T10:03:30Z', { idempotencyKey: 'key-1' });
    const next = insertMessageIntoPage(withTemp, echo);
    expect(next.map((m) => m.id)).toEqual(['srv-9', 'c', 'a']);
  });
});

describe('upsertMessageIntoPages (merge + cap)', () => {
  it('touches only page 0; later pages are untouched', () => {
    const pages = [
      makePage(['m2'], ['2026-09-16T10:02:00Z']),
      makePage(['m1'], ['2026-09-16T10:01:00Z']),
    ];
    const next = upsertMessageIntoPages(pages, makeMessage('m3', '2026-09-16T10:03:00Z'));
    expect(next[0]?.items.map((m) => m.id)).toEqual(['m3', 'm2']);
    expect(next[1]?.items.map((m) => m.id)).toEqual(['m1']);
  });

  it('caps page 0 at 200 items by dropping the OLDEST overflow', () => {
    // Valid ISO timestamps with ms ordering; m199 is the newest.
    const many = Array.from({ length: MESSAGES_PAGE_0_CAP }, (_, i) =>
      makeMessage(`m${i}`, `2026-09-16T10:00:00.${String(i).padStart(3, '0')}Z`),
    );
    // The page keeps SERVER order: newest-first (m199 … m0).
    const newestFirst = [...many].reverse();
    const next = upsertMessageIntoPages(
      [makePage(newestFirst.map((m) => m.id), newestFirst.map((m) => m.createdAt))],
      makeMessage('fresh', '2026-09-16T11:00:00Z'),
    );
    expect(next[0]?.items.length).toBe(MESSAGES_PAGE_0_CAP);
    expect(next[0]?.items[0]?.id).toBe('fresh');
    // The oldest (m0) was trimmed; m1 survives at the tail.
    expect(next[0]?.items[next[0].items.length - 1]?.id).toBe('m1');
  });

  it('returns the same pages untouched when the cache is empty', () => {
    expect(upsertMessageIntoPages([], makeMessage('x', '2026-09-16T10:00:00Z'))).toEqual([]);
  });
});

describe('capPageItems', () => {
  it('slices from the END (oldest in a newest-first page) beyond the cap', () => {
    const items = Array.from({ length: 205 }, (_, i) => makeMessage(`m${i}`, `2026-09-16T10:00:0${i % 10}:00Z`));
    const capped = capPageItems(items);
    expect(capped.length).toBe(MESSAGES_PAGE_0_CAP);
    expect(capped.map((m) => m.id)).toEqual(items.slice(0, MESSAGES_PAGE_0_CAP).map((m) => m.id));
  });
});

describe('updateMessageInPages (messageUpdated)', () => {
  it('updates the id-matched row in place across pages', () => {
    const pages = [
      makePage(['m2', 'm1'], ['2026-09-16T10:02:00Z', '2026-09-16T10:01:00Z']),
      makePage(['m0'], ['2026-09-16T10:00:00Z']),
    ];
    const edited = makeMessage('m0', '2026-09-16T10:00:00Z', { content: 'edited', editedAt: '2026-09-16T10:05:00Z' });
    const next = updateMessageInPages(pages, edited);
    expect(next[1]?.items[0]?.content).toBe('edited');
    expect(next[0]?.items.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('keeps the cached sender when the incoming one is null (no-PII wire sender)', () => {
    const cached = makeMessage('m1', '2026-09-16T10:01:00Z', {
      sender: { id: OTHER, firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null },
    });
    const incoming = makeMessage('m1', '2026-09-16T10:01:00Z', { content: 'edited', sender: null });
    const next = updateMessageInPages([makePage([cached.id], [cached.createdAt]).items.map((m) =>
      m.id === cached.id ? cached : m,
    )].map((items) => ({ items, hasMore: false, cursor: null })), incoming);
    expect(next[0]?.items[0]?.sender?.firstName).toBe('Mehmet');
  });

  it('falls back to a sorted insert when the id is not cached (trimmed page)', () => {
    const pages = [makePage(['m2'], ['2026-09-16T10:02:00Z'])];
    const next = updateMessageInPages(pages, makeMessage('m1', '2026-09-16T10:01:00Z', { content: 'edited' }));
    expect(next[0]?.items.map((m) => m.id)).toEqual(['m2', 'm1']);
  });
});

describe('markMessageDeletedInPages', () => {
  it('marks isDeleted + content:null on the id match only', () => {
    const pages = [makePage(['m2', 'm1'], ['2026-09-16T10:02:00Z', '2026-09-16T10:01:00Z'])];
    const next = markMessageDeletedInPages(pages, 'm1');
    expect(next[0]?.items[1]).toMatchObject({ id: 'm1', isDeleted: true, content: null });
    expect(next[0]?.items[0]?.isDeleted).toBe(false);
  });
});

describe('applyIncomingMessageToChannels (unread bump rules)', () => {
  function makeChannel(id: string, unreadCount: number): Channel {
    return {
      id,
      type: 'DIRECT',
      name: null,
      description: null,
      avatarUrl: null,
      isArchived: false,
      aiPersona: null,
      unreadCount,
      memberCount: 2,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      lastMessage: null,
      members: null,
    };
  }

  const INACTIVE = 'dddddddd-4444-4555-8666-777777777777';
  const channels = (): Channel[] => [makeChannel(CHANNEL, 0), makeChannel(INACTIVE, 2)];

  it('INACTIVE channel: unreadCount +1 and lastMessage moves', () => {
    const message = makeMessage('m9', '2026-09-16T10:09:00Z'); // channelId = CHANNEL
    const next = applyIncomingMessageToChannels(channels(), message, {
      isActiveChannel: false,
      myUserId: ME,
    });
    const bumped = next.find((c) => c.id === CHANNEL);
    expect(bumped?.unreadCount).toBe(1);
    expect(bumped?.lastMessage?.id).toBe('m9');
    expect(next.find((c) => c.id === INACTIVE)?.unreadCount).toBe(2);
  });

  it('ACTIVE channel: preview moves, unread stays (the room is marking it read)', () => {
    const message = makeMessage('m9', '2026-09-16T10:09:00Z');
    const next = applyIncomingMessageToChannels(channels(), message, {
      isActiveChannel: true,
      myUserId: ME,
    });
    expect(next.find((c) => c.id === CHANNEL)?.unreadCount).toBe(0);
    expect(next.find((c) => c.id === CHANNEL)?.lastMessage?.id).toBe('m9');
  });

  it('MY OWN message never bumps unread, even in an inactive channel', () => {
    const mine = makeMessage('m9', '2026-09-16T10:09:00Z', { senderId: ME });
    const next = applyIncomingMessageToChannels(channels(), mine, {
      isActiveChannel: false,
      myUserId: ME,
    });
    expect(next.find((c) => c.id === CHANNEL)?.unreadCount).toBe(0);
  });

  it('treats a null unreadCount as 0 before bumping', () => {
    const list = [makeChannel(CHANNEL, 0)];
    const first = list[0];
    if (!first) throw new Error('fixture channel missing');
    list[0] = { ...first, unreadCount: null };
    const next = applyIncomingMessageToChannels(list, makeMessage('m9', '2026-09-16T10:09:00Z'), {
      isActiveChannel: false,
      myUserId: ME,
    });
    expect(next[0]?.unreadCount).toBe(1);
  });
});

describe('applyMessageUpdatedToChannels / deleted preview fix', () => {
  const base: Channel = {
    id: CHANNEL,
    type: 'DIRECT',
    name: null,
    description: null,
    avatarUrl: null,
    isArchived: false,
    aiPersona: null,
    unreadCount: 0,
    memberCount: 2,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    lastMessage: makeMessage('m2', '2026-09-16T10:02:00Z'),
    members: null,
  };

  it('edit replaces the preview ONLY when the edit targeted the lastMessage', () => {
    const edited = makeMessage('m2', '2026-09-16T10:02:00Z', { content: 'edited' });
    const next = applyMessageUpdatedToChannels([base], edited);
    expect(next[0]?.lastMessage?.content).toBe('edited');

    const olderEdit = makeMessage('m1', '2026-09-16T10:01:00Z', { content: 'older edit' });
    const untouched = applyMessageUpdatedToChannels([base], olderEdit);
    expect(untouched[0]?.lastMessage?.content).toBe('content-m2');
  });

  it('delete of the lastMessage falls back to the newest remaining cached row', () => {
    const pages = [
      makePage(['m2', 'm1'], ['2026-09-16T10:02:00Z', '2026-09-16T10:01:00Z']),
    ];
    const next = applyMessageDeletedToChannels([base], CHANNEL, 'm2', () => pages);
    expect(next[0]?.lastMessage?.id).toBe('m1');
  });

  it('delete with no cached thread falls back to a null preview', () => {
    const next = applyMessageDeletedToChannels([base], CHANNEL, 'm2', () => undefined);
    expect(next[0]?.lastMessage).toBeNull();
  });

  it('delete of a NON-last message leaves the preview alone', () => {
    const next = applyMessageDeletedToChannels([base], CHANNEL, 'm1', () => undefined);
    expect(next[0]?.lastMessage?.id).toBe('m2');
  });
});

describe('zeroUnreadForChannel', () => {
  it('zeroes only the targeted channel', () => {
    const channels: Channel[] = [
      { id: CHANNEL, unreadCount: 3 } as Channel,
      { id: 'dddddddd-4444-4555-8666-777777777777', unreadCount: 5 } as Channel,
    ];
    const next = zeroUnreadForChannel(channels, CHANNEL);
    expect(next[0]?.unreadCount).toBe(0);
    expect(next[1]?.unreadCount).toBe(5);
  });
});
