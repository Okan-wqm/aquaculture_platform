/**
 * What the unit grid must never do is make a claim about the farm it cannot
 * support: report an empty site from a fetch that failed, or print "0 %"
 * capacity for a pen whose consent limit was never configured. Both are the
 * defect the Loadable type exists to prevent, one field down.
 *
 * The rest pin the board's own rules — selecting fills the right column and does
 * NOT navigate, and nothing here logs an entry — plus the grid's reason for
 * existing, which is that it groups by site and puts units side by side instead
 * of one per row.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { type ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnitGridPane } from '../UnitGridPane';

import type { BatchMetrics, Tank } from '@/types';

const mockUseTanks = vi.fn();
vi.mock('@/hooks/useTanks', () => ({ useTanks: (): unknown => mockUseTanks() }));

const BASE_METRICS: BatchMetrics = {
  batchId: 'batch-1',
  batchNumber: 'B-1',
  speciesId: null,
  speciesName: null,
  pieces: 12_500,
  avgWeight: 672,
  biomass: 8400,
  density: 28.4,
  capacityUsedPercent: 70,
  isOverCapacity: false,
  daysSinceStocking: 120,
};

function unit(id: string, overrides: Partial<Tank> = {}): Tank {
  return {
    id,
    name: id,
    code: id,
    volume: 100,
    status: 'ACTIVE',
    siteId: 'site-a',
    currentQuantity: 12_500,
    currentBiomass: 8400,
    maxBiomass: 12_000,
    batchMetrics: BASE_METRICS,
    ...overrides,
  };
}

function ready(units: Tank[]): unknown {
  return { data: units, isLoading: false, isError: false };
}

/** Where the router thinks we are — the proof that selecting is not navigating. */
function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderGrid(path = '/board'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <UnitGridPane />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** The cell for one unit — matched on the code it leads with. */
function cellFor(code: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(code) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTanks.mockReturnValue(ready([]));
});

afterEach(cleanup);

describe('UnitGridPane', () => {
  it('groups units by site and names the groups positionally', () => {
    // No site-name query exists on this client, so "Site 1" is what is known.
    mockUseTanks.mockReturnValue(ready([unit('U-01'), unit('U-02', { siteId: 'site-b' })]));
    renderGrid();

    expect(screen.getByText('Site 1')).toBeTruthy();
    expect(screen.getByText('Site 2')).toBeTruthy();
    expect(cellFor('U-01')).toBeTruthy();
    expect(cellFor('U-02')).toBeTruthy();
  });

  it('calls a single-site tenant "Units" rather than implying a second site', () => {
    mockUseTanks.mockReturnValue(ready([unit('U-01')]));
    renderGrid();

    expect(screen.getByText('Units')).toBeTruthy();
    expect(screen.queryByText('Site 1')).toBeNull();
  });

  it('says the units could not be loaded rather than showing an empty board', () => {
    mockUseTanks.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderGrid();

    expect(screen.getByText('Could not load units')).toBeTruthy();
    // A failure must never be dressed as an answer about the farm.
    expect(screen.queryByText('No units')).toBeNull();
    expect(screen.queryByRole('button', { name: /U-/ })).toBeNull();
  });

  it('keeps an empty tenant visibly different from an unreachable one', () => {
    renderGrid();

    expect(screen.getByText('No units')).toBeTruthy();
    expect(screen.queryByText('Could not load units')).toBeNull();
  });

  it('shows the unit-level totals, not the primary batch (ORPHAN-HIGH-585)', () => {
    // A mixed pen holds more than its primary batch reports; the cell reads the
    // container's own figures for exactly that reason.
    mockUseTanks.mockReturnValue(
      ready([
        unit('U-07', {
          currentBiomass: 12_400,
          currentQuantity: 18_200,
          batchMetrics: { ...BASE_METRICS, pieces: 900, biomass: 400 },
        }),
      ]),
    );
    renderGrid();

    const cell = cellFor('U-07');
    expect(cell.textContent).toContain('12.4');
    expect(cell.textContent).toContain('18.2K');
  });

  it('renders an unconfigured consent capacity as unknown, never as 0 %', () => {
    mockUseTanks.mockReturnValue(
      ready([
        unit('U-09', {
          batchMetrics: { ...BASE_METRICS, capacityUsedPercent: null, density: null },
        }),
      ]),
    );
    renderGrid();

    const cell = cellFor('U-09');
    expect(cell.textContent).toContain('—');
    expect(cell.textContent, 'a capacity nobody configured was reported as zero').not.toContain(
      '0 %',
    );
  });

  it('names the status in words, so the dot is never the only signal', () => {
    mockUseTanks.mockReturnValue(
      ready([unit('U-03', { name: 'North Pen 3', status: 'QUARANTINE' })]),
    );
    renderGrid();

    expect(screen.getByText('Quarantine · North Pen 3')).toBeTruthy();
  });

  it('flags an over-capacity unit in words as well as colour', () => {
    mockUseTanks.mockReturnValue(
      ready([
        unit('U-04', {
          batchMetrics: { ...BASE_METRICS, capacityUsedPercent: 104, isOverCapacity: true },
        }),
      ]),
    );
    renderGrid();

    expect(screen.getByText('Over capacity')).toBeTruthy();
  });

  it('selects a unit into the URL without leaving the board', () => {
    mockUseTanks.mockReturnValue(ready([unit('U-01')]));
    renderGrid();

    fireEvent.click(cellFor('U-01'));

    expect(screen.getByTestId('location').textContent).toBe('/board?unit=U-01');
    expect(cellFor('U-01').getAttribute('aria-pressed')).toBe('true');
  });

  it('clears the selection when the selected unit is chosen again', () => {
    // aria-pressed is only honest if the toggle toggles — and a cabin board
    // needs a way to put the right column back to neutral.
    mockUseTanks.mockReturnValue(ready([unit('U-01')]));
    renderGrid('/board?unit=U-01');

    expect(cellFor('U-01').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(cellFor('U-01'));

    expect(screen.getByTestId('location').textContent).toBe('/board');
    expect(cellFor('U-01').getAttribute('aria-pressed')).toBe('false');
  });

  it('offers no way to log an entry — that happens on the handheld', () => {
    mockUseTanks.mockReturnValue(ready([unit('U-01')]));
    renderGrid();

    expect(screen.queryByRole('button', { name: /log/i })).toBeNull();
  });
});
