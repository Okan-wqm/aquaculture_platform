/**
 * CompliancePage — the first admin page on the WRITE primitive
 * (ADMIN-HIGH-121), and the end of the security batch.
 *
 * Two things this spec exists for:
 *
 *   1. **The write invalidates exactly what it changed.** The old handler
 *      called `loadData()` after a successful action, re-fetching the request
 *      list AND the compliance reports AND the framework checks — two of which
 *      a data-subject-request action cannot have touched. `useAdminMutation`'s
 *      `invalidateKeys` names the one slice that moved.
 *
 *   2. **The page stops claiming zero overdue requests.** `fetchDataRequests`
 *      built a `ComplianceStats` whose only real field was `totalRequests`;
 *      pending, in-progress, completed and OVERDUE were literal `0`. On a GDPR
 *      surface "0 overdue" is a regulated claim the endpoint gives no basis
 *      for. It renders an em dash now, and ADMIN-HIGH-122 owns the missing
 *      server aggregate.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { CompliancePage } from '../CompliancePage';
import { securityApi } from '../../../services/adminApi';

vi.mock('../../../services/adminApi', () => ({
  securityApi: {
    getDataRequests: vi.fn(),
    getComplianceReports: vi.fn(),
    getComplianceChecks: vi.fn(),
    verifyDataRequestIdentity: vi.fn(),
    rejectDataRequest: vi.fn(),
    completeDataRequest: vi.fn(),
  },
}));

const requestsMock = vi.mocked(securityApi.getDataRequests);
const reportsMock = vi.mocked(securityApi.getComplianceReports);
const checksMock = vi.mocked(securityApi.getComplianceChecks);

function renderPage(): { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CompliancePage />
    </QueryClientProvider>,
  );
  return { client };
}

describe('CompliancePage on the admin data layer (ADMIN-HIGH-121)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestsMock.mockResolvedValue({
      data: [],
      total: 7,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    reportsMock.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    checksMock.mockResolvedValue([]);
  });

  it('forwards the abort signal to all three reads', async () => {
    renderPage();

    await waitFor(() => expect(requestsMock).toHaveBeenCalled());
    expect(requestsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(reportsMock).toHaveBeenCalled());
    expect(reportsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(checksMock).toHaveBeenCalled());
    expect(checksMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('reads the three slices under three separate cache keys', async () => {
    const { client } = renderPage();

    await waitFor(() => expect(checksMock).toHaveBeenCalled());
    const keys = client
      .getQueryCache()
      .getAll()
      .map((entry) => entry.queryKey)
      .filter((key) => key[1] === 'security')
      .map((key) => key[2]);

    // Separate keys are what let a mutation invalidate one without discarding
    // the other two.
    expect(new Set(keys)).toEqual(
      new Set(['data-requests', 'compliance-reports', 'compliance-checks']),
    );
  });

  it('shows an em dash, not a zero, for the counts the API does not compute', async () => {
    renderPage();

    // The real total renders as a number…
    expect(await screen.findByText('7')).toBeInTheDocument();
    // …and the four aggregates the endpoint does not return render as unknown.
    // A `0` here would be the platform asserting there are no overdue GDPR
    // data-subject requests (ADMIN-HIGH-122).
    await waitFor(() => expect(screen.getAllByText('—')).toHaveLength(4));
  });

  it('reports a partial failure instead of an empty tab', async () => {
    checksMock.mockRejectedValue(new Error('compliance checks unavailable'));
    renderPage();

    expect(await screen.findByText(/compliance checks unavailable/)).toBeInTheDocument();
  });

  it('takes over the page only when nothing loaded', async () => {
    requestsMock.mockRejectedValue(new Error('data requests unavailable'));
    reportsMock.mockRejectedValue(new Error('reports unavailable'));
    checksMock.mockRejectedValue(new Error('checks unavailable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('data requests unavailable');
    expect(alert).toHaveTextContent('reports unavailable');
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retries every query from the failure notice', async () => {
    const user = userEvent.setup();
    requestsMock.mockRejectedValue(new Error('data requests unavailable'));
    reportsMock.mockRejectedValue(new Error('reports unavailable'));
    checksMock.mockRejectedValue(new Error('checks unavailable'));
    renderPage();

    await waitFor(() => expect(requestsMock).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    // All three, because the retry re-runs the page's reads rather than only
    // the one whose message happened to be first.
    await waitFor(() => expect(requestsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reportsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checksMock).toHaveBeenCalledTimes(2));
  });
});
