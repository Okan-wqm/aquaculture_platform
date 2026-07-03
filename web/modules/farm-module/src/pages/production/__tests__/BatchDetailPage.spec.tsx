/**
 * BatchDetailPage specs (FARM-MEDIUM-120 batch 2).
 *
 * Exercises the REAL useBatch hook against the routed graphqlClient seam:
 * header + overview render from the backend batch, the Tanklar tab shows the
 * allocation summary and opens the real AllocateBatchToTankModal, and an
 * unknown batch id renders the honest not-found state (no fake page).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import BatchDetailPage from '../BatchDetailPage';

const BATCH = {
  id: 'batch-1',
  batchNumber: 'B-2026-001',
  name: 'Spring stocking',
  speciesId: 'sp-1',
  inputType: 'FINGERLINGS',
  initialQuantity: 12000,
  currentQuantity: 10500,
  totalMortality: 1500,
  status: 'GROWING',
  isActive: true,
  stockedAt: '2026-03-01T00:00:00.000Z',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  currentBiomassKg: 2625.5,
  currentAvgWeightG: 250,
  mortalityRate: 12.5,
  survivalRate: 87.5,
  daysInProduction: 123,
  documents: [],
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query Batch(',
      result: (variables) => ({ batch: variables?.id === 'batch-1' ? BATCH : null }),
    },
    { match: 'query AvailableTanks', result: { availableTanks: [] } },
  ]);
});

function renderPage(batchId = 'batch-1'): void {
  renderWithProviders(<BatchDetailPage />, {
    route: `/production/batches/${batchId}`,
    path: 'production/batches/:batchId/*',
  });
}

describe('BatchDetailPage', () => {
  it('renders the batch header and overview from the backend batch', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('B-2026-001')).toBeInTheDocument();
    });
    expect(screen.getByText(/Spring stocking/)).toBeInTheDocument();
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('query Batch(')),
    ).toBe(true);
  });

  it('shows the tank-allocation summary on the Tanklar tab and opens the allocate modal', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('B-2026-001')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('link', { name: 'Tanklar' }));

    expect(await screen.findByText('Tank Tahsisleri')).toBeInTheDocument();
    expect(screen.getByText((10500).toLocaleString('tr-TR'))).toBeInTheDocument();
    expect(screen.getByText('2625.5 kg')).toBeInTheDocument();

    const allocateButton = screen.getByRole('button', { name: 'Tanka Tahsis Et' });
    expect(allocateButton).toBeEnabled();
    await user.click(allocateButton);
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query AvailableTanks'),
        ),
      ).toBe(true);
    });
  });

  it('renders the honest not-found state for an unknown batch id', async () => {
    renderPage('batch-unknown');

    expect(await screen.findByText('Parti bulunamadı')).toBeInTheDocument();
    expect(screen.getByText(/batch-unknown/)).toBeInTheDocument();
  });
});
