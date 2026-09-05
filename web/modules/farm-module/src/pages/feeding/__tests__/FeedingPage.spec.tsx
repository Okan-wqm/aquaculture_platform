/**
 * FeedingPage specs (FARM-MEDIUM-120 batch 3).
 *
 * Exercises the real useSiteList/useBatchList/useFeedingRecordsList hooks
 * against the routed graphqlClient seam: the searchParams-driven tab switch
 * loads the records tab with its own query, and an unknown tab falls back to
 * the default (meal board). Faz 8: legacy daily-plan/execution/protocols
 * sekmeleri ve v1 forecast sorgusu emekli — KPI başlığı v2
 * protocolFeedForecast snapshot'ını okur.
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
    {
      match: 'query FeedingRecords',
      result: {
        feedingRecords: { items: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
    { match: 'query Feeds', result: { feeds: { items: [], total: 0, page: 1, limit: 100, totalPages: 0 } } },
    { match: 'query FeedingDayPlans', result: { feedingDayPlans: [] } },
    { match: 'query ProtocolFeedForecast', result: { protocolFeedForecast: null } },
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
