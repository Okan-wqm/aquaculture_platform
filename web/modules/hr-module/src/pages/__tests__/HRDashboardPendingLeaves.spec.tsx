/**
 * HRDashboardPage — the pending leave approvals come from the paginated connection.
 *
 * pendingLeaveApprovals answers `{ items, total, ... }` for the viewer the server resolves from
 * the token. The dashboard needs one row to preview and the total to count, so it asks for a
 * page of one and reads `total` — counting `items` of that page would always say 1.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaginationInput } from '../../types';
import { HRDashboardPage } from '../HRDashboardPage';

interface PendingPage {
  items: { id: string; createdAt: string; employee: { firstName: string; lastName: string } }[];
  total: number;
}

const mocks = vi.hoisted(() => ({
  pending: vi.fn<(pagination?: PaginationInput) => { data: PendingPage; isLoading: boolean }>(),
}));

vi.mock('../../hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks')>();
  return {
    ...actual,
    useHRDashboardStats: () => ({
      data: { totalEmployees: 12, activeEmployees: 11, onLeaveEmployees: 2 },
      isLoading: false,
    }),
    usePendingLeaveApprovals: mocks.pending,
    useExpiringCertifications: () => ({ data: [], isLoading: false }),
    useCurrentlyOffshore: () => ({ data: [], isLoading: false }),
    useDepartments: () => ({ data: [], isLoading: false }),
    useWorkAreas: () => ({ data: [] }),
  };
});

// Each fetches its own data and is not under test here.
vi.mock('../../components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components')>();
  return {
    ...actual,
    CertificationExpiryAlert: () => null,
    SeaLandSplitView: () => null,
  };
});

const FIRST = {
  id: 'leave-1',
  createdAt: '2026-10-15T08:00:00Z',
  employee: { firstName: 'Ada', lastName: 'Berg' },
};

function renderPage(): void {
  render(
    <MemoryRouter>
      <HRDashboardPage />
    </MemoryRouter>,
  );
}

describe('HRDashboardPage pending leave approvals', () => {
  beforeEach(() => {
    mocks.pending.mockReset();
  });

  it('asks for a page of one — a row to preview, and the total to count', () => {
    mocks.pending.mockReturnValue({ data: { items: [FIRST], total: 1 }, isLoading: false });

    renderPage();

    expect(mocks.pending).toHaveBeenCalled();
    for (const [pagination] of mocks.pending.mock.calls) {
      expect(pagination).toEqual({ limit: 1 });
    }
  });

  it('counts the total, not the one row it fetched', () => {
    mocks.pending.mockReturnValue({ data: { items: [FIRST], total: 8 }, isLoading: false });

    renderPage();

    expect(screen.getByText(/8 requests awaiting your\s+review/)).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('previews the first pending request', () => {
    mocks.pending.mockReturnValue({ data: { items: [FIRST], total: 8 }, isLoading: false });

    renderPage();

    expect(screen.getByText(/Ada Berg\s+submitted a leave request/)).toBeInTheDocument();
  });

  it('shows no banner and no preview when nothing awaits approval', () => {
    mocks.pending.mockReturnValue({ data: { items: [], total: 0 }, isLoading: false });

    renderPage();

    expect(screen.queryByText('Pending Leave Approvals')).not.toBeInTheDocument();
    expect(screen.queryByText(/submitted a leave request/)).not.toBeInTheDocument();
  });
});
