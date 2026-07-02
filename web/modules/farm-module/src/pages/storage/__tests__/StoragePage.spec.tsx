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
  categoryTotals: [
    { category: 'FEED', totalQuantity: 900, totalValue: 90000, itemCount: 12 },
  ],
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
      currentQuantity: 100,
      minStock: 500,
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
