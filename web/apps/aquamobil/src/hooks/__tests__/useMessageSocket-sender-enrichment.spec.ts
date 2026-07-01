/**
 * useMessageSocket sender enrichment — MSG-MEDIUM-052 (WS-half).
 *
 * The live WS envelope carries `sender:{id}` only (no-PII oracle — the gateway's
 * `getMessageForBroadcast` never broadcasts display PII to channel members). The
 * `newMessage` and `messageUpdated` handlers enrich the sender's display name
 * from the channelMembers cache (federation-resolved firstName/lastName) before
 * writing it into the message cache, so a live message / edit from another user
 * renders the real name instead of "Unknown" — without the wire ever carrying a
 * name. These tests drive the captured Socket.IO handlers directly and apply the
 * captured cache-updater to a seed cache to inspect the written message.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Minimal cache shapes (no `any`).
// --------------------------------------------------------------------------
interface TestSender {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
}
interface TestMessage {
  id: string;
  channelId: string;
  senderId: string;
  sender?: TestSender;
  content: string;
  contentType: string;
  createdAt: string;
}
interface TestPage {
  items: TestMessage[];
  hasMore: boolean;
  cursor: string | null;
}
interface TestCache {
  pages: TestPage[];
  pageParams: (string | null)[];
}

// --------------------------------------------------------------------------
// Controllable fake Socket.IO socket — captures registered event handlers.
// --------------------------------------------------------------------------
type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();

const fakeSocket = {
  connected: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: (event: string, handler: Handler) => handlers.set(event, handler),
  off: vi.fn(),
  emit: vi.fn(),
  auth: {} as Record<string, unknown>,
};
const mockIo = vi.fn(() => fakeSocket);
vi.mock('socket.io-client', () => ({ io: mockIo }));

// --------------------------------------------------------------------------
// Dependency mocks
// --------------------------------------------------------------------------
const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockGetQueryData = vi.fn<(key: unknown) => unknown>();

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'token-1',
    isAuthenticated: true,
    tenantId: 'tenant-1',
    // MSG-CRITICAL-055: the message cache key is user-scoped; MESSAGES_KEY below
    // carries this user.id so the enrichment writes land on the reader's key.
    user: { id: 'user-1' },
    refreshAuth: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  );
  return {
    ...actual,
    useQueryClient: () => ({
      setQueryData: mockSetQueryData,
      invalidateQueries: mockInvalidateQueries,
      getQueryData: mockGetQueryData,
    }),
  };
});

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Import after mocks.
import { useMessageSocket } from '../useMessageSocket';

const CHANNEL = 'chan-7';
const MEMBERS_KEY = ['tenant', 'tenant-1', 'messaging', 'channelMembers', CHANNEL, 'tenant-1'];
// MSG-CRITICAL-055: user.id ('user-1') is part of the messages key between
// 'messages' and the channelId — the same key useMessages reads.
const MESSAGES_KEY = ['tenant', 'tenant-1', 'messaging', 'messages', 'user-1', CHANNEL];

interface TestMember {
  userId: string;
  user?: TestSender;
}

/** Make getQueryData answer the channelMembers key with `members`. */
function seedMembers(members: TestMember[]): void {
  mockGetQueryData.mockImplementation((key: unknown) =>
    JSON.stringify(key) === JSON.stringify(MEMBERS_KEY) ? members : undefined,
  );
}

/** The captured messages-cache updater for this channel (asserts it fired). */
function messagesUpdater(): (old: TestCache | undefined) => TestCache | undefined {
  const call = mockSetQueryData.mock.calls.find(
    (c) => JSON.stringify(c[0]) === JSON.stringify(MESSAGES_KEY),
  );
  if (!call) throw new Error('no setQueryData call for the messages cache key');
  return call[1] as (old: TestCache | undefined) => TestCache | undefined;
}

function emptyCache(): TestCache {
  return { pages: [{ items: [], hasMore: false, cursor: null }], pageParams: [null] };
}

