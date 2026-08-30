/**
 * ReportsPage specs (FARM-MEDIUM-120).
 *
 * The regulatory-reports shell reads the per-type submission summary from the
 * backend (RegulatoryReportSummary) and renders the tabbed report surface.
 */
import { screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { ReportsPage } from '../ReportsPage';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query RegulatoryReportSummary',
      result: {
        regulatoryReportSummary: [
          {
            reportType: 'SEA_LICE',
            pendingCount: 1,
            submittedCount: 2,
            queuedCount: 1,
            failedCount: 4,
            lastSubmittedAt: '2026-08-26T10:00:00.000Z',
          },
        ],
      },
    },
  ]);
});

describe('ReportsPage', () => {
  it('renders persisted report failures through its nested route contract', async () => {
    renderWithProviders(<ReportsPage />, {
      route: '/sites/reports',
      path: 'sites/reports/*',
    });

    expect(await screen.findByText('Regulatory Reports')).toBeInTheDocument();
    expect(await screen.findByText(/4 failed submissions/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sea Lice/ })).toHaveTextContent('4');
  });
});
