/**
 * The internal note delivered to the customer, the broadcast that could only
 * ever 400, and the platform's own replies drawn as the tenant's
 * (ADMIN-CRITICAL-157).
 *
 * The composer had a working Internal Note toggle and posted no `isInternal`,
 * so every note an admin wrote ABOUT a customer went INTO that customer's
 * thread. The Bulk Message dialog promised "all active tenants" and sent no
 * audience at all — the one body `sendBulkMessage` refuses — and wrote the
 * refusal to `console.error`. And the page keyed alignment, colour and the
 * read receipt on a `senderType` this service has never written.
 *
 * These tests pin each of those to the wire, because that is where every one
 * of them was invisible.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { MessagingPage } from '../MessagingPage';
import { supportApi, tenantsApi } from '../../services/adminApi';
import type {
  BulkMessageResult,
  CreatedMessageThread,
  MessageThreadSummary,
  MessagingStats,
  PaginatedResult,
  SupportMessage,
} from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    tenantsApi: { list: vi.fn() },
    supportApi: {
      getMessageThreads: vi.fn(),
      getMessagingStats: vi.fn(),
      getThreadMessages: vi.fn(),
      sendSupportMessage: vi.fn(),
      markAsRead: vi.fn(),
      closeThread: vi.fn(),
      reopenThread: vi.fn(),
      archiveThread: vi.fn(),
      createThread: vi.fn(),
      sendBulkMessage: vi.fn(),
    },
  };
});

const threadList = vi.mocked(supportApi.getMessageThreads);
const stats = vi.mocked(supportApi.getMessagingStats);
const threadMessages = vi.mocked(supportApi.getThreadMessages);
const sendMessage = vi.mocked(supportApi.sendSupportMessage);
const markAsRead = vi.mocked(supportApi.markAsRead);
const closeThread = vi.mocked(supportApi.closeThread);
const createThread = vi.mocked(supportApi.createThread);
const sendBulk = vi.mocked(supportApi.sendBulkMessage);
const tenantList = vi.mocked(tenantsApi.list);

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

/** Complete, as the contract declares it — no cast. */
function thread(overrides: Partial<MessageThreadSummary> = {}): MessageThreadSummary {
  return {
    id: THREAD_ID,
    tenantId: TENANT_ID,
    tenantName: 'Kuzey Su',
    subject: 'Oxygen probe drifting on pond 3',
    lastMessage: 'It reads 2 mg/L below the handheld.',
    lastMessageAt: '2026-09-10T08:00:00.000Z',
    unreadCount: 2,
    messageCount: 4,
    isClosed: false,
    ...overrides,
  };
}

function threadPage(
  rows: MessageThreadSummary[],
  total?: number,
): PaginatedResult<MessageThreadSummary> {
  return {
    data: rows,
    total: total ?? rows.length,
    page: 1,
    limit: 100,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

/** Complete, as the contract declares it — `senderType: 'admin'`, `fileName`, `fileSize`. */
function message(overrides: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: 'msg-1',
    threadId: THREAD_ID,
    senderId: '33333333-3333-4333-8333-333333333333',
    senderType: 'tenant_admin',
    senderName: 'Deniz',
    content: 'It reads 2 mg/L below the handheld.',
    status: 'read',
    isInternal: false,
    emailSent: false,
    createdAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  };
}

function messagePage(
  rows: SupportMessage[],
  extra: Partial<PaginatedResult<SupportMessage>> = {},
): PaginatedResult<SupportMessage> {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit: 50,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
    ...extra,
  };
}

function statsFixture(overrides: Partial<MessagingStats> = {}): MessagingStats {
  return {
    totalThreads: 12,
    activeThreads: 9,
    closedThreads: 3,
    totalMessages: 140,
    unreadMessages: 5,
    avgResponseTimeMinutes: 45,
    ...overrides,
  };
}

/** Complete, as the contract declares it — no `messages`, because the create reply has none. */
function createdThread(): CreatedMessageThread {
  return {
    id: THREAD_ID,
    tenantId: TENANT_ID,
    subject: 'Welcome',
    messageCount: 1,
    unreadAdminCount: 0,
    unreadTenantCount: 1,
    isArchived: false,
    isClosed: false,
    createdAt: '2026-09-10T09:00:00.000Z',
    updatedAt: '2026-09-10T09:00:00.000Z',
  };
}

