/**
 * StoragePage specs (FARM-MEDIUM-120 batch 5).
 *
 * Exercises the real useStorageOverview hook against the routed graphqlClient
 * seam: the overview tab renders stock totals + low-stock alerts from the
 * backend, and tab switching fires the storage-locations query.
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
import StoragePage from '../StoragePage';

const OVERVIEW = {
  totalStockValue: 125000,
  totalItems: 42,
  lowStockAlertCount: 1,
  recentMovementsCount: 7,
  categoryTotals: [{ category: 'FEED', totalQuantity: 900, totalValue: 90000, itemCount: 12 }],
  locationFillRates: [
    {
      locationId: 'loc-1',
      locationName: 'Feed Silo 1',
      locationType: 'SILO',
      capacity: 1000,
      capacityUnit: 'kg',
      usedCapacity: 900,
      fillPercentage: 90,
    },
  ],
  lowStockAlerts: [
    {
      itemId: 'feed-1',
      itemName: 'Pellet 3mm',
      itemType: 'FEED',
      level: 'SITE',
      siteId: 'site-1',
      siteName: 'Bodø North',
      currentQuantity: 100,
      minStock: 500,
      onOrderQuantity: 0,
      unit: 'kg',
    },
    {
      itemId: 'feed-1',
      itemName: 'Pellet 3mm',
      itemType: 'FEED',
      level: 'POOL',
      siteId: null,
      siteName: null,
      currentQuantity: 900,
      minStock: 1000,
      onOrderQuantity: 50,
      unit: 'kg',
    },
  ],
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    { match: 'query StorageOverview', result: { storageOverview: OVERVIEW } },
    {
      match: 'query StorageLocations',
      result: {
        storageLocations: { items: [], total: 0, page: 1, limit: 100, totalPages: 0 },
      },
    },
    { match: 'query StorageInventory', result: { storageInventory: [] } },
  ]);
});

describe('StoragePage', () => {
  it('renders the storage overview from the backend', async () => {
    renderWithProviders(<StoragePage />, { route: '/storage', path: 'storage' });

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query StorageOverview'),
        ),
      ).toBe(true);
    });
    expect((await screen.findAllByText(/Feed Silo 1/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Pellet 3mm/)).length).toBeGreaterThan(0);
  });

  it('shows the site tier and the pool tier of one item as two distinct rows (plan K8)', async () => {
    // SCENARIO: Pellet 3mm is short at site Bodø North AND in the tenant pool
    // (50 kg on order). EXPECTS: two rows, one naming the site, one the pool
    // with its open-order remainder — not one row overwriting the other.
    renderWithProviders(<StoragePage />, { route: '/storage', path: 'storage' });

    expect(await screen.findByText(/Site: Bodø North/)).toBeInTheDocument();
    expect(await screen.findByText(/All sites \(pool\)/)).toBeInTheDocument();
    expect(await screen.findByText(/\+50 kg on order/)).toBeInTheDocument();
  });

  it('does not render the overview as a fake-empty success state when the query fails (FARM-LOW-147)', async () => {
    routeGraphql([]);
    renderWithProviders(<StoragePage />, { route: '/storage', path: 'storage' });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText(/Feed Silo 1/)).not.toBeInTheDocument();
    });
  });

  it('switches to the locations tab and fires its query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StoragePage />, { route: '/storage', path: 'storage' });
    await waitFor(() => expect(requestMock).toHaveBeenCalled());

    const locationsTab = await screen.findByRole('button', { name: /Locations|Depolar|Lokasyon/i });
    await user.click(locationsTab);

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query StorageLocations'),
        ),
      ).toBe(true);
    });
  });
});
