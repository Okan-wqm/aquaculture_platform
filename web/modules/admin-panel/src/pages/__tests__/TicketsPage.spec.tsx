/**
 * The support queue: a comment thread that was always empty, and an SLA card
 * that could not be wrong (ADMIN-CRITICAL-156, ADMIN-MEDIUM-114).
 *
 * `GET /support/tickets/:id/comments` returns a PAGINATED result. The client
 * declared a flat array, so `(data || []).map(...)` called `.map` on the page
 * object, threw a TypeError, and `fetchComments`'s `catch` wrote it to
 * `console.error`. An admin opened a ticket, saw no messages, and replied to a
 * customer whose messages were right there in the database.
 *
 * The stats endpoint sends ten required numbers; the client declared twenty,
 * half of them optional aliases the server has never sent. That is where the
 * page's `a || b || 0` chains came from, and where `slaBreachCount ? … : 100`
 * came from: the type said the truth might be missing, so the page invented
 * 100% SLA compliance for when it was. Three averages were 0 when there was
 * nothing to average, so a platform that had answered no ticket showed "0m".
 *
 * And every row carried `commentCount: 0, // Not provided by API`.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { TicketsPage } from '../TicketsPage';
import { supportApi } from '../../services/adminApi';
import type {
  PaginatedResult,
  SupportTicket,
  TicketComment,
  TicketStats,
} from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    supportApi: {
      getTickets: vi.fn(),
      getTicketStats: vi.fn(),
      getTicketTeam: vi.fn(),
      getTicketComments: vi.fn(),
      assignTicket: vi.fn(),
      updateTicketStatus: vi.fn(),
      updateTicketPriority: vi.fn(),
      addTicketComment: vi.fn(),
    },
  };
});

const list = vi.mocked(supportApi.getTickets);
const stats = vi.mocked(supportApi.getTicketStats);
const team = vi.mocked(supportApi.getTicketTeam);
const comments = vi.mocked(supportApi.getTicketComments);
const addComment = vi.mocked(supportApi.addTicketComment);
const setStatus = vi.mocked(supportApi.updateTicketStatus);

const TICKET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Complete, as the contract declares it — no cast. */
function ticket(overrides: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: TICKET_ID,
    ticketNumber: 'TKT-1042',
    tenantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenantName: 'Kuzey Su',
    createdBy: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    createdByName: 'Deniz',
    subject: 'Sensor feed stopped overnight',
    description: 'The pond 3 dissolved-oxygen feed went quiet at 02:00.',
    status: 'open',
    priority: 'high',
    category: 'technical',
    slaBreached: false,
    satisfactionRating: 0,
    createdAt: '2026-09-09T02:10:00.000Z',
    updatedAt: '2026-09-09T02:10:00.000Z',
    ...overrides,
  };
}

