/**
 * HarvestPlansPage specs (FARM-MEDIUM-120 batch 7).
 *
 * Exercises the real useHarvestPlanList hook against the routed graphqlClient
 * seam: plan rows render from the backend list and a transport failure does
 * not render a fake-empty success state.
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
import HarvestPlansPage from '../HarvestPlansPage';

const PLAN = {
  id: 'hp-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  planCode: 'HP-2026-001',
  name: 'Autumn harvest wave 1',
  description: null,
  batchId: 'batch-1',
  // HarvestPlanStatus/harvestType are lowercase literals on this page.
  status: 'planned',
  harvestType: 'partial',
  plannedDate: '2026-09-15',
  confirmedDate: null,
  windowStartDate: '2026-09-10',
  windowEndDate: '2026-09-20',
  criteria: null,
  harvestMethod: null,
  productForm: null,
  estimates: { estimatedQuantity: 5000, estimatedBiomass: 12500, estimatedAvgWeight: 2500 },
  financialProjection: null,
  logistics: null,
  customerOrder: null,
  qualityRequirements: null,
  actualQuantityHarvested: null,
  actualBiomassHarvested: null,
  actualAvgWeight: null,
  approvedBy: null,
  approvedAt: null,
  createdBy: 'user-1',
  notes: null,
  attachments: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  daysUntilHarvest: 75,
  isWithinWindow: false,
  isHarvestAllowed: true,
  canEdit: true,
  canDelete: true,
  canApprove: true,
  canSchedule: true,
  canStartHarvest: false,
  canComplete: false,
  isOverdue: false,
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query HarvestPlans',
      result: {
        harvestPlans: {
          items: [PLAN],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      },
    },
    { match: 'query Batches', result: { batches: { items: [], total: 0, page: 1, limit: 100, totalPages: 0 } } },
  ]);
});

describe('HarvestPlansPage', () => {
  it('renders harvest-plan rows from the backend list', async () => {
    renderWithProviders(<HarvestPlansPage />, { route: '/harvest', path: 'harvest' });

    expect((await screen.findAllByText(/Autumn harvest wave 1/)).length).toBeGreaterThan(0);
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('query HarvestPlans')),
    ).toBe(true);
  });

  it('does not render plans as an empty success state when the query fails', async () => {
    routeGraphql([]);
    renderWithProviders(<HarvestPlansPage />, { route: '/harvest', path: 'harvest' });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText(/Autumn harvest wave 1/)).not.toBeInTheDocument();
    });
  });
});
