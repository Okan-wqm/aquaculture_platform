/**
 * The page that broadcasts to every tenant, and the six ways it used to say
 * nothing (ADMIN-HIGH-145).
 *
 * 1. Publish, cancel, delete and create each caught their failure into
 *    `console.error` and told the operator NOTHING, then refetched — so a
 *    REFUSED publish of a global `critical` notice looked exactly like a
 *    successful one.
 * 2. The acknowledgment roster rendered `data.acknowledgments || []`, so a
 *    failed read drew "No activity yet" on the one screen that answers who has
 *    read a notice they were required to read.
 * 3. A failed stats read silently removed the header strip.
 * 4. The "Edit" pencil on a draft opened the STATISTICS modal; the form modal
 *    that titles itself "Edit Announcement" was never given an announcement,
 *    and the audited `PUT` route had no caller in the panel.
 * 5. The trash icon deleted a platform announcement with no confirmation, on a
 *    route the backend marks `@Destructive()`.
 * 6. "Schedule" with an empty date picker called
 *    `new Date('').toISOString()`, which throws a RangeError.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import AnnouncementsPage from '../AnnouncementsPage';
import { supportApi } from '../../services/adminApi';
import type {
  Announcement,
  AnnouncementAcknowledgmentStatus,
  AnnouncementStats,
  PaginatedResult,
} from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    supportApi: {
      getAnnouncements: vi.fn(),
      getAnnouncementStats: vi.fn(),
      getAnnouncementAcknowledgments: vi.fn(),
      createAnnouncement: vi.fn(),
      updateAnnouncement: vi.fn(),
      publishAnnouncement: vi.fn(),
      unpublishAnnouncement: vi.fn(),
      deleteAnnouncement: vi.fn(),
    },
  };
});

const list = vi.mocked(supportApi.getAnnouncements);
const stats = vi.mocked(supportApi.getAnnouncementStats);
const roster = vi.mocked(supportApi.getAnnouncementAcknowledgments);
const publish = vi.mocked(supportApi.publishAnnouncement);
const remove = vi.mocked(supportApi.deleteAnnouncement);

/** Complete, as the contract declares it — no cast. */
function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'ann-1',
    title: 'Scheduled maintenance',
    content: 'The platform will be unavailable for thirty minutes.',
    type: 'critical',
    status: 'draft',
    isGlobal: true,
    requiresAcknowledgment: true,
    viewCount: 0,
    acknowledgmentCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function page(rows: Announcement[]): PaginatedResult<Announcement> {
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

function statsFixture(): AnnouncementStats {
  return {
    total: 1,
    published: 0,
    scheduled: 0,
    draft: 1,
    expired: 0,
    totalViews: 0,
    totalAcknowledgments: 0,
    byType: { info: 0, warning: 0, critical: 1, maintenance: 0 },
  };
}

function rosterFixture(
  overrides: Partial<AnnouncementAcknowledgmentStatus> = {},
): AnnouncementAcknowledgmentStatus {
  return { totalViews: 0, totalAcknowledgments: 0, acknowledgments: [], ...overrides };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AnnouncementsPage />
    </QueryClientProvider>,
  );
}

describe('AnnouncementsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(page([announcement()]));
    stats.mockResolvedValue(statsFixture());
    roster.mockResolvedValue(rosterFixture());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the server's own reason when a publish is refused", async () => {
    publish.mockRejectedValue(new Error('publish rejected: capability support-ops required'));
    renderPage();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Publish' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('capability support-ops required');
  });

  it('names a failed list read instead of an empty catalogue', async () => {
    list.mockRejectedValue(new Error('announcements are unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('announcements are unreachable');
    expect(screen.queryByText('No announcements found')).not.toBeInTheDocument();
  });

  it('names a failed stats read rather than just dropping the header strip', async () => {
    stats.mockRejectedValue(new Error('announcement stats are unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'announcement stats are unreachable',
    );
    // The rows still loaded, so they stay on screen beside the banner.
    expect(await screen.findByText('Scheduled maintenance')).toBeInTheDocument();
  });

  it('forwards an abort signal to both page reads', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(stats.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('sends the status filter the route accepts', async () => {
    renderPage();

    await waitFor(() => expect(list).toHaveBeenCalled());
    // The client type used to declare `isPublished` — a parameter this
    // controller has never had — and not `status`.
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: '100' });
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty('isPublished');
  });

  it('asks before deleting, and does not delete when refused', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    renderPage();

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Delete Scheduled maintenance' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('opens the edit form from the pencil, not the statistics modal', async () => {
    renderPage();

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Edit Scheduled maintenance' }));

    expect(await screen.findByRole('heading', { name: 'Edit Announcement' })).toBeInTheDocument();
    expect(screen.queryByText('Announcement Statistics')).not.toBeInTheDocument();
  });

  it('refuses to schedule with an empty date instead of throwing', async () => {
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: 'Create Announcement' }));
    // Two controls read "Schedule" — the publishing toggle and, once it is
    // selected, the footer submit. The submit is the last in document order.
    const toggles = screen.getAllByRole('button', { name: 'Schedule' });
    await actor.click(toggles[toggles.length - 1]);

    const submits = screen.getAllByRole('button', { name: 'Schedule' });
    expect(submits[submits.length - 1]).toBeDisabled();
  });
});

describe('AnnouncementsPage acknowledgment roster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(page([announcement({ status: 'published' })]));
    stats.mockResolvedValue(statsFixture());
  });

  it('names a failed roster read rather than reporting no activity', async () => {
    roster.mockRejectedValue(new Error('acknowledgment roster is unreachable'));
    renderPage();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'View Stats' }));

    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((el) => el.textContent?.includes('acknowledgment roster is unreachable')),
    ).toBe(true);
    // The regression: `data.acknowledgments || []` made an unreachable
    // endpoint and a genuinely unread notice draw the same sentence.
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
  });

  it('leaves the counters as an em dash until the roster answers', async () => {
    roster.mockRejectedValue(new Error('acknowledgment roster is unreachable'));
    renderPage();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'View Stats' }));

    await waitFor(() => expect(roster).toHaveBeenCalled());
    // Not 0: an unknown count is not a measured zero. Both counters — views
    // and acknowledgments — are unknown, so both read as a dash.
    expect(await screen.findAllByText('—')).toHaveLength(2);
  });

  it('still says "No activity yet" when the roster really is empty', async () => {
    roster.mockResolvedValue(rosterFixture());
    renderPage();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'View Stats' }));

    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });

  it('forwards an abort signal to the roster read', async () => {
    roster.mockResolvedValue(rosterFixture());
    renderPage();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'View Stats' }));

    await waitFor(() => expect(roster).toHaveBeenCalled());
    expect(roster.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });
});
