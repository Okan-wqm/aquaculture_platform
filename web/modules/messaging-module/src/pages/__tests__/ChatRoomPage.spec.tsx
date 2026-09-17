/**
 * ChatRoomPage specs — FAZ 1 Görev 1/2/3 wiring at the page level.
 *
 * Covers the acceptance-criteria surfaces: optimistic send visible before the
 * server answers and settled exactly once after; failed send shows a
 * role="alert" code-aware banner, restores the draft and rolls the optimistic
 * bubble back; the banner clears on the next send and self-dismisses;
 * markMessagesRead obeys the document-visibility gate and defers until the
 * thread has data; the DM heading excludes my own name; the socket status
 * indicator appears while disconnected.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { fireSocketEvent, resetSocketMock } from '../../test-utils/mockSocketIo';
import { requestMock, TEST_USER_ID } from '../../test-utils/sharedUiMock';
import type { Channel, Message } from '../../types/messaging';
import ChatRoomPage from '../ChatRoomPage';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);
vi.mock('socket.io-client', async () =>
  (await import('../../test-utils/mockSocketIo')).socketIoModuleMock(),
);

const CHANNEL = 'cccccccc-3333-4444-8555-666666666666';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeMessage(id: string, content: string, senderId: string): Message {
  return {
    id,
    channelId: CHANNEL,
    senderId,
    content,
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    createdAt: '2026-09-16T10:00:00Z',
    editedAt: null,
    sender: null,
  };
}

const MY_NAME = 'Panel Operator';
const OTHER_NAME = 'Mehmet Demir';

const CHANNEL_FIXTURE: Channel = {
  id: CHANNEL,
  type: 'DIRECT',
  name: null,
  description: null,
  avatarUrl: null,
  isArchived: false,
  aiPersona: null,
  unreadCount: 2,
  memberCount: 2,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  lastMessage: null,
  members: [
    {
      id: 'm1',
      userId: TEST_USER_ID,
      role: 'MEMBER',
      user: { id: TEST_USER_ID, firstName: 'Panel', lastName: 'Operator', profileImageUrl: null },
    },
    {
      id: 'm2',
      userId: 'u2',
      role: 'MEMBER',
      user: { id: 'u2', firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null },
    },
  ],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mutable server-side fixture the routes read from (see makeServerFixture). */
interface ServerFixture {
  serverMessages: Message[];
  channelsResult: () => Record<string, unknown>;
  messagesResult: () => Record<string, unknown>;
  routeQueries(): void;
}

/**
 * Page fixture: mutable server-side thread the routes read from — the send
 * route appends to it BEFORE resolving so the post-send refetch (invalidation)
 * sees the new message, exactly like the real backend.
 */
