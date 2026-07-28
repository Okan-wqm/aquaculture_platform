/**
 * APA-144 (frontend half) — the preview modal must show the rows it has.
 *
 * `ReportsPage` declared its own shadow view model with an extra
 * `data?: unknown` that the canonical `services/types/reports.ts#ReportExecution`
 * correctly omits and that no mapper ever assigned. Because the field was
 * OPTIONAL the drift was type-legal — TypeScript cannot flag a
 * declared-but-never-set optional — so `Array.isArray(selectedReport.data)` was
 * always false, the modal always rendered "No data available" beside a visible
 * non-zero row count, and the "Showing first 10 records" note was unreachable.
 *
 * The view model is now `Pick`ed off the API type, so a field the API does not
 * carry is a compile error; the table reads the `previewRows` the backend
 * persists at execution time, and the truncation note is driven by the TRUE
 * total (`rowCount`) rather than by the preview length, so it cannot become
 * unreachable again.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-144
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
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

/** Ten preview rows sliced server-side out of twelve generated ones. */
const PREVIEW_ROWS = Array.from({ length: 10 }, (_, i) => ({
  module: `Module ${i + 1}`,
  activeUsers: i + 1,
}));

function executionResponse(overrides: Record<string, unknown>): {
  data: Array<Record<string, unknown>>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
} {
  return {
    data: [
      {
        id: 'exec-1',
        reportName: 'Module Usage Report',
        reportType: 'usage_modules',
        format: 'json',
        status: 'completed',
        createdAt: '2026-07-01T00:00:00.000Z',
        completedAt: '2026-07-01T00:00:05.000Z',
        ...overrides,
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
    totalPages: 1,
  };
}

async function openPreview(): Promise<void> {
  render(
    <BrowserRouter>
      <ReportsPage />
    </BrowserRouter>,
  );
  await screen.findByText('Module Usage Report');
  await userEvent.click(screen.getByRole('button', { name: 'View' }));
}

describe('ReportsPage preview modal (APA-144)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the persisted preview rows with their real column headers', async () => {
    api.getReportExecutions.mockResolvedValue(
      executionResponse({ rowCount: 12, previewRows: PREVIEW_ROWS }),
    );

    await openPreview();

    // Headers prove formatColumnHeader ran over real keys, not a placeholder.
    expect(screen.getByRole('columnheader', { name: 'Module' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Active Users' })).toBeInTheDocument();

    const body = screen.getAllByRole('rowgroup')[1];
    expect(body).toBeDefined();
    expect(within(body as HTMLElement).getAllByRole('row')).toHaveLength(10);

    // Driven by the true total, so it states what is missing rather than a
    // hardcoded "first 10".
    expect(screen.getByText(/Showing first 10 of 12 records/)).toBeInTheDocument();
    expect(screen.queryByText('No data available')).not.toBeInTheDocument();
  });

  it('states the preview is unavailable — not that there is no data — for a legacy execution', async () => {
    // Executions written before the column existed are deliberately not
    // backfilled: a reconstructed preview would be worse than none.
    api.getReportExecutions.mockResolvedValue(
      executionResponse({ rowCount: 5, previewRows: undefined }),
    );

    await openPreview();

    expect(screen.getByText(/Preview unavailable for this execution/)).toBeInTheDocument();
    expect(screen.queryByText('No data available')).not.toBeInTheDocument();
  });

  it('says the report produced no rows when it genuinely produced none', async () => {
    api.getReportExecutions.mockResolvedValue(
      executionResponse({ rowCount: 0, previewRows: [] }),
    );

    await openPreview();

    expect(screen.getByText('This report produced no rows.')).toBeInTheDocument();
  });

  it('omits the truncation note when the preview is the whole report', async () => {
    api.getReportExecutions.mockResolvedValue(
      executionResponse({ rowCount: 3, previewRows: PREVIEW_ROWS.slice(0, 3) }),
    );

    await openPreview();

    const body = screen.getAllByRole('rowgroup')[1];
    expect(within(body as HTMLElement).getAllByRole('row')).toHaveLength(3);
    expect(screen.queryByText(/Showing first/)).not.toBeInTheDocument();
  });
});
