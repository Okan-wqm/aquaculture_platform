/**
 * The unit's drives card, held to this app's oldest rule.
 *
 * "Could not fetch the drives" and "this pen has no drives" are DIFFERENT FACTS
 * and must never render alike. The same substitution has been found and fixed
 * seven times in this app (src/utils/loadable.ts lists five of them), and it is
 * worse here than anywhere it has appeared before: on a card about machinery,
 * an empty state reads as "nothing is running", which is an all-clear about a
 * feeder that the app has no evidence for.
 *
 * The third rule is the one specific to drives: a drive that has never reported
 * a reading is `State unknown`, never `Stopped`. It has not been OBSERVED to be
 * at rest, and telling a worker an auger is still while it is turning is the
 * failure this vocabulary exists to prevent.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnitDrivesCard } from '../UnitDrivesCard';

const mockUseUnitDrives = vi.fn();
vi.mock('@/hooks/useVfdDrives', () => ({
  useUnitDrives: (): unknown => mockUseUnitDrives(),
}));

function loading(): unknown {
  return { data: undefined, isLoading: true, isError: false };
}

function failed(): unknown {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error('Network request failed'),
    refetch: vi.fn(),
  };
}

function ready(drives: unknown[]): unknown {
  return {
    data: { vfdDevicesByTank: drives },
    isLoading: false,
    isError: false,
  };
}

function drive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vfd-1',
    name: 'Feeder A drive',
    brand: 'DANFOSS',
    status: 'ACTIVE',
    location: 'Cage row 1',
    connectionStatus: { isConnected: true },
    driveBinding: {
      drivenEquipmentId: 'eq-1',
      state: 'ATTESTED',
      equipmentCategory: 'feeding',
      equipmentCode: 'FDR-1',
      equipmentName: 'Feeder A',
      attestedAt: '2026-08-07T09:00:00Z',
    },
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
      parameters: { outputFrequency: 42.5, motorCurrent: 3.1 },
      statusBits: { running: true, fault: false },
    },
    ...overrides,
  };
}

function renderCard(): void {
  render(
    <MemoryRouter>
      <UnitDrivesCard tankId="u-1" />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockUseUnitDrives.mockReset();
});

describe('UnitDrivesCard', () => {
  it('says UNAVAILABLE on a failed fetch — never "no drives", never a zero', () => {
    mockUseUnitDrives.mockReturnValue(failed());
    renderCard();

    expect(screen.getByText('Drives unavailable')).toBeDefined();
    expect(screen.getByText(/unavailable, not empty/i)).toBeDefined();

    // The all-clear the app has no evidence for must be absent in every form.
    expect(screen.queryByText('No drives')).toBeNull();
    expect(screen.queryByText(/Stopped/)).toBeNull();
    expect(screen.queryByText(/Running/)).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('keeps the empty case visually and textually separate from the failure', () => {
    mockUseUnitDrives.mockReturnValue(ready([]));
    renderCard();

    // A successful fetch that found nothing states a CONFIGURATION fact.
    expect(screen.getByText('No drives')).toBeDefined();
    expect(screen.getByText(/No drive is bound to equipment serving this unit/i)).toBeDefined();
    expect(screen.queryByText('Drives unavailable')).toBeNull();
  });

  it('shows what each drive turns and what it is doing', () => {
    mockUseUnitDrives.mockReturnValue(ready([drive()]));
    renderCard();

    expect(screen.getByText('Feeder A drive')).toBeDefined();
    // The state is a WORD in the row, not only the tile's colour.
    expect(screen.getByText(/Running · Feeder for U-07/)).toBeDefined();
    // Measured values, exactly as reported — Hz and A, the two units every
    // brand config agrees on.
    expect(screen.getByText('42.5 Hz · 3.1 A')).toBeDefined();
  });

  it('renders a drive with no reading as UNKNOWN, not stopped', () => {
    mockUseUnitDrives.mockReturnValue(ready([drive({ latestReading: null })]));
    renderCard();

    expect(screen.getByText(/State unknown/)).toBeDefined();
    expect(screen.queryByText(/Stopped/)).toBeNull();
    // Nothing was measured, so nothing is shown — a "0.0 Hz" here would be a
    // reading this client invented.
    expect(screen.queryByText(/Hz/)).toBeNull();
  });

  it('distinguishes a genuinely stopped drive from an unobserved one', () => {
    mockUseUnitDrives.mockReturnValue(
      ready([
        drive({
          latestReading: {
            timestamp: '2026-08-07T10:00:00Z',
            isValid: true,
            errorMessage: null,
            parameters: {},
            statusBits: { running: false, fault: false },
          },
        }),
      ]),
    );
    renderCard();

    // `running: false` IS an observation, so this one is genuinely stopped.
    expect(screen.getByText(/Stopped/)).toBeDefined();
  });

  it('shows a skeleton while loading rather than an empty card', () => {
    mockUseUnitDrives.mockReturnValue(loading());
    renderCard();

    expect(screen.queryByText('No drives')).toBeNull();
    expect(screen.queryByText('Drives unavailable')).toBeNull();
  });
});
