/**
 * ActivityLogPage on the admin data layer (ADMIN-HIGH-105).
 *
 * This page had the OTHER un-migrated shape: no `useAsyncData` at all, just
 * `useState` × 8 and a `useEffect` calling `Promise.allSettled` over two
 * fetchers. React Query owns four of those eight — data, pending, error,
 * total — and the two fetches become two independent keyed queries.
 *
 * What the spec pins is what that buys:
 *
 *   1. **Partial failure stays partial.** `Promise.allSettled` was reaching for
 *      "one failing must not blank the other"; two separate queries make it
 *      structural. A stats outage must leave the rows on screen.
 *   2. **The search box does not blank the table.** Every keystroke is a new
 *      cache key; `placeholderData` keeps the previous page visible until the
 *      next lands, where the old code set `loading` and rendered a spinner
 *      over an empty list on every character.
 *   3. **Superseded requests are aborted.** Both fetchers forward the signal
 *      React Query cancels on key change and unmount; before this neither took
 *      one, so a fast typist left a queue of requests decoding into a view
 *      that had moved on.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { ActivityLogPage } from '../ActivityLogPage';
import { securityApi } from '../../../services/adminApi';
import type {
  ActivityStatsOverview,
  BackendActivityLog,
  PaginatedResult,
} from '../../../services/adminApi';
import { derivePaginationMetadataV1 } from '@platform/pagination-contracts';

vi.mock('../../../services/adminApi', () => ({
  securityApi: { getActivityLogs: vi.fn(), getActivityStatsOverview: vi.fn() },
}));

const logsMock = vi.mocked(securityApi.getActivityLogs);
const statsMock = vi.mocked(securityApi.getActivityStatsOverview);

// Fully-typed doubles: every field the real contract declares, so a change to
// `BackendActivityLog` or `ActivityStatsOverview` breaks this file instead of
// letting the suite pass against a shape the page no longer receives.
function backendLog(overrides: Partial<BackendActivityLog> = {}): BackendActivityLog {
  return {
    id: 'activity-1',
    category: 'authentication',
    action: 'LOGIN_FAILED',
    severity: 'error',
    userName: 'operator-one',
    userEmail: 'operator@example.com',
    ipAddress: '203.0.113.9',
    success: false,
    createdAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

function statsOverview(): ActivityStatsOverview {
  return {
    totalActivities: 12,
    byCategory: {},
    bySeverity: {},
    bySuccess: { failure: 3 },
    topActions: [{ action: 'LOGIN_FAILED', count: 3 }],
    topUsers: [{ userId: 'u1', userName: 'operator-one', count: 3 }],
    topIPs: [{ ip: '203.0.113.9', count: 3 }],
    activityOverTime: [{ date: '2026-09-08', count: 12 }],
  };
}

function activityPage(rows: BackendActivityLog[]): PaginatedResult<BackendActivityLog> {
  // The pagination metadata comes from its own SSoT rather than three
  // hand-written fields, so a double cannot claim a page count the real
  // derivation would never produce.
  return { ...derivePaginationMetadataV1(12, 1, 50), data: rows };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ActivityLogPage />
    </QueryClientProvider>,
  );
}

describe('ActivityLogPage on the admin data layer (ADMIN-HIGH-105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logsMock.mockResolvedValue(activityPage([backendLog()]));
    statsMock.mockResolvedValue(statsOverview());
  });

  it('renders rows from the query cache', async () => {
    renderPage();
    expect(await screen.findByText('operator-one')).toBeInTheDocument();
  });

  it('forwards the abort signal to both fetchers', async () => {
    renderPage();

    await waitFor(() => expect(logsMock).toHaveBeenCalled());
    expect(logsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    expect(statsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('keeps the rows on screen when only the statistics query fails', async () => {
    statsMock.mockRejectedValue(new Error('activity statistics unavailable'));
    renderPage();

    // Both facts hold at once: the failure is reported AND the list survives.
    // A single combined fetch would have had to choose.
    expect(await screen.findByText('operator-one')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/activity statistics unavailable/)).toBeInTheDocument(),
    );
  });

  it('reports a failed list query without inventing an empty list', async () => {
    logsMock.mockRejectedValue(new Error('activities unavailable'));
    renderPage();

    expect(await screen.findByText(/activities unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('operator-one')).not.toBeInTheDocument();
  });

  it('keeps the previous page rendered while a search re-query is in flight', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('operator-one')).toBeInTheDocument();

    // The next key's request never settles, so without placeholderData the
    // table would be empty for as long as it is pending.
    logsMock.mockImplementation(
      () =>
        new Promise<PaginatedResult<BackendActivityLog>>(() => {
          /* never settles — the point of the assertion below */
        }),
    );
    const search = screen.getByPlaceholderText(/search/i);
    await user.type(search, 'op');

    await waitFor(() => expect(logsMock.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('operator-one')).toBeInTheDocument();
  });
});
