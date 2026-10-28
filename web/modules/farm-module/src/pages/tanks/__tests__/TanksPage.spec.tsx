/**
 * TanksPage specs — table view + tank detail drawer.
 *
 * Exercises the REAL useTanksList/useCleanerFish hooks against the routed
 * graphqlClient seam: the Üretim/Temizlikçi-balık tabs, the single-row filter
 * bar (site · category · stocked/empty), the dense unit table, and the
 * click-to-open right-side drawer that carries the metrics grid, live
 * sensor readings and the operation buttons the old page-level quick-actions
 * toolbar held. The sampling weigh-in path pins the recordGrowthSample
 * contract (≥3 individual weights).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock, TEST_USER_ID } from '../../../test-utils/sharedUiMock';
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
    department: {
      id: 'dep-1',
      name: 'Grow-out',
      siteId: 'site-1',
      site: { id: 'site-1', name: 'Main Site' },
    },
    equipmentTypeId: 'et-1',
    equipmentType: { id: 'et-1', name: 'Tank', code: 'TANK', category: 'tank', icon: null },
    temperatureSensorId: 'sensor-1',
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
      maxDensityRef: undefined,
      capacityUsedPercent: 25,
      isOverCapacity: false,
      isMixedBatch: false,
      survivalRate: 98.9,
      daysSinceStocking: 7,
      speciesCode: 'SPS',
      feedName: 'Starter Feed',
      feedingRatePercent: 3,
      dailyFeedKg: 2.96,
      lastFeedingAt: '2026-10-18T08:00:00.000Z',
      cleanerFishQuantity: 0,
    },
  },
  {
    id: 'tank-2',
    tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
    name: 'Empty Tank B',
    code: 'GT-B',
    departmentId: 'dep-1',
    department: {
      id: 'dep-1',
      name: 'Grow-out',
      siteId: 'site-1',
      site: { id: 'site-1', name: 'Main Site' },
    },
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
  {
    id: 'tank-3',
    tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
    name: 'Sea Cage C',
    code: 'CAGE-C',
    departmentId: 'dep-2',
    department: {
      id: 'dep-2',
      name: 'Grow-out Sea',
      siteId: 'site-2',
      site: { id: 'site-2', name: 'Sea Site' },
    },
    equipmentTypeId: 'et-2',
    equipmentType: { id: 'et-2', name: 'Cage', code: 'CAGE', category: 'cage', icon: null },
    specifications: {},
    volume: 500,
    isTank: false,
    currentBiomass: 74.98,
    currentCount: 2490,
    status: 'OPERATIONAL',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    batchMetrics: {
      batchNumber: 'B-2026-002',
      batchId: 'batch-2',
      pieces: 2490,
      avgWeight: 30.11,
      biomass: 74.98,
      speciesCode: 'LBRX',
      cleanerFishQuantity: 0,
    },
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
      result: { equipmentList: { items: TANKS, total: 3, page: 1, limit: 200, totalPages: 1 } },
    },
    {
      match: 'query SpeciesList',
      result: {
        speciesList: {
          items: [
            { code: 'SPS', commonName: 'Sea bream', localName: 'Çipura' },
            { code: 'LBRX', commonName: 'European Seabass', localName: 'Levrek' },
          ],
        },
      },
    },
    {
      match: 'query CleanerFishSpecies',
      result: {
        cleanerFishSpecies: [
          {
            id: 'cfs-1',
            scientificName: 'Cyclopterus lumpus',
            commonName: 'Lumpfish',
            code: 'LUMP',
          },
        ],
      },
    },
    { match: 'query CleanerFishBatches', result: { cleanerFishBatches: CLEANER_BATCHES } },
    { match: 'query AvailableTanks', result: { availableTanks: [] } },
    {
      match: 'query GetLatestReadingsBatch',
      result: {
        latestReadingsBatch: [
          {
            sensorId: 'sensor-1',
            timestamp: '2026-10-18T18:24:22.677Z',
            readings: { temperature: 22.2, dissolvedOxygen: 6.75 },
          },
        ],
      },
    },
    {
      match: 'query FeedingDayPlans',
      result: {
        feedingDayPlans: [{ id: 'fdp-1', unitId: 'tank-1', mealsPlanned: 8, plannedTotalKg: 2.96 }],
      },
    },
    {
      match: 'mutation RecordGrowthSample',
      result: (variables) => ({
        recordGrowthSample: {
          id: 'gm-1',
          ...(variables?.input as Record<string, unknown>),
        },
      }),
    },
  ]);
}

beforeEach(() => {
  requestMock.mockReset();
  installRoutes();
  window.localStorage.clear();
});

async function waitForTable(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText('GT-A')).toBeInTheDocument();
  });
}

function rowOf(code: string): HTMLElement {
  const cell = screen.getByText(code);
  const row = cell.closest('tr');
  if (!row) throw new Error(`Row for ${code} not found`);
  return row;
}

describe('TanksPage', () => {
  it('renders the view tabs, search and the single-row filter bar', async () => {
    renderWithProviders(<TanksPage />);
    await waitForTable();

    // View tabs at the very top
    expect(screen.getByRole('button', { name: /^Production/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cleaner fish/ })).toBeInTheDocument();

    // Search box
    expect(screen.getByPlaceholderText('Search unit, batch or feed…')).toBeInTheDocument();

    // One filter bar: site buttons, category buttons, stocked/empty buttons
    expect(screen.getByRole('button', { name: 'All sites' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Main Site' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sea Site' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tanks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stocked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Empty' })).toBeInTheDocument();

    // Status filter select (legacy toolbar feature kept in the filter row)
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    // Column-visibility menu reflects the 9 design defaults / 30-column model
    expect(screen.getByRole('button', { name: /Columns \(9\/30\)/ })).toBeInTheDocument();

    // Table headers + rows with unit/batch columns
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual([
      'Unit',
      'Batch',
      'Fish',
      'Avg. weight',
      'Biomass',
      'Density · capacity',
      'FCR',
      'Survival',
      'Last fed',
    ]);
    expect(within(rowOf('GT-A')).getByText('B-2026-001')).toBeInTheDocument();
    expect(within(rowOf('GT-A')).getByText('Çipura')).toBeInTheDocument();
    expect(within(rowOf('GT-A')).getByText('Grow-out · Main Site')).toBeInTheDocument();
    expect(within(rowOf('GT-B')).getByText('Empty — ready to stock')).toBeInTheDocument();
  });

  it('opens the tank detail drawer on row click with metrics, live readings and operations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    await user.click(rowOf('GT-A'));

    // Location header, big unit code and the batch line (batch in its own
    // bold node — match the wrapping line by textContent)
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('Grow-out · Main Site')).toBeInTheDocument();
    expect(within(drawer).getByText('GT-A')).toBeInTheDocument();
    expect(
      within(drawer).getByText(
        (_, el) => el?.textContent === 'B-2026-001 · Çipura · Stocked · 7 days',
      ),
    ).toBeInTheDocument();

    // Metrics grid incl. live sensor readings through the linked sensor
    expect(within(drawer).getAllByText('1,000').length).toBeGreaterThan(0);
    expect(within(drawer).getAllByText(/22.2 °C/).length).toBeGreaterThan(0);
    expect(within(drawer).getAllByText(/6.8 mg\/L/).length).toBeGreaterThan(0);

    // Feeding block
    expect(within(drawer).getByText('Feeding')).toBeInTheDocument();
    expect(within(drawer).getByText('Starter Feed')).toBeInTheDocument();
    // Daily ration carries the unit's planned meal count (feeding v2 day plan)
    expect(within(drawer).getByText('2.96 kg · 8 meals')).toBeInTheDocument();

    // Operation buttons live in the drawer (not a page toolbar)
    for (const label of [
      'Record mortality',
      'Sampling weigh-in',
      'Transfer / split',
      'Grading',
      'Open feeding plan',
    ]) {
      expect(within(drawer).getByRole('button', { name: label })).toBeEnabled();
    }
  });

  it('offers "stock this unit" for an empty unit instead of operations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    await user.click(rowOf('GT-B'));

    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('Empty — ready to stock')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Stock this unit' })).toBeInTheDocument();
    expect(
      within(drawer).queryByRole('button', { name: 'Record mortality' }),
    ).not.toBeInTheDocument();
  });

  it('filters the table from the single-row buttons (site, category, stocked/empty)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    // Occupancy: Empty keeps only the unstocked unit
    await user.click(screen.getByRole('button', { name: 'Empty' }));
    expect(screen.getByText('GT-B')).toBeInTheDocument();
    expect(screen.queryByText('GT-A')).not.toBeInTheDocument();
    expect(screen.queryByText('CAGE-C')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'All' })[1]);

    // Category: Cages keeps only the cage
    await user.click(screen.getByRole('button', { name: 'Cages' }));
    expect(screen.getByText('CAGE-C')).toBeInTheDocument();
    expect(screen.queryByText('GT-A')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'All' })[0]);

    // Site: Sea Site keeps only the sea cage
    await user.click(screen.getByRole('button', { name: 'Sea Site' }));
    expect(screen.getByText('CAGE-C')).toBeInTheDocument();
    expect(screen.queryByText('GT-A')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All sites' }));

    // Category again: Tanks keeps both tanks, drops the cage
    await user.click(screen.getByRole('button', { name: 'Tanks' }));
    expect(screen.getByText('GT-A')).toBeInTheDocument();
    expect(screen.getByText('GT-B')).toBeInTheDocument();
    expect(screen.queryByText('CAGE-C')).not.toBeInTheDocument();
  });

  it('opens the real mortality modal from the drawer for the clicked unit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    await user.click(rowOf('GT-A'));
    await user.click(screen.getByRole('button', { name: 'Record mortality' }));

    // The modal renders its title in more than one slot (heading + dialog name)
    const mortalityTitles = await screen.findAllByText('Record Mortality');
    expect(mortalityTitles.length).toBeGreaterThan(0);
    expect(screen.getByText(/Batch: B-2026-001/)).toBeInTheDocument();
  });

  it('records a sampling weigh-in through recordGrowthSample with 3 individual weights', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    await user.click(rowOf('GT-A'));
    await user.click(screen.getByRole('button', { name: 'Sampling weigh-in' }));

    // The drawer stays mounted underneath — scope to the sampling dialog
    const dialog = screen.getByRole('dialog', { name: 'Sampling weigh-in' });
    const weightInputs = within(dialog).getAllByRole('spinbutton', {
      name: /Sampled fish weights/i,
    });
    expect(weightInputs).toHaveLength(3);

    // Submit is blocked until all three weights are entered
    const submit = within(dialog).getByRole('button', { name: 'Save sample' });
    expect(submit).toBeDisabled();

    await user.type(weightInputs[0], '240');
    await user.type(weightInputs[1], '250');
    await user.type(weightInputs[2], '260');
    expect(submit).toBeEnabled();

    // Computed preview from the sample
    expect(await within(dialog).findByText(/Sample average: 250 g/)).toBeInTheDocument();

    await user.click(submit);
    await waitFor(() => {
      const call = requestMock.mock.calls.find(([query]) =>
        (query as string).includes('mutation RecordGrowthSample'),
      );
      expect(call).toBeDefined();
      const input = call?.[1] as { input: Record<string, unknown> };
      expect(input.input.batchId).toBe('batch-1');
      expect(input.input.individualMeasurements).toHaveLength(3);
      expect(input.input.updateBatchWeight).toBe(true);
      // FARM-HIGH-482 — the wire contract: enum NAMES (a lowercase value dies at
      // variable coercion) and the measurer as a user id (a name is not a uuid).
      expect(input.input.measurementType).toBe('ROUTINE');
      expect(input.input.measurementMethod).toBe('MANUAL_SCALE');
      expect(input.input.measuredBy).toBe(TEST_USER_ID);
    });
  });

  it('extends the table from the 9 design defaults to all 30 columns via the menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    // 9 design columns render by default
    expect(screen.getAllByRole('columnheader')).toHaveLength(9);
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();

    // Open the column menu and enable an opt-in column
    await user.click(screen.getByRole('button', { name: /Columns \(9\/30\)/ }));
    await user.click(screen.getByText('Status'));
    await waitFor(() => {
      expect(screen.getAllByRole('columnheader').some((th) => th.textContent === 'Status')).toBe(
        true,
      );
    });

    // "Show all" reaches the full 30-column model
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => {
      expect(screen.getAllByRole('columnheader')).toHaveLength(30);
    });
  });

  it('filters by unit status from the filter-row select', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'OPERATIONAL');

    // GT-B is FALLOW — filtered out; the operational units stay
    expect(screen.getByText('GT-A')).toBeInTheDocument();
    expect(screen.queryByText('GT-B')).not.toBeInTheDocument();
  });

  it('renders the cleaner-fish per-batch columns on the cleaner tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TanksPage />);
    await waitForTable();

    await user.click(screen.getByRole('button', { name: /^Cleaner fish/ }));

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query CleanerFishBatches'),
        ),
      ).toBe(true);
    });

    // Tank-level + per-batch cleaner columns render (defaults of the cf model)
    const headers = screen
      .getAllByRole('columnheader')
      .map((th) => th.textContent)
      .filter((text): text is string => text !== null && text !== '');
    expect(headers).toEqual([
      'Unit',
      'Volume (m³)',
      'CF batch #',
      'CF species',
      'CF quantity',
      'CF avg wt (g)',
      'CF biomass (kg)',
    ]);
    expect(screen.getByRole('button', { name: /Create batch/ })).toBeInTheDocument();
    // CLEANER_BATCHES has one ACTIVE batch with stock, so deploy is offered
    expect(screen.getByRole('button', { name: /Deploy to tank/ })).toBeEnabled();
  });

  it('surfaces a blocking load failure instead of rendering an empty table', async () => {
    routeGraphql([]); // every operation now throws
    renderWithProviders(<TanksPage />);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText('GT-A')).not.toBeInTheDocument();
    });
  });
});