function bulkResult(overrides: Partial<BulkMessageResult> = {}): BulkMessageResult {
  return { sent: 40, failed: 0, threadIds: [], ...overrides };
}

function tenantPage(): Awaited<ReturnType<typeof tenantsApi.list>> {
  return {
    data: [
      {
        id: TENANT_ID,
        name: 'Kuzey Su',
        slug: 'kuzey-su',
        status: 'active',
        tier: 'enterprise',
        userCount: 24,
        farmCount: 3,
        sensorCount: 48,
        isTrialActive: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    limit: 500,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessagingPage />
    </QueryClientProvider>,
  );
}

async function openThread(): Promise<void> {
  const actor = userEvent.setup();
  await actor.click(await screen.findByText('Oxygen probe drifting on pond 3'));
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom does not implement scrollIntoView, which the message pane's
  // auto-scroll uses. Same stub as tenant-admin's TenantMessagesPage spec.
  Element.prototype.scrollIntoView = vi.fn();
  threadList.mockResolvedValue(threadPage([thread()]));
  stats.mockResolvedValue(statsFixture());
  threadMessages.mockResolvedValue(messagePage([message()]));
  markAsRead.mockResolvedValue(undefined);
  tenantList.mockResolvedValue(tenantPage());
});

describe('MessagingPage composer', () => {
  it('puts the internal-note toggle on the wire', async () => {
    sendMessage.mockResolvedValue(message({ id: 'msg-2', senderType: 'admin', isInternal: true }));
    renderPage();
    const actor = userEvent.setup();

    await openThread();
    await actor.click(await screen.findByRole('button', { name: 'Public Message' }));
    await actor.type(await screen.findByLabelText('Reply'), 'Probe is out of calibration');
    await actor.click(screen.getByRole('button', { name: 'Send message' }));

    // The regression: the toggle styled the draft and was never sent, so the
    // note was delivered to the tenant as an ordinary message.
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      content: 'Probe is out of calibration',
      isInternal: true,
    });
  });

  it('sends a public message as public', async () => {
    sendMessage.mockResolvedValue(message({ id: 'msg-2', senderType: 'admin' }));
    renderPage();
    const actor = userEvent.setup();

    await openThread();
    await actor.type(await screen.findByLabelText('Reply'), 'Looking into it');
    await actor.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      content: 'Looking into it',
      isInternal: false,
    });
  });

  it('never signs the message on the client', async () => {
    sendMessage.mockResolvedValue(message({ id: 'msg-2', senderType: 'admin' }));
    renderPage();
    const actor = userEvent.setup();

    await openThread();
    await actor.type(await screen.findByLabelText('Reply'), 'Looking into it');
    await actor.click(screen.getByRole('button', { name: 'Send message' }));

    // It used to send `senderName: 'Admin'`, and the handler PREFERRED it over
    // the authenticated user — so every message the platform ever wrote is
    // signed "Admin".
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty('senderName');
  });

  it('names a refused reply, where it used to be silent', async () => {
    sendMessage.mockRejectedValue(new Error('reply rejected: capability support-ops required'));
    renderPage();
    const actor = userEvent.setup();

    await openThread();
    await actor.type(await screen.findByLabelText('Reply'), 'Looking into it');
    await actor.click(screen.getByRole('button', { name: 'Send message' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('capability support-ops required'))).toBe(
      true,
    );
  });
});

