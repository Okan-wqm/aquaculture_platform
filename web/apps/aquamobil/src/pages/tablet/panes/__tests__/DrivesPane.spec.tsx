/**
 * The board's drives strip — the design's feeders row, on the surface where an
 * all-clear is most expensive.
 *
 * A cabin tablet is on the wall so somebody notices a problem. "None faulted"
 * from a board that could not reach the sensor service is exactly the claim it
 * must never make, and it is the same rule the shell's AlarmsChip follows one
 * layer up. The strip's own scope note is asserted too: it follows the board's
 * selection because no query returns the full drive shape for many units at
 * once, and a board that showed a blank strip without saying why would read as
 * broken.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DrivesPane } from '../DrivesPane';

const mockUseVfdFleetSummary = vi.fn();
const mockUseUnitDrives = vi.fn();
vi.mock('@/hooks/useVfdDrives', () => ({
  useVfdFleetSummary: (): unknown => mockUseVfdFleetSummary(),
  useUnitDrives: (): unknown => mockUseUnitDrives(),
}));

let selectedUnitId: string | null = null;
vi.mock('../../useSelectedUnit', () => ({
  useSelectedUnit: (): { selectedUnitId: string | null; selectUnit: () => void } => ({
    selectedUnitId,
    selectUnit: vi.fn(),
  }),
}));

const IDLE = { data: undefined, isLoading: false, isError: false };

function stats(overrides: Record<string, number> = {}): unknown {
  return {
    data: {
      vfdStats: { total: 8, active: 6, inactive: 2, faulted: 0, maintenance: 0, ...overrides },
    },
    isLoading: false,
    isError: false,
  };
}

function drivesReady(rows: unknown[]): unknown {
  return { data: { vfdDevicesByTank: rows }, isLoading: false, isError: false };
}

function drive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vfd-1',
    name: 'Feeder A drive',
    brand: 'DANFOSS',
    status: 'ACTIVE',
    location: null,
    connectionStatus: null,
    driveBinding: null,
    drivenUnit: {
      outcome: 'FEEDER_UNIT',
      drivenEquipmentId: 'eq-1',
      equipmentCategory: 'feeding',
      units: [{ unitId: 'u-1', unitCode: 'U-07', unitType: 'CAGE', doseSharePercent: 100 }],
    },
    latestReading: {
      timestamp: '2026-08-07T10:00:00Z',
      isValid: true,
      errorMessage: null,
      parameters: { outputFrequency: 38.2 },
      statusBits: { running: true, fault: false },
    },
    ...overrides,
  };
}

function renderPane(): void {
  render(
    <MemoryRouter>
      <DrivesPane />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockUseVfdFleetSummary.mockReset();
  mockUseUnitDrives.mockReset();
  selectedUnitId = null;
});

describe('DrivesPane', () => {
  it('never claims "none faulted" when the counts could not be fetched', () => {
    mockUseVfdFleetSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network request failed'),
      refetch: vi.fn(),
    });
    mockUseUnitDrives.mockReturnValue(IDLE);
    renderPane();

    expect(screen.getByText('Drive counts unavailable')).toBeDefined();
    expect(screen.queryByText('None faulted')).toBeNull();
    expect(screen.queryByText(/0 faulted/)).toBeNull();
    expect(screen.queryByText(/active/)).toBeNull();
  });

  it('states the fleet counts it did fetch', () => {
    mockUseVfdFleetSummary.mockReturnValue(stats({ faulted: 2 }));
    mockUseUnitDrives.mockReturnValue(IDLE);
    renderPane();

    expect(screen.getByText('8 drives')).toBeDefined();
    expect(screen.getByText('6 active')).toBeDefined();
    expect(screen.getByText('2 faulted')).toBeDefined();
  });

  it('explains why the strip follows the selection instead of showing nothing', () => {
    mockUseVfdFleetSummary.mockReturnValue(stats());
    mockUseUnitDrives.mockReturnValue(IDLE);
    renderPane();

    expect(screen.getByText(/only queryable one unit at a time/i)).toBeDefined();
  });

  it('shows the selected unit’s drives with state and measurement', () => {
    selectedUnitId = 'u-1';
    mockUseVfdFleetSummary.mockReturnValue(stats());
    mockUseUnitDrives.mockReturnValue(drivesReady([drive()]));
    renderPane();

    expect(screen.getByText('Feeder A drive')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Feeder for U-07')).toBeDefined();
    expect(screen.getByText('38.2 Hz')).toBeDefined();
  });

  it('says UNAVAILABLE, not "no drives", when the unit fetch fails', () => {
    selectedUnitId = 'u-1';
    mockUseVfdFleetSummary.mockReturnValue(stats());
    mockUseUnitDrives.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network request failed'),
      refetch: vi.fn(),
    });
    renderPane();

    expect(screen.getByText('Drives unavailable')).toBeDefined();
    expect(screen.queryByText(/No drive is bound/)).toBeNull();
    expect(screen.queryByText(/Running|Stopped/)).toBeNull();
  });

  it('offers no command control — the cabin watches, the handheld acts', () => {
    selectedUnitId = 'u-1';
    mockUseVfdFleetSummary.mockReturnValue(stats());
    mockUseUnitDrives.mockReturnValue(drivesReady([drive()]));
    renderPane();

    // Starting an auger from a desk is starting a machine nobody is standing
    // next to — the same hazard the offline-queue ban prevents, by another door.
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
  });
});
