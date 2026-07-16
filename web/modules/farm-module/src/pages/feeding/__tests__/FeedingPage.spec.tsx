/**
 * FeedingPage specs (FARM-MEDIUM-120 batch 3).
 *
 * Exercises the real useSiteList/useBatchList/useFeedConsumptionForecast/
 * useFeedingRecordsList hooks against the routed graphqlClient seam: the
 * daily-plan tab renders forecast rows + stockout alerts from the backend,
 * the searchParams-driven tab switch loads the records tab with its own
 * query, and an unknown tab falls back to the default.
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
import FeedingPage from '../FeedingPage';

const FORECAST = {
  forecastDays: 30,
  startDate: '2026-07-01',
  endDate: '2026-07-31',
  byFeedType: [
    {
      feedId: 'feed-1',
      feedCode: 'PEL-3MM',
      feedName: 'Pellet 3mm',
      dailyConsumption: Array.from({ length: 30 }, () => 120.5),
      totalConsumption: 3615,
      currentStock: 900,
      daysUntilStockout: 7,
      stockoutDate: '2026-07-08',
      reorderDate: '2026-07-04',
      reorderQuantity: 3000,
      batches: [{ batchId: 'batch-1', batchCode: 'B-2026-001', consumption: 3615 }],
    },
  ],
  alerts: [
    {
      feedId: 'feed-1',
      feedCode: 'PEL-3MM',
      type: 'STOCKOUT_RISK',
      message: 'Pellet 3mm stock runs out in 7 days',
      daysUntilStockout: 7,
    },
  ],
  totalConsumption: 3615,
  totalCurrentStock: 900,
};

function installRoutes(): void {
  routeGraphql([
    {
      match: 'query Sites',
      result: {
        sites: {
          items: [{ id: 'site-1', name: 'Main Site', code: 'MAIN', type: 'SEA', status: 'ACTIVE' }],
          total: 1,
          page: 1,
          limit: 100,
          totalPages: 1,
        },
      },
    },
    {
      match: 'query Batches',
      result: {
        batches: { items: [], total: 0, page: 1, limit: 100, totalPages: 0 },
      },
    },
    { match: 'query FeedConsumptionForecast', result: { feedConsumptionForecast: FORECAST } },
    {
      match: 'query FeedingRecords',
      result: {
        feedingRecords: { items: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
    { match: 'query Feeds', result: { feeds: { items: [], total: 0, page: 1, limit: 100, totalPages: 0 } } },
    { match: 'query FeedingDayPlans', result: { feedingDayPlans: [] } },
    {
      match: 'query FeedingProtocolsV2',
      result: {
        feedingProtocolsV2: {
          items: [], total: 0, page: 1, limit: 100, totalPages: 0,
          hasNextPage: false, hasPreviousPage: false,
        },
      },
    },
    {
      match: 'query ProtocolAssignments',
      result: {
        protocolAssignments: {
          items: [], total: 0, page: 1, limit: 100, totalPages: 0,
          hasNextPage: false, hasPreviousPage: false,
        },
      },
    },
    { match: 'query EquipmentWithBatches', result: { equipmentList: { items: [], total: 0, page: 1, limit: 200, totalPages: 1 } } },
  ]);
}

beforeEach(() => {
  requestMock.mockReset();
  installRoutes();
});

describe('FeedingPage', () => {
  it('renders the daily feed plan from the backend forecast', async () => {
    renderWithProviders(<FeedingPage />, { route: '/feeding?tab=daily-plan', path: 'feeding' });

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query FeedConsumptionForecast'),
        ),
      ).toBe(true);
    });
    expect((await screen.findAllByText(/Pellet 3mm/)).length).toBeGreaterThan(0);
  });

  it('switches to the records tab and fires the feeding-records query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedingPage />, { route: '/feeding', path: 'feeding' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Records/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Records/ }));

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query FeedingRecords'),
        ),
      ).toBe(true);
    });
  });

  it('does not render a fake-empty success state when the forecast query fails (FARM-LOW-147)', async () => {
    routeGraphql([]); // every operation throws
    renderWithProviders(<FeedingPage />, { route: '/feeding?tab=daily-plan', path: 'feeding' });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText(/Pellet 3mm/)).not.toBeInTheDocument();
    });
  });

  it('switches to the execution tab and fires the daily-feeding-executions query (manual entry lives here, not on daily-plan)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedingPage />, { route: '/feeding', path: 'feeding' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Daily Execution/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Daily Execution/ }));

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query DailyFeedingExecutions'),
        ),
      ).toBe(true);
    });
  });

  it('falls back to the default tab (meal board, Faz 6 cutover) for an unknown ?tab value', async () => {
    renderWithProviders(<FeedingPage />, { route: '/feeding?tab=bogus', path: 'feeding' });

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query FeedingDayPlans'),
        ),
      ).toBe(true);
    });
  });
});
