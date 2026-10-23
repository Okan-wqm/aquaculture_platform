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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { useLocation } from 'react-router-dom';
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
    { match: 'query TemperatureScenarios', result: { temperatureScenarios: [] } },
    { match: 'query TankGrowthProjection', result: { tankGrowthProjection: [] } },
  ]);
}

/** Mirrors the router's `?tab=` into the DOM so a test can read what a click wrote. */
function LocationProbe(): React.ReactElement {
  return <output data-testid="location">{useLocation().search}</output>;
}

/** The page marks the tab it shows with this class; any other tab never carries it. */
const ACTIVE_TAB_CLASS = 'border-info-500';

function tabButtons(): HTMLElement[] {
  return within(screen.getByRole('navigation', { name: 'Tabs' })).getAllByRole('button');
}

function wasQueried(operation: string): boolean {
  return requestMock.mock.calls.some(([query]) => (query as string).includes(operation));
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

  // A tab the page draws must be a tab the page accepts. Production plan was in
  // the tab strip and the nav but not in the accepted set, so both its button
  // and its deep link landed on the meal board.
  it('opens the production plan tab for a ?tab=production-plan deep link, not the meal board', async () => {
    renderWithProviders(<FeedingPage />, {
      route: '/feeding?tab=production-plan',
      path: 'feeding',
    });

    await waitFor(() => {
      expect(wasQueried('query TemperatureScenarios')).toBe(true);
    });
    expect(wasQueried('query FeedingDayPlans')).toBe(false);
  });

  it('opens the production plan tab when its button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedingPage />, { route: '/feeding', path: 'feeding' });

    await user.click(await screen.findByRole('button', { name: /Production plan/i }));

    await waitFor(() => {
      expect(wasQueried('query TemperatureScenarios')).toBe(true);
    });
  });

  // Derived from the buttons the page renders, so a tab added tomorrow is
  // covered without touching this test.
  it('shows each tab it offers as the active one once that tab is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedingPage />, { route: '/feeding', path: 'feeding' });
    await screen.findByRole('navigation', { name: 'Tabs' });
    const tabCount = tabButtons().length;
    expect(tabCount).toBeGreaterThan(1);

    for (let index = 0; index < tabCount; index += 1) {
      await user.click(tabButtons()[index]);
      expect(tabButtons()[index]).toHaveClass(ACTIVE_TAB_CLASS);
    }
  });

  it('opens every tab it offers through the ?tab= its own click writes', async () => {
    const user = userEvent.setup();
    const clicking = renderWithProviders(
      <>
        <FeedingPage />
        <LocationProbe />
      </>,
      { route: '/feeding', path: 'feeding' },
    );
    await screen.findByRole('navigation', { name: 'Tabs' });
    const tabCount = tabButtons().length;
    const tabParams: string[] = [];
    for (let index = 0; index < tabCount; index += 1) {
      await user.click(tabButtons()[index]);
      tabParams.push(
        new URLSearchParams(screen.getByTestId('location').textContent ?? '').get('tab') ?? '',
      );
    }
    clicking.unmount();

    for (let index = 0; index < tabCount; index += 1) {
      const deepLink = renderWithProviders(<FeedingPage />, {
        route: `/feeding?tab=${tabParams[index]}`,
        path: 'feeding',
      });
      await screen.findByRole('navigation', { name: 'Tabs' });
      expect(tabButtons()[index]).toHaveClass(ACTIVE_TAB_CLASS);
      deepLink.unmount();
    }
  });
});
