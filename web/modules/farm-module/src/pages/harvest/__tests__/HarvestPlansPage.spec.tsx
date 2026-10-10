/**
 * HarvestPlansPage specs (FARM-MEDIUM-120 batch 7).
 *
 * Exercises the real useHarvestPlanList hook against the routed graphqlClient
 * seam: plan rows render from the backend list and a transport failure does
 * not render a fake-empty success state.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    // FARM-LOW-149: assert a second domain field renders, not just the name.
    expect((await screen.findAllByText(/HP-2026-001/)).length).toBeGreaterThan(0);
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

describe('HarvestPlansPage — completing a plan (FARM-HIGH-395 / FARM-HIGH-396)', () => {
  const IN_PROGRESS_PLAN = { ...PLAN, status: 'in_progress', canComplete: true };

  function routeWith(plan: typeof IN_PROGRESS_PLAN): void {
    routeGraphql([
      {
        match: 'query HarvestPlans',
        result: {
          harvestPlans: {
            items: [plan],
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
      { match: 'mutation CompleteHarvestPlan', result: { completeHarvestPlan: { ...plan, status: 'completed' } } },
    ]);
  }

  async function openCompleteModal(): Promise<HTMLElement> {
    renderWithProviders(<HarvestPlansPage />, { route: '/harvest', path: 'harvest' });
    const [menu] = await screen.findAllByRole('button', { name: 'More actions' });
    if (!menu) throw new Error('no plan action menu rendered');
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('button', { name: /Complete Harvest/ }));
    return screen.findByRole('dialog');
  }

  it('pre-fills the counted results from the plan estimates — never a 0 g weight', async () => {
    routeWith(IN_PROGRESS_PLAN);
    const dialog = await openCompleteModal();

    expect(within(dialog).getByDisplayValue('2500')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('5000')).toBeInTheDocument();
    expect(within(dialog).queryByDisplayValue('0')).not.toBeInTheDocument();
  });

  it('leaves a field empty (required) when the plan has no estimate for it', async () => {
    routeWith({
      ...IN_PROGRESS_PLAN,
      estimates: { estimatedQuantity: 5000, estimatedBiomass: 12500, estimatedAvgWeight: 0 },
    });
    const dialog = await openCompleteModal();

    expect(within(dialog).queryByDisplayValue('0')).not.toBeInTheDocument();
    const weight = within(dialog)
      .getAllByRole('spinbutton')
      .find((input) => input.getAttribute('max') === '100000');
    expect(weight).toHaveValue(null);
    expect(weight).toBeRequired();
  });

  it('sends one validated input with the quality class the operator picked', async () => {
    routeWith(IN_PROGRESS_PLAN);
    const dialog = await openCompleteModal();

    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'ORDINAER' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Complete Harvest' }));

    await waitFor(() => {
      const call = requestMock.mock.calls.find(([query]) =>
        (query as string).includes('mutation CompleteHarvestPlan'),
      );
      expect(call?.[1]).toEqual({
        input: {
          id: 'hp-1',
          actualQuantity: 5000,
          actualBiomass: 12500,
          actualAvgWeight: 2500,
          qualityClass: 'ORDINAER',
        },
      });
    });
  });
});
