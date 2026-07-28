/**
 * APA-148 — the report history must be reachable past its first page.
 *
 * `loadReportHistory` hardcoded `{ page: 1, limit: 20 }` and discarded the
 * pagination metadata the response carries, and the "Recently Generated
 * Reports" card rendered a flat list with no pager. The backend contract is
 * complete end to end — `getExecutions` returns `createStandardPaginatedResult`,
 * the interceptor lifts total/page/limit into `meta`, and the FE http-client
 * flattens that into `PaginatedResult<T>` — so the 21st execution onward was
 * unreachable from the UI purely because the page never asked for it, even
 * though its download link stays valid for seven days.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-148
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import ReportsPage from '../ReportsPage';
import { reportsApi } from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    reportsApi: {
      ...actual.reportsApi,
      getReportExecutions: vi.fn(),
      executeReport: vi.fn(),
      downloadReport: vi.fn(),
    },
  };
});

const api = vi.mocked(reportsApi);

/** 47 executions across three pages of 20 — the shape the backend really sends. */
const TOTAL = 47;

function executionsFor(page: number): {
  data: Array<Record<string, unknown>>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
} {
  const start = (page - 1) * 20;
  const count = Math.min(20, TOTAL - start);
  return {
    data: Array.from({ length: count }, (_, i) => ({
      id: `exec-${start + i + 1}`,
      reportName: `Execution ${start + i + 1}`,
      reportType: 'tenant_overview',
      format: 'json',
      status: 'completed',
      rowCount: 3,
      createdAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:05.000Z',
    })),
    total: TOTAL,
    page,
    limit: 20,
    totalPages: 3,
  };
}

function renderPage(): void {
  render(
    <BrowserRouter>
      <ReportsPage />
    </BrowserRouter>,
  );
}

describe('ReportsPage history pagination (APA-148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getReportExecutions.mockImplementation(
      (params?: { page?: number; limit?: number }) =>
        Promise.resolve(executionsFor(params?.page ?? 1)),
    );
  });

  it('shows a pager and the true total when more than one page exists', async () => {
    renderPage();

    expect(await screen.findByText('Execution 1')).toBeInTheDocument();
    // The count comes from the response metadata the page used to throw away.
    expect(screen.getByText(/1-20 \/ 47/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });

  it('reaches the executions past the first page', async () => {
    renderPage();
    await screen.findByText('Execution 1');

    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    // Execution 21 was unreachable from the UI entirely before this fix.
    expect(await screen.findByText('Execution 21')).toBeInTheDocument();
    expect(screen.queryByText('Execution 1')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.getReportExecutions).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 20 }),
      ),
    );
  });

  it('stops at the last page rather than requesting past the total', async () => {
    renderPage();
    await screen.findByText('Execution 1');

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText('Execution 21');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    // 47 items -> page 3 holds 7 and Next must be disabled there.
    expect(await screen.findByText('Execution 41')).toBeInTheDocument();
    expect(screen.getByText(/41-47 \/ 47/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('hides the pager entirely when everything fits on one page', async () => {
    api.getReportExecutions.mockResolvedValue({
      data: [
        {
          id: 'exec-1',
          reportName: 'Only Execution',
          reportType: 'tenant_overview',
          format: 'json',
          status: 'completed',
          rowCount: 1,
          createdAt: '2026-07-01T00:00:00.000Z',
          completedAt: '2026-07-01T00:00:05.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    renderPage();

    expect(await screen.findByText('Only Execution')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });
});
