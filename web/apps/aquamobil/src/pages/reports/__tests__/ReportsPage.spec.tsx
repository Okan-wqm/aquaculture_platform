/**
 * ReportsPage regulatory-section gating tests (FARM-HIGH-214 / RPT-019).
 *
 * The regulatory section is ONLINE-ONLY: offline, it must show an honest
 * connectivity notice and fire NO network fetch (a regulator workflow is
 * never served from stale caches or queued). Online, deadlines render with
 * overdue-first ordering and the overdue chip.
 *
 * The farm-summary section above it has no such constraint — it reads the
 * cached inventory — which is why the gating is scoped to the section rather
 * than to the screen.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ReportsPage } from '../ReportsPage';

vi.mock('@/hooks/useTanks', () => ({ useTanks: () => ({ data: [], isLoading: false }) }));
vi.mock('@/utils/feature-access', () => ({ useFeatureAccess: () => ({ canReach: () => true }) }));

const h = vi.hoisted(() => ({
  isOnline: true,
  graphqlRequest: vi.fn<(doc: unknown, vars: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      reportDeadlines: [
        {
          id: 'draft-ok',
          reportType: 'SEA_LICE',
          siteId: 'site-1',
          periodYear: 2026,
          periodWeek: 27,
          periodMonth: null,
          status: 'READY',
          dueAt: '2026-07-13',
          overdue: false,
          daysUntilDue: 2,
        },
        {
          id: 'draft-late',
          reportType: 'SMOLT',
          siteId: 'site-1',
          periodYear: 2026,
          periodWeek: null,
          periodMonth: 6,
          status: 'DRAFT',
          dueAt: '2026-07-07',
          overdue: true,
          daysUntilDue: -4,
        },
      ],
    }),
  ),
}));

vi.mock('@/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => h.isOnline,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    tenantId: 'tenant-1',
    isAuthenticated: true,
    accessToken: 'token',
    user: { id: 'u1', role: 'MODULE_MANAGER' },
  }),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (doc: unknown, vars: unknown) => h.graphqlRequest(doc, vars),
}));

vi.mock('lucide-react', () => {
  const Stub = (): ReactNode => <svg data-testid="icon" />;
  return {
    CloudOff: Stub,
    FileText: Stub,
    TrendingUp: Stub,
    ChevronRight: Stub,
    ChevronLeft: Stub,
  };
});

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.graphqlRequest.mockClear();
  h.isOnline = true;
});

afterEach(() => {
  cleanup();
});

describe('ReportsPage — online-only report surface (FARM-HIGH-214)', () => {
  it('offline: shows the connectivity notice and performs NO fetch', () => {
    h.isOnline = false;
    renderPage();
    expect(screen.getByText(/Submissions need a connection/i)).toBeTruthy();
    expect(h.graphqlRequest).not.toHaveBeenCalled();
  });

  it('online: renders deadlines with the overdue draft first and an Overdue chip', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Overdue/i)).toBeTruthy());

    // Filter to the deadline rows: the screen now also carries the header's
    // avatar button and the farm-summary section above this list, so indexing
    // raw buttons would pin the assertion to unrelated chrome.
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => /Sea Lice|Smolt|Biomass|Cleaner|Slaughter/.test(b.textContent ?? ''));
    // Overdue SMOLT sorts before the not-yet-due SEA_LICE.
    expect(buttons[0].textContent).toContain('Smolt');
    expect(buttons[0].textContent).toContain('Overdue');
    expect(screen.getByText(/Sea Lice \(weekly\)/i)).toBeTruthy();
    expect(screen.getByText(/Due in 2d/i)).toBeTruthy();
    expect(h.graphqlRequest).toHaveBeenCalledTimes(1);
  });
});