describe('MessagingPage message rendering', () => {
  it("attributes an 'admin' message to the platform, not the tenant", async () => {
    threadMessages.mockResolvedValue(
      messagePage([message({ senderType: 'admin', senderName: 'ops@suderra.com' })]),
    );
    renderPage();
    await openThread();

    // The regression: the test was `senderType === 'super_admin'`, a value
    // this service has never written, so the platform's own replies drew as
    // inbound tenant messages and no read receipt ever drew.
    const bubble = (await screen.findByText('ops@suderra.com')).closest('div.max-w-2xl');
    expect(bubble).not.toBeNull();
    expect(bubble?.className).toContain('bg-blue-600');
    expect(within(bubble as HTMLElement).getByText('Read')).toBeInTheDocument();
  });

  it('reports a failed send as failed, not as unread', async () => {
    threadMessages.mockResolvedValue(
      messagePage([
        message({ senderType: 'admin', senderName: 'ops@suderra.com', status: 'failed' }),
      ]),
    );
    renderPage();
    await openThread();

    // `'failed'` was missing from the panel's status union, so a message that
    // never left drew as one awaiting a read.
    expect(await screen.findByText('Failed to send')).toBeInTheDocument();
  });

  it('renders an attachment with the name and size the wire sends', async () => {
    threadMessages.mockResolvedValue(
      messagePage([
        message({
          attachments: [
            {
              id: 'att-1',
              fileName: 'probe-log.csv',
              fileSize: 2048,
              mimeType: 'text/csv',
              url: 'https://files.example/probe-log.csv',
              uploadedAt: '2026-09-10T08:00:00.000Z',
            },
          ],
        }),
      ]),
    );
    renderPage();
    await openThread();

    // It read `filename` and `size`: every attachment was a nameless "NaN MB".
    expect(await screen.findByText('probe-log.csv')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('says how much of a long thread it is showing, and reaches the newest page', async () => {
    threadMessages.mockImplementation((_id, params) =>
      Promise.resolve(
        messagePage([message({ id: `msg-p${params?.page ?? 1}` })], {
          total: 128,
          page: params?.page ?? 1,
          totalPages: 3,
        }),
      ),
    );
    renderPage();
    await openThread();

    // A 128-message thread used to hand over its OLDEST 50 with nothing to say
    // so, under a header printing 128 from another query.
    expect(await screen.findByText(/128 messages — page 3 of 3/)).toBeInTheDocument();
    await waitFor(() => expect(threadMessages.mock.calls.at(-1)?.[1]?.page).toBe(3));
  });

  it('forwards an abort signal to the thread read', async () => {
    renderPage();
    await openThread();

    await waitFor(() => expect(threadMessages).toHaveBeenCalled());
    expect(threadMessages.mock.calls[0]?.[0]).toBe(THREAD_ID);
    expect(threadMessages.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it('names a failed message read and claims no empty thread', async () => {
    threadMessages.mockRejectedValue(new Error('thread is unreachable'));
    renderPage();
    await openThread();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('thread is unreachable'))).toBe(true);
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  });
});

describe('MessagingPage broadcast', () => {
  it('names an audience the route accepts, where it used to send none', async () => {
    sendBulk.mockResolvedValue(bulkResult());
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Bulk Message/ }));
    await actor.type(screen.getByLabelText('Subject'), 'Planned maintenance');
    await actor.type(screen.getByLabelText('Message Content'), 'Sunday 02:00–04:00 UTC.');
    await actor.click(screen.getByRole('button', { name: 'Send broadcast' }));

    // The regression: neither `tenantIds` nor `targetCriteria`, which is the
    // one body the route refuses — every broadcast answered 400.
    await waitFor(() => expect(sendBulk).toHaveBeenCalled());
    expect(sendBulk.mock.calls[0]?.[0]).toEqual({
      subject: 'Planned maintenance',
      content: 'Sunday 02:00–04:00 UTC.',
      targetCriteria: {},
      sendEmail: true,
    });
  });

  it('reports a partial broadcast as partial', async () => {
    sendBulk.mockResolvedValue(bulkResult({ sent: 3, failed: 397 }));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Bulk Message/ }));
    await actor.type(screen.getByLabelText('Subject'), 'Planned maintenance');
    await actor.type(screen.getByLabelText('Message Content'), 'Sunday.');
    await actor.click(screen.getByRole('button', { name: 'Send broadcast' }));

    // The reply was typed `void` and discarded: 3 of 400 closed the dialog
    // exactly like 400 of 400.
    expect(
      await screen.findByText('Broadcast partially delivered: 3 sent, 397 failed.'),
    ).toBeInTheDocument();
  });

  it('narrows to one picked tenant rather than a typed id', async () => {
    sendBulk.mockResolvedValue(bulkResult({ sent: 1 }));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Bulk Message/ }));
    await actor.selectOptions(screen.getByLabelText('Audience'), 'selected');
    await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
    await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
    await actor.type(screen.getByLabelText('Subject'), 'Invoice question');
    await actor.type(screen.getByLabelText('Message Content'), 'Could you confirm?');
    await actor.click(screen.getByRole('button', { name: 'Send broadcast' }));

    await waitFor(() => expect(sendBulk).toHaveBeenCalled());
    expect(sendBulk.mock.calls[0]?.[0]?.targetCriteria).toEqual({ tenantIds: [TENANT_ID] });
  });

  it('names a refused broadcast, where it used to be silent', async () => {
    sendBulk.mockRejectedValue(new Error('broadcast rejected: capability support-ops required'));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Bulk Message/ }));
    await actor.type(screen.getByLabelText('Subject'), 'Planned maintenance');
    await actor.type(screen.getByLabelText('Message Content'), 'Sunday.');
    await actor.click(screen.getByRole('button', { name: 'Send broadcast' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('capability support-ops required'))).toBe(
      true,
    );
  });
});

