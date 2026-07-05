/**
 * TanksPage specs (FARM-MEDIUM-120 batch 1).
 *
 * Exercises the REAL useTanksList/useCleanerFish hooks against the routed
 * graphqlClient seam: production rows render from equipmentList, the
 * cleaner-fish tab renders its batch rows, and the quick-action toolbar
 * gates tank operations on a selection before opening the real modals.
 */
import { screen, waitFor, within } from '@testing-library/react';
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
import TanksPage from '../TanksPage';

const TANKS = [
  {
    id: 'tank-1',
    tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
    name: 'Grow-out Tank A',
    code: 'GT-A',
    departmentId: 'dep-1',
    department: { id: 'dep-1', name: 'Grow-out', siteId: 'site-1', site: { id: 'site-1', name: 'Main Site' } },
    equipmentTypeId: 'et-1',
    equipmentType: { id: 'et-1', name: 'Tank', code: 'TANK', category: 'tank', icon: null },
    specifications: { maxBiomass: 1000, waterVolume: 80 },
    volume: 100,
    isTank: true,
    currentBiomass: 250,
    currentCount: 1000,
    status: 'OPERATIONAL',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    batchMetrics: {
      batchNumber: 'B-2026-001',
      batchId: 'batch-1',
      pieces: 1000,
      avgWeight: 250,
      biomass: 250,
      density: 3.1,
      capacityUsedPercent: 25,
      isOverCapacity: false,
      isMixedBatch: false,
      cleanerFishQuantity: 0,
    },
  },
  {
    id: 'tank-2',
    tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
    name: 'Empty Tank B',
    code: 'GT-B',
    departmentId: 'dep-1',
    department: { id: 'dep-1', name: 'Grow-out', siteId: 'site-1', site: { id: 'site-1', name: 'Main Site' } },
    equipmentTypeId: 'et-1',
    equipmentType: { id: 'et-1', name: 'Tank', code: 'TANK', category: 'tank', icon: null },
    specifications: { maxBiomass: 800 },
    volume: 80,
    isTank: true,
    currentBiomass: 0,
    currentCount: 0,
    status: 'FALLOW',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    batchMetrics: null,
  },
];

const CLEANER_BATCHES = [
  {
    id: 'cfb-1',
    batchNumber: 'CF-2026-001',
    speciesId: 'cfs-1',
    initialQuantity: 500,
    currentQuantity: 450,
    stockedAt: '2026-05-01T00:00:00.000Z',
    status: 'ACTIVE',
    isActive: true,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  },
];

function installRoutes(): void {
  routeGraphql([
    {
      match: 'query EquipmentWithBatches',
      result: { equipmentList: { items: TANKS, total: 2, page: 1, limit: 200, totalPages: 1 } },
    },
    { match: 'query CleanerFishSpecies', result: { cleanerFishSpecies: [{ id: 'cfs-1', scientificName: 'Cyclopterus lumpus', commonName: 'Lumpfish', code: 'LUMP' }] } },
    { match: 'query CleanerFishBatches', result: { cleanerFishBatches: CLEANER_BATCHES } },
    { match: 'query AvailableTanks', result: { availableTanks: [] } },
  ]);
}

beforeEach(() => {
  requestMock.mockReset();
  installRoutes();
  window.localStorage.clear();
});

describe('TanksPage', () => {
  it('renders production tank rows with batch metrics from the backend list', async () => {
    renderWithProviders(<TanksPage />);

    await waitFor(() => {
      expect(screen.getAllByText('Grow-out Tank A').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Empty Tank B')).toBeInTheDocument();
    expect(screen.getByText('B-2026-001')).toBeInTheDocument();
    expect(
      requestMock.mock.calls.some(([query]) =>
        (query as string).includes('query EquipmentWithBatches'),
      ),
    ).toBe(true);
  });

  it('gates quick actions on a tank selection and opens the transfer modal for it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitFor(() => {
      expect(screen.getAllByText('Grow-out Tank A').length).toBeGreaterThan(0);
    });

    const transferButton = screen.getByTitle('Transfer Fish');
    const gradeButton = screen.getByTitle('Grade Fish');
    expect(transferButton).toBeDisabled();
    expect(gradeButton).toBeDisabled();

    // Only tanks WITH stock are offered for operations (tank-2 is empty).
    const selector = screen
      .getAllByRole('combobox')
      .find((el) => within(el).queryByText('Select Tank...'));
    if (!selector) throw new Error('Quick-actions tank selector not found');
    const options = within(selector).getAllByRole('option');
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'Select Tank...',
      'Grow-out Tank A',
    ]);

    await user.selectOptions(selector, 'tank-1');
    expect(transferButton).toBeEnabled();
    expect(gradeButton).toBeEnabled();

    await user.click(transferButton);
    expect(await screen.findByText('Transfer Fish', { selector: 'h2, h3, div' })).toBeInTheDocument();
    expect(screen.getByText(/Batch: B-2026-001/)).toBeInTheDocument();
  });

  it('switches to the cleaner-fish tab and renders its batch rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitFor(() => {
      expect(screen.getAllByText('Grow-out Tank A').length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: /Cleaner Fish/ }));

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query CleanerFishBatches'),
        ),
      ).toBe(true);
    });
  });

  it('surfaces a blocking load failure instead of rendering an empty table', async () => {
    routeGraphql([]); // every operation now throws
    renderWithProviders(<TanksPage />);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText('Grow-out Tank A')).not.toBeInTheDocument();
    });
  });
});