/** Apply the updater to `old` and return the newest item of the first page. */
function lastWritten(old: TestCache): TestMessage {
  const next = messagesUpdater()(old);
  const items = next?.pages[0]?.items;
  const item = items?.[items.length - 1];
  if (!item) throw new Error('no message written into the cache');
  return item;
}

/** Apply the updater to `old` and return the first item of the first page. */
function firstWritten(old: TestCache): TestMessage {
  const next = messagesUpdater()(old);
  const item = next?.pages[0]?.items[0];
  if (!item) throw new Error('no message in the updated cache');
  return item;
}

function fire(event: 'newMessage' | 'messageUpdated', message: TestMessage): void {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`socket handler '${event}' not registered`);
  act(() => handler({ channelId: CHANNEL, message }));
}

function baseMessage(over: Partial<TestMessage>): TestMessage {
  return {
    id: 'm1',
    channelId: CHANNEL,
    senderId: 'u1',
    sender: { id: 'u1' },
    content: 'hi',
    // S1-CODEGEN: wire contentType is the UPPERCASE GraphQL enum NAME.
    contentType: 'TEXT',
    createdAt: '2026-06-13T12:00:00.000Z',
    ...over,
  };
}

describe('useMessageSocket — sender enrichment (MSG-MEDIUM-052 WS-half)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    mockGetQueryData.mockReturnValue(undefined);
  });
  afterEach(() => cleanup());

  it('enriches an id-only live sender from the channelMembers cache', async () => {
    seedMembers([{ userId: 'u1', user: { id: 'u1', firstName: 'Alice', lastName: 'Smith' } }]);
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('newMessage')).toBeDefined());

    fire('newMessage', baseMessage({ id: 'm1', sender: { id: 'u1' } }));

    expect(lastWritten(emptyCache()).sender).toMatchObject({
      id: 'u1',
      firstName: 'Alice',
      lastName: 'Smith',
    });
  });

  it('leaves an already-named sender untouched (GraphQL / M3 path)', async () => {
    // A stale member name must NOT override a sender that already carries a name.
    seedMembers([{ userId: 'u1', user: { id: 'u1', firstName: 'Stale', lastName: 'Name' } }]);
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('newMessage')).toBeDefined());

    fire('newMessage', baseMessage({ id: 'm2', sender: { id: 'u1', firstName: 'Alice', lastName: 'Smith' } }));

    expect(lastWritten(emptyCache()).sender).toMatchObject({ firstName: 'Alice', lastName: 'Smith' });
  });

  it('leaves the sender id-only when the member is not cached (graceful)', async () => {
    seedMembers([]); // channel never opened → no member list
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('newMessage')).toBeDefined());

    fire('newMessage', baseMessage({ id: 'm3', senderId: 'ghost', sender: { id: 'ghost' } }));

    expect(lastWritten(emptyCache()).sender).toEqual({ id: 'ghost' });
  });

  it('preserves the federation name on a live EDIT (messageUpdated does not overwrite with id-only)', async () => {
    seedMembers([{ userId: 'u1', user: { id: 'u1', firstName: 'Alice', lastName: 'Smith' } }]);
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('messageUpdated')).toBeDefined());

    // The cache already holds m1 with a federation-resolved sender name.
    const existing: TestCache = {
      pages: [
        {
          items: [baseMessage({ id: 'm1', sender: { id: 'u1', firstName: 'Alice', lastName: 'Smith' }, content: 'original' })],
          hasMore: false,
          cursor: null,
        },
      ],
      pageParams: [null],
    };

    // The WS edit envelope carries sender:{id} only.
    fire('messageUpdated', baseMessage({ id: 'm1', sender: { id: 'u1' }, content: 'edited' }));

    const updated = firstWritten(existing);
    expect(updated.content).toBe('edited');
    expect(updated.sender).toMatchObject({ id: 'u1', firstName: 'Alice', lastName: 'Smith' });
  });
});
