/**
 * ErrorTrackingPage on the admin data layer (ADMIN-HIGH-121), and the four
 * zeros it reported when it could not read the dashboard (ADMIN-HIGH-128).
 *
 * The stats object was seeded with zeros AND reset to zeros by the catch, so a
 * failed `/system/errors/dashboard` displayed "0 unresolved" and "0 critical"
 * on the screen an operator opens to find out whether anything is broken — the
 * failure itself relegated to a fixed toast in the bottom-right corner.
 *
 * The writes were worse. Each handler spliced the updated group into local
 * state and then did `unresolvedErrors: prev.unresolvedErrors - 1`:
 * ARITHMETIC on a server-computed aggregate. If the action did not change that
 * count, the card drifted further from the truth with every click and nothing
 * ever corrected it.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { ErrorTrackingPage } from '../ErrorTrackingPage';
import { systemSettingsApi } from '../../../services/adminApi';
import type { ErrorGroup } from '../../../services/types';

vi.mock('../../../services/adminApi', () => ({
  systemSettingsApi: {
    getErrorGroups: vi.fn(),
    getErrorDashboard: vi.fn(),
    getErrorOccurrences: vi.fn(),
    resolveError: vi.fn(),
    ignoreError: vi.fn(),
    updateErrorStatus: vi.fn(),
  },
}));

const groupsMock = vi.mocked(systemSettingsApi.getErrorGroups);
const dashboardMock = vi.mocked(systemSettingsApi.getErrorDashboard);
const occurrencesMock = vi.mocked(systemSettingsApi.getErrorOccurrences);
const resolveMock = vi.mocked(systemSettingsApi.resolveError);

function errorGroup(overrides: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    id: 'group-1',
    fingerprint: 'abc123',
    message: 'Cannot read property tenantId of undefined',
    severity: 'error',
    status: 'unresolved',
    occurrenceCount: 42,
    isRegression: false,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-08T23:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-08T23:00:00.000Z',
    ...overrides,
  } as ErrorGroup;
}

function page<T>(rows: T[]) {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit: 20,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function dashboard() {
  return {
    totalErrors: 318,
    unresolvedErrors: 27,
    criticalErrors: 4,
    errorsByService: [],
    errorTrend: [{ timestamp: '2026-09-08T00:00:00.000Z', count: 11 }],
    topErrors: [],
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ErrorTrackingPage />
    </QueryClientProvider>,
  );
}

/**
 * The stat card carrying `label`. Scoped by the card's own label element so
 * "Critical" cannot match the severity filter's option of the same name.
 */
function card(label: string): HTMLElement {
  return screen
    .getByText(label, { selector: 'div.text-sm' })
    .closest('div[class*="rounded"]') as HTMLElement;
}

describe('ErrorTrackingPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupsMock.mockResolvedValue(page([errorGroup()]));
    dashboardMock.mockResolvedValue(dashboard());
    occurrencesMock.mockResolvedValue(page([]));
    resolveMock.mockResolvedValue(errorGroup({ status: 'resolved' }));
  });

  it('forwards the abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    expect(groupsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(dashboardMock).toHaveBeenCalled());
    expect(dashboardMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('shows the counts the dashboard reported', async () => {
    renderPage();

    await screen.findByText('Unresolved', { selector: 'div.text-sm' });
    expect(within(card('Unresolved')).getByText('27')).toBeInTheDocument();
    expect(within(card('Critical')).getByText('4')).toBeInTheDocument();
    // The last trend point, not a 0 for an empty series.
    expect(within(card("Today's Errors")).getByText('11')).toBeInTheDocument();
  });

  it('says unknown, not zero, when the dashboard does not answer', async () => {
    dashboardMock.mockRejectedValue(new Error('error dashboard unavailable'));
    renderPage();

    // The regression: "0 unresolved" and "0 critical" on the screen an
    // operator opens to find out whether anything is broken.
    await screen.findByText('Unresolved', { selector: 'div.text-sm' });
    await waitFor(() => expect(within(card('Unresolved')).getByText('—')).toBeInTheDocument());
    expect(within(card('Critical')).getByText('—')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('error dashboard unavailable');
  });

  it('re-reads the counts after resolving instead of decrementing them', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Cannot read property tenantId of undefined'));
    await user.click(await screen.findByRole('button', { name: /Resolve/ }));

    await waitFor(() => expect(resolveMock).toHaveBeenCalledWith('group-1', 'admin'));
    // `prev.unresolvedErrors - 1` was arithmetic on a number only the server
    // can compute. Both slices are re-read now.
    await waitFor(() => expect(dashboardMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(groupsMock).toHaveBeenCalledTimes(2));
  });

  it('reports a rejected action on the page rather than only in the console', async () => {
    const user = userEvent.setup();
    resolveMock.mockRejectedValue(new Error('resolve rejected'));
    renderPage();

    await user.click(await screen.findByText('Cannot read property tenantId of undefined'));
    await user.click(await screen.findByRole('button', { name: /Resolve/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('resolve rejected');
  });
});
