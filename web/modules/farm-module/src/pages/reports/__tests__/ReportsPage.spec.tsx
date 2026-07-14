/**
 * ReportsPage specs (FARM-MEDIUM-120).
 *
 * The regulatory-reports shell reads the per-type submission summary from the
 * backend (RegulatoryReportSummary) and renders the tabbed report surface.
 */
import { screen, waitFor } from '@testing-library/react';
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
    { match: 'query RegulatoryReportSummary', result: { regulatoryReportSummary: [] } },
  ]);
});

describe('ReportsPage', () => {
  it('renders the regulatory reports shell and reads the backend summary', async () => {
    renderWithProviders(<ReportsPage />, { route: '/sites/reports' });

    expect(await screen.findByText('Regulatory Reports')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) =>
          (q as string).includes('query RegulatoryReportSummary'),
        ),
      ).toBe(true);
    });
  });
});
