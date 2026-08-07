/**
 * The inspector is the board's most dangerous column, because it is the one that
 * states figures about a single pen. Two rules carry most of these tests:
 *
 *   1. A FAILED FETCH IS NOT A VERDICT. "This unit is not in the current
 *      inventory" from a screen that could not reach the farm is the exact
 *      substitution TankDetailPage shipped once (src/utils/loadable.ts lists it),
 *      and it sends a worker looking for a pen that is fine.
 *   2. NOTHING IS LOGGED FROM THE CABIN. The board's footer says entries are made
 *      standing at the unit; a "Log entry" button here would make that line
 *      decoration, so its absence is asserted rather than assumed.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { type ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnitInspectorPane } from '../UnitInspectorPane';

import type { BatchMetrics, Tank } from '@/types';

const mockUseTanks = vi.fn();
vi.mock('@/hooks/useTanks', () => ({ useTanks: (): unknown => mockUseTanks() }));

// The live-readings card and the three advisory cards own their own queries and
// have their own tests. Here they stand in for themselves so this file pins the
// INSPECTOR: which sections it composes, and in what order.
vi.mock('@/components/LiveReadingsCard', () => ({
  LiveReadingsCard: ({ tankId }: { tankId: string }): ReactElement => (
    <span data-testid="live-readings">{tankId}</span>
  ),
}));
vi.mock('@/components/ai', () => ({
  TankRiskBadge: ({ tankId }: { tankId: string }): ReactElement => (
    <span data-testid="risk">{tankId}</span>
  ),
  GrowthPredictionCard: ({ batchId }: { batchId: string }): ReactElement => (
    <span data-testid="growth">{batchId}</span>
  ),
  FeedingAdviceCard: ({ tankId }: { tankId: string }): ReactElement => (
    <span data-testid="feeding">{tankId}</span>
  ),
}));

const BASE_METRICS: BatchMetrics = {
  batchId: 'batch-7',
  batchNumber: 'B-7',
  speciesId: null,
  speciesName: null,
  pieces: 18_200,
  avgWeight: 681,
  biomass: 12_400,
  density: 28.4,
  capacityUsedPercent: 93,
  isOverCapacity: false,
  daysSinceStocking: 120,
};

function unit(id: string, overrides: Partial<Tank> = {}): Tank {
  return {
    id,
    name: 'North Pen 7',
    code: 'U-07',
    volume: 440,
    status: 'ACTIVE',
    siteId: 'site-a',
    currentQuantity: 18_200,
    currentBiomass: 12_400,
    maxBiomass: 14_000,
    batchMetrics: BASE_METRICS,
    ...overrides,
  };
}

function ready(units: Tank[]): unknown {
  return { data: units, isLoading: false, isError: false };
}

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderInspector(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <UnitInspectorPane />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTanks.mockReturnValue(ready([unit('tank-7')]));
});

afterEach(cleanup);

describe('UnitInspectorPane', () => {
  it('invites a selection when nothing is selected', () => {
    renderInspector('/board');

    expect(screen.getByText('No unit selected')).toBeTruthy();
    expect(screen.getByText('Choose a unit in the grid to inspect it here.')).toBeTruthy();
  });

  it('shows the selected unit named in the URL', () => {
    renderInspector('/board?unit=tank-7');

    expect(screen.getByText('U-07')).toBeTruthy();
    expect(screen.getByText('North Pen 7')).toBeTruthy();
    // The status word, not just the dot.
    expect(screen.getByText('Active')).toBeTruthy();
    // Unit-level standing biomass, in tonnes.
    expect(screen.getByText('12.4')).toBeTruthy();
  });

  it('composes the same measured and advisory sections the unit detail does', () => {
    renderInspector('/board?unit=tank-7');

    expect(screen.getByTestId('live-readings').textContent).toBe('tank-7');
    expect(screen.getByTestId('risk').textContent).toBe('tank-7');
    expect(screen.getByTestId('growth').textContent).toBe('batch-7');
    expect(screen.getByTestId('feeding').textContent).toBe('tank-7');
  });

  it('omits the growth forecast when the unit holds no batch', () => {
    mockUseTanks.mockReturnValue(ready([unit('tank-7', { batchMetrics: null })]));
    renderInspector('/board?unit=tank-7');

    expect(screen.getByText('No active batch')).toBeTruthy();
    expect(screen.queryByTestId('growth')).toBeNull();
  });

  it('says the unit list is unavailable rather than that the unit is missing', () => {
    // The defect this app has found seven times: an outage rendered as a fact
    // about the farm.
    mockUseTanks.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderInspector('/board?unit=tank-7');

    expect(screen.getByText('Could not load units')).toBeTruthy();
    expect(screen.queryByText('Unit not in this list')).toBeNull();
    expect(screen.queryByText('U-07')).toBeNull();
  });

  it('reports a genuinely absent unit as absent, and offers a way out', () => {
    renderInspector('/board?unit=tank-99');

    expect(screen.getByText('Unit not in this list')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByTestId('location').textContent).toBe('/board');
    expect(screen.getByText('No unit selected')).toBeTruthy();
  });

  it('renders an unconfigured consent capacity as unknown, never as a meter at zero', () => {
    mockUseTanks.mockReturnValue(
      ready([
        unit('tank-7', {
          batchMetrics: { ...BASE_METRICS, capacityUsedPercent: null, density: null },
        }),
      ]),
    );
    renderInspector('/board?unit=tank-7');

    expect(screen.queryByRole('meter')).toBeNull();
    expect(
      screen.getByText(
        'No consent capacity is configured for this unit, so density against consent cannot be shown.',
      ),
    ).toBeTruthy();
  });

  it('shows density against consent when the limit IS configured', () => {
    renderInspector('/board?unit=tank-7');

    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('93');
  });

  it('offers no way to log an entry — that happens on the handheld', () => {
    renderInspector('/board?unit=tank-7');

    expect(screen.queryByRole('button', { name: /log/i })).toBeNull();
  });
});