function makeServerFixture(): ServerFixture {
  const serverMessages: Message[] = [
    makeMessage('srv-0', 'earlier', 'u2'),
    makeMessage('srv-1', 'latest from other', 'u2'),
  ];
  const channelsResult = (): Record<string, unknown> => ({
    myChannels: { total: 1, items: [CHANNEL_FIXTURE] },
  });
  const messagesResult = (): Record<string, unknown> => ({
    messages: { hasMore: false, cursor: null, items: [...serverMessages].reverse() },
  });
  return {
    serverMessages,
    channelsResult,
    messagesResult,
    routeQueries(): void {
      routeGraphql([
        { match: 'query MyChannels', result: channelsResult },
        { match: 'query ChannelMessages', result: messagesResult },
        { match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } },
      ]);
    },
  };
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderRoom(queryClient: QueryClient): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/${CHANNEL}`]}>
        <Routes>
          <Route path="/:channelId" element={<ChatRoomPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState');
}

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>('Message');
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
}

/** The variables of one captured GraphQL call, typed for member access. */
interface CapturedVariables {
  input?: { channelId?: unknown; messageId?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/** The requestMock call log, cast once at the transport seam (typed downstream). */
function capturedCalls(): Array<[string, CapturedVariables | undefined]> {
  return requestMock.mock.calls as Array<[string, CapturedVariables | undefined]>;
}

function sendInputs(): Array<CapturedVariables['input'] | undefined> {
  return capturedCalls()
    .filter(([query]) => query.includes('mutation SendMessage'))
    .map(([, variables]) => variables?.input);
}

function markReadInputs(): Array<CapturedVariables['input'] | undefined> {
  return capturedCalls()
    .filter(([query]) => query.includes('mutation MarkMessagesRead'))
    .map(([, variables]) => variables?.input);
}

/**
 * graphql-request ClientError with a contractual code — an Error instance
 * (react-query rejects with Errors) carrying the response envelope shape
 * FAZ 0's graphqlErrors readers walk.
 */
function clientError(code: string): Error {
  return Object.assign(new Error('GraphQL Error'), {
    name: 'ClientError',
    response: { errors: [{ message: 'refused', extensions: { code } }] },
  });
}

beforeEach(() => {
  requestMock.mockReset();
  resetSocketMock();
  sessionStorage.clear();
  restoreVisibility();
});

afterEach(() => {
  restoreVisibility();
  vi.useRealTimers();
});

describe('ChatRoomPage', () => {
  it('renders the thread and a DM heading that EXCLUDES my own name', async () => {
    const fx = makeServerFixture();
    fx.routeQueries();
    renderRoom(newQueryClient());

    expect(await screen.findByText('latest from other')).toBeVisible();
    // The derived DM title names the other member, never MY name.
    await waitFor(() => expect(screen.getByText(OTHER_NAME)).toBeVisible());
    expect(screen.queryByText(new RegExp(MY_NAME, 'i'))).not.toBeInTheDocument();
  });

  it('sends with a valid idempotencyKey and shows the message optimistically, settling exactly once', async () => {
    const fx = makeServerFixture();
    fx.routeQueries();
    const pending = deferred<Record<string, unknown>>();
    routeGraphql([
      { match: 'query MyChannels', result: fx.channelsResult },
      { match: 'query ChannelMessages', result: fx.messagesResult },
      { match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } },
      { match: 'mutation SendMessage', result: () => pending.promise },
    ]);
    renderRoom(newQueryClient());
    await screen.findByText('latest from other');

    fireEventChangeAndSend('optimistic hello');

    // Optimistic: visible BEFORE the server answers.
    expect(await screen.findByText('optimistic hello')).toBeVisible();

    // The server persists, THEN resolves (the invalidation refetch must see it).
    const serverMessage = makeMessage('srv-2', 'optimistic hello', TEST_USER_ID);
    fx.serverMessages.push(serverMessage);
    act(() => {
      pending.resolve({ sendMessage: serverMessage });
    });

    // Settled: exactly one copy of the message after refetch + replacement.
    await waitFor(() => expect(screen.getAllByText('optimistic hello')).toHaveLength(1));

    // The input carried a valid idempotencyKey (backend requires ID!).
    expect(sendInputs()[0]).toMatchObject({
      channelId: CHANNEL,
      content: 'optimistic hello',
      contentType: 'TEXT',
    });
    expect(String(sendInputs()[0]?.idempotencyKey)).toMatch(UUID_RE);
    // Draft cleared on success.
    expect(composer().value).toBe('');
  });

  it('failed send: visible role="alert" banner with rate-limit copy, draft restored, optimistic bubble rolled back', async () => {
    const fx = makeServerFixture();
    fx.routeQueries();
    routeGraphql([
      { match: 'query MyChannels', result: fx.channelsResult },
      { match: 'query ChannelMessages', result: fx.messagesResult },
      { match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } },
      {
        match: 'mutation SendMessage',
        result: () => Promise.reject(clientError('TOO_MANY_REQUESTS')),
      },
    ]);
    renderRoom(newQueryClient());
    await screen.findByText('latest from other');

    fireEventChangeAndSend('will fail');

    const banner = await screen.findByRole('alert');
    expect(banner).toBeVisible();
    // Code-aware copy (TOO_MANY_REQUESTS → rate-limit message), not a raw dump.
    expect(banner.textContent).toContain('too fast');
    // Draft restored for an easy retry.
    expect(composer().value).toBe('will fail');
    // The optimistic bubble was rolled back — the message body shows no
    // phantom send (the composer textarea itself legitimately holds the draft).
    const chatBody = document.querySelector('.sd-chat-body') as HTMLElement;
    await waitFor(() => expect(within(chatBody).queryByText('will fail')).not.toBeInTheDocument());
  });

  it('the banner clears when the next send is attempted', async () => {
    const fx = makeServerFixture();
    fx.routeQueries();
    routeGraphql([
      { match: 'query MyChannels', result: fx.channelsResult },
      { match: 'query ChannelMessages', result: fx.messagesResult },
      { match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } },
      { match: 'mutation SendMessage', result: () => Promise.reject(clientError('NOT_FOUND')) },
    ]);
    renderRoom(newQueryClient());
    await screen.findByText('latest from other');

    fireEventChangeAndSend('first attempt');
    expect(await screen.findByRole('alert')).toBeVisible();

    // Next attempt succeeds → the banner is gone immediately on send.
    routeGraphql([
      { match: 'query MyChannels', result: fx.channelsResult },
      { match: 'query ChannelMessages', result: fx.messagesResult },
      { match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } },
      {
        match: 'mutation SendMessage',
        result: () => {
          const okMessage = makeMessage('srv-9', 'second attempt', TEST_USER_ID);
          fx.serverMessages.push(okMessage);
          return { sendMessage: okMessage };
        },
      },
    ]);
    fireEventChangeAndSend('second attempt');
    await screen.findByText('second attempt');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the banner self-dismisses after the grace period', async () => {
    vi.useFakeTimers();
    const fx = makeServerFixture();
    routeGraphql([
      { match: 'query MyChannels', result: fx.channelsResult },
      { match: 'query ChannelMessages', result: fx.messagesResult },
      { match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } },
      { match: 'mutation SendMessage', result: () => Promise.reject(clientError('FORBIDDEN')) },
    ]);
    renderRoom(newQueryClient());

    await act(async () => {
      fireEventChangeAndSend('no access');
      await Promise.resolve(); // flush the rejected send's microtasks under fake timers
    });
    expect(screen.getByRole('alert')).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('markMessagesRead fires for the LAST message while the tab is visible', async () => {
    const fx = makeServerFixture();
    fx.routeQueries();
    renderRoom(newQueryClient());
    await screen.findByText('latest from other');

    await waitFor(() => expect(markReadInputs().length).toBeGreaterThanOrEqual(1));
    expect(markReadInputs()[0]).toEqual({
      channelId: CHANNEL,
      messageId: 'srv-1', // the newest message in the thread
    });
  });

  it('markMessagesRead is GATED while the tab is hidden and fires on visibilitychange', async () => {
    setVisibility('hidden');
    const fx = makeServerFixture();
    fx.routeQueries();
    renderRoom(newQueryClient());
    await screen.findByText('latest from other');
    expect(markReadInputs()).toHaveLength(0);

    setVisibility('visible');
    await waitFor(() => expect(markReadInputs().length).toBeGreaterThanOrEqual(1));
    expect(markReadInputs()[0]).toEqual({ channelId: CHANNEL, messageId: 'srv-1' });
  });

  it('markMessagesRead DEFERS while the thread has no data (empty channel)', async () => {
    const fx = makeServerFixture();
    fx.serverMessages.length = 0;
    fx.routeQueries();
    renderRoom(newQueryClient());

    expect(await screen.findByText('No messages yet')).toBeVisible();
    expect(markReadInputs()).toHaveLength(0);
  });

  it('shows a role="status" reconnecting indicator until the socket connects', async () => {
    const fx = makeServerFixture();
    fx.routeQueries();
    renderRoom(newQueryClient());
    await screen.findByText('latest from other');

    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');

    act(() => fireSocketEvent('connect'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => fireSocketEvent('disconnect'));
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
  });
});

function fireEventChangeAndSend(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(sendButton());
}