function queue(rows: SupportTicket[]): PaginatedResult<SupportTicket> {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit: 100,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function comment(overrides: Partial<TicketComment> = {}): TicketComment {
  return {
    id: 'comment-1',
    ticketId: TICKET_ID,
    authorId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    authorType: 'tenant_user',
    authorName: 'Deniz',
    content: 'It is still down this morning.',
    isInternal: false,
    emailSent: true,
    createdAt: '2026-09-09T06:00:00.000Z',
    ...overrides,
  };
}

function commentPage(rows: TicketComment[]): PaginatedResult<TicketComment> {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit: 50,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

/** Complete, as the contract declares it — three nullable averages. */
function statsFixture(overrides: Partial<TicketStats> = {}): TicketStats {
  return {
    total: 7,
    open: 3,
    inProgress: 2,
    waitingCustomer: 0,
    resolved: 1,
    closed: 1,
    avgFirstResponseMinutes: 42,
    avgResolutionMinutes: 600,
    slaBreachCount: 3,
    avgSatisfactionRating: 4.5,
    ...overrides,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TicketsPage />
    </QueryClientProvider>,
  );
}

describe('TicketsPage comment thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(queue([ticket()]));
    stats.mockResolvedValue(statsFixture());
    team.mockResolvedValue([]);
    comments.mockResolvedValue(commentPage([comment()]));
  });

  it('reads the comments off the PAGE the route returns', async () => {
    renderPage();
    await userEvent.setup().click(await screen.findByText('Sensor feed stopped overnight'));

    // The regression: the client declared an array, `.map` ran on the page
    // object, and the TypeError went to console.error — every thread empty.
    expect(await screen.findByText('It is still down this morning.')).toBeInTheDocument();
    expect(screen.queryByText('No comments yet')).not.toBeInTheDocument();
  });

  it('shows the message count it loaded, where the rows used to show a hardcoded 0', async () => {
    comments.mockResolvedValue(commentPage([comment(), comment({ id: 'comment-2' })]));
    renderPage();
    await userEvent.setup().click(await screen.findByText('Sensor feed stopped overnight'));

    expect(await screen.findByText('2 messages')).toBeInTheDocument();
  });

  it('never says "No comments yet" when the read failed', async () => {
    comments.mockRejectedValue(new Error('comment thread is unreachable'));
    renderPage();
    await userEvent.setup().click(await screen.findByText('Sensor feed stopped overnight'));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('comment thread is unreachable'))).toBe(
      true,
    );
    expect(screen.queryByText('No comments yet')).not.toBeInTheDocument();
  });

  it('still says "No comments yet" when the thread really is empty', async () => {
    comments.mockResolvedValue(commentPage([]));
    renderPage();
    await userEvent.setup().click(await screen.findByText('Sensor feed stopped overnight'));

    expect(await screen.findByText('No comments yet')).toBeInTheDocument();
  });

  it('forwards an abort signal to the thread read', async () => {
    renderPage();
    await userEvent.setup().click(await screen.findByText('Sensor feed stopped overnight'));

    await waitFor(() => expect(comments).toHaveBeenCalled());
    expect(comments.mock.calls[0]?.[0]).toBe(TICKET_ID);
    expect(comments.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });
});

describe('TicketsPage statistics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(queue([ticket()]));
    team.mockResolvedValue([]);
    comments.mockResolvedValue(commentPage([]));
    stats.mockResolvedValue(statsFixture());
  });

  it('rounds the SLA compliance rate instead of printing its float tail', async () => {
    renderPage();

    // 3 breaches over 7 tickets used to render 57.142857142857146%.
    expect(await screen.findByText('57.1%')).toBeInTheDocument();
  });

  it('derives 100% from zero breaches by arithmetic, not by fallback', async () => {
    stats.mockResolvedValue(statsFixture({ slaBreachCount: 0 }));
    renderPage();

    expect(await screen.findByText('100%')).toBeInTheDocument();
  });

  it('shows an em dash for an average with no observations, not a zero', async () => {
    stats.mockResolvedValue(
      statsFixture({
        avgFirstResponseMinutes: null,
        avgResolutionMinutes: null,
        avgSatisfactionRating: null,
      }),
    );
    renderPage();

    // "0m" read as an instant first response; "★ 0" read as universal
    // dissatisfaction. Three cards, three dashes.
    expect((await screen.findAllByText('—')).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('0m')).not.toBeInTheDocument();
  });

  it('names a failed stats read', async () => {
    stats.mockRejectedValue(new Error('ticket aggregate is unreachable'));
    renderPage();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('ticket aggregate is unreachable'))).toBe(
      true,
    );
  });
});

describe('TicketsPage writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(queue([ticket()]));
    stats.mockResolvedValue(statsFixture());
    team.mockResolvedValue([]);
    comments.mockResolvedValue(commentPage([]));
  });

  it('names a refused status transition, where it used to be silent', async () => {
    setStatus.mockRejectedValue(new Error('transition rejected: capability support-ops required'));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByText('Sensor feed stopped overnight'));
    await actor.selectOptions(await screen.findByLabelText('Ticket status'), 'in_progress');

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('capability support-ops required'))).toBe(
      true,
    );
  });

  it('names a refused comment, where it used to be silent', async () => {
    addComment.mockRejectedValue(new Error('comment rejected: ticket is closed'));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByText('Sensor feed stopped overnight'));
    await actor.type(await screen.findByPlaceholderText('Write a reply...'), 'Looking into it');
    await actor.click(screen.getByRole('button', { name: 'Send reply' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('ticket is closed'))).toBe(true);
  });

  it('names a failed queue read and draws no empty queue', async () => {
    list.mockRejectedValue(new Error('ticket queue is unreachable'));
    renderPage();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('ticket queue is unreachable'))).toBe(true);
    expect(screen.queryByText('Sensor feed stopped overnight')).not.toBeInTheDocument();
  });

  it('forwards an abort signal to all three page reads', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(team.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});
