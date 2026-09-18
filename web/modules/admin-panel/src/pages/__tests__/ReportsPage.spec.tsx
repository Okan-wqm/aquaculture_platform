/**
 * ReportsPage on the admin data layer (ADMIN-HIGH-121).
 *
 * The audit's correction C8 established that this page is NOT one of the fake
 * surfaces: it runs real report executions against a real controller. What it
 * got wrong was the same thing every unmigrated page got wrong, in the form
 * that hurts most on an asynchronous resource:
 *
 *     const execution = await reportsApi.executeReport({ … });
 *     setGeneratedReports((prev) => [mapExecutionToReport(execution), ...prev]);
 *
 * A report execution is queued. The row took whatever status the POST happened
 * to return at that instant — usually "pending" — and NOTHING ever re-read it,
 * so a report that had finished still showed as running until the operator
 * reloaded the page. The list is a query now, and it polls while anything is
 * pending.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import ReportsPage from '../ReportsPage';
import { reportsApi } from '../../services/adminApi';
import type { ReportExecution } from '../../services/types';

vi.mock('../../services/adminApi', () => ({
  reportsApi: {
    getReportExecutions: vi.fn(),
    executeReport: vi.fn(),
    downloadReport: vi.fn(),
  },
}));

const executionsMock = vi.mocked(reportsApi.getReportExecutions);

function execution(overrides: Partial<ReportExecution> = {}): ReportExecution {
  return {
    id: 'execution-1',
    reportType: 'tenant_summary',
    reportName: 'Tenant Summary',
    format: 'json',
    status: 'completed',
    createdAt: '2026-09-08T23:00:00.000Z',
    ...overrides,
  } as ReportExecution;
}

function page(rows: ReportExecution[]) {
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

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

describe('ReportsPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executionsMock.mockResolvedValue(page([execution()]));
  });

  it('forwards the abort signal to the history read', async () => {
    renderPage();

    await waitFor(() => expect(executionsMock).toHaveBeenCalled());
    expect(executionsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('shows the executions the server returned', async () => {
    renderPage();

    expect(await screen.findByText('Tenant Summary')).toBeInTheDocument();
  });

  it('keeps re-reading while an execution is still running', async () => {
    vi.useFakeTimers();
    try {
      executionsMock.mockResolvedValue(page([execution({ status: 'running' })]));
      renderPage();

      await vi.waitFor(() => expect(executionsMock).toHaveBeenCalledTimes(1));
      // The regression: a queued execution sat at "pending" until the operator
      // reloaded the page, because nothing ever re-read it.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(executionsMock).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once every execution has settled', async () => {
    vi.useFakeTimers();
    try {
      renderPage();

      await vi.waitFor(() => expect(executionsMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(executionsMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed history read instead of an empty report list', async () => {
    executionsMock.mockRejectedValue(new Error('report history unavailable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('report history unavailable');
  });
});