describe('MessagingPage threads and stats', () => {
  it('shows an em dash when no admin reply has ever been measured', async () => {
    stats.mockResolvedValue(statsFixture({ avgResponseTimeMinutes: null }));
    renderPage();

    // `0m` read as an instant reply from a platform that had never replied.
    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.getByText('No admin reply to measure yet')).toBeInTheDocument();
    expect(screen.queryByText('0m')).not.toBeInTheDocument();
  });

  it('says the conversation list is one page of a longer one', async () => {
    threadList.mockResolvedValue(threadPage([thread()], 412));
    renderPage();

    expect(
      await screen.findByText(/Showing the 1 most recent of 412 conversations/),
    ).toBeInTheDocument();
  });

  it('opens a conversation against a picked tenant, not a typed id', async () => {
    createThread.mockResolvedValue(createdThread());
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /New Conversation/ }));
    // A valid-but-wrong UUID opened a support conversation — with its first
    // message — against a tenant nobody meant to contact.
    expect(screen.queryByPlaceholderText(/Enter tenant ID/i)).not.toBeInTheDocument();

    await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
    await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
    await actor.type(screen.getByLabelText('Subject'), 'Welcome');
    await actor.type(screen.getByLabelText('Initial Message'), 'Your account is live.');
    await actor.click(screen.getByRole('button', { name: 'Start Conversation' }));

    await waitFor(() => expect(createThread).toHaveBeenCalled());
    expect(createThread.mock.calls[0]?.[0]).toEqual({
      tenantId: TENANT_ID,
      subject: 'Welcome',
      content: 'Your account is live.',
    });
    expect(createThread.mock.calls[0]?.[0]).not.toHaveProperty('senderName');
  });

  it('names a refused close, where it used to be silent', async () => {
    closeThread.mockRejectedValue(new Error('close rejected: thread is under legal hold'));
    renderPage();
    const actor = userEvent.setup();

    await openThread();
    await actor.click(await screen.findByRole('button', { name: 'Close Thread' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('under legal hold'))).toBe(true);
  });

  it('names a failed mark-as-read separately from the message read', async () => {
    markAsRead.mockRejectedValue(new Error('mark-as-read rejected'));
    renderPage();
    await openThread();

    // The two shared one `try`, so a refused mark-as-read was indistinguishable
    // from a failed thread load — and both were silent.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('mark-as-read rejected'))).toBe(true);
    // The messages are on screen regardless — the list preview carries the same
    // text as the bubble, so both matches are expected.
    expect(await screen.findAllByText('It reads 2 mg/L below the handheld.')).toHaveLength(2);
  });

  it('forwards an abort signal to both page reads', async () => {
    renderPage();

    await waitFor(() => expect(threadList).toHaveBeenCalled());
    expect(threadList.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('names a failed thread list and draws no empty inbox', async () => {
    threadList.mockRejectedValue(new Error('thread list is unreachable'));
    renderPage();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('thread list is unreachable'))).toBe(true);
    expect(screen.queryByText('No conversations found')).not.toBeInTheDocument();
  });
});
