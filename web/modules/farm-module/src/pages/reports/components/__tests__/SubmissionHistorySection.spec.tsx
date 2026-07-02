/**
 * SubmissionHistorySection — the shared real-data report history block
 * (FARM-HIGH-125). Exercises the REAL useRegulatoryReports hook against a
 * mocked graphqlClient transport, following the module's federation-free
 * vitest convention.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubmissionHistorySection } from '../SubmissionHistorySection';
import '@testing-library/jest-dom/vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  // The real useTenantQuery reads shared-ui's INTERNAL useAuth (an AuthContext
  // consumer), which this federation-free test does not mount — so replicate its
  // contract (tenant-prefixed key + auth gate + keepPreviousData) on top of the
  // stub session, keeping the module's hook file itself under test.
  const rq =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  const TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
  return {
    ...actual,
    useAuth: () => ({
      token: 'jwt',
      tenantId: TENANT_ID,
      isAuthenticated: true,
      isLoading: false,
    }),
    graphqlClient: { request: requestMock },
    useTenantQuery: <TData,>(
      segments: readonly unknown[],
      queryFn: () => Promise<TData>,
      options?: { enabled?: boolean },
    ) =>
      rq.useQuery<TData>({
        queryKey: ['tenant', TENANT_ID, ...segments],
        queryFn,
        enabled: options?.enabled ?? true,
        placeholderData: rq.keepPreviousData,
      }),
  };
});

const ROWS = [
  {
    id: 'rr-1',
    reportType: 'SEA_LICE',
    klientReferanse: 'ref-1',
    siteId: 'site-1',
    lokalitetsnummer: 12345,
    reportYear: 2026,
    reportWeek: 26,
    reportMonth: null,
    status: 'SUBMITTED',
    referanse: 'MT-9',
    feilmelding: null,
    submittedBy: 'user-1',
    submittedAt: '2026-06-30T10:00:00.000Z',
    createdAt: '2026-06-30T09:59:00.000Z',
  },
  {
    id: 'rr-2',
    reportType: 'SEA_LICE',
    klientReferanse: 'ref-2',
    siteId: 'site-1',
    lokalitetsnummer: 12345,
    reportYear: 2026,
    reportWeek: 25,
    reportMonth: null,
    status: 'FAILED',
    referanse: null,
    feilmelding: 'lusetelling: ugyldig',
    submittedBy: 'user-1',
    submittedAt: null,
    createdAt: '2026-06-23T09:00:00.000Z',
  },
];

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SubmissionHistorySection reportType="SEA_LICE" siteId="site-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

describe('SubmissionHistorySection', () => {
  it('renders persisted rows fetched through the real hook', async () => {
    requestMock.mockResolvedValue({ regulatoryReports: ROWS });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('Week 26, 2026')).toBeInTheDocument();
    });
    expect(screen.getByText('Week 25, 2026')).toBeInTheDocument();
    expect(screen.getByText('Mattilsynet receipt: MT-9')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('lusetelling: ugyldig');
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('regulatoryReports(')),
    ).toBe(true);
  });

  it('filters rows by status', async () => {
    requestMock.mockResolvedValue({ regulatoryReports: ROWS });
    renderSection();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText('Week 26, 2026')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Failed' }));

    expect(screen.queryByText('Week 26, 2026')).not.toBeInTheDocument();
    expect(screen.getByText('Week 25, 2026')).toBeInTheDocument();
  });

  it('shows the empty state when nothing was submitted yet', async () => {
    requestMock.mockResolvedValue({ regulatoryReports: [] });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText('No submissions recorded yet.')).toBeInTheDocument();
    });
  });

  it('surfaces a load failure instead of rendering nothing', async () => {
    requestMock.mockRejectedValue(new Error('network down'));
    renderSection();

    await waitFor(() => {
      expect(
        screen.getByText('Failed to load submission history. Please retry.'),
      ).toBeInTheDocument();
    });
  });
});
