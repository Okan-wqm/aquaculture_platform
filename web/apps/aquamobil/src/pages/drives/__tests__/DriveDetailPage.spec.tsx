/**
 * The drive detail is the most dangerous screen in this client, because it is
 * the only one that moves a machine. Four rules carry these tests:
 *
 *   1. A REFUSING DRIVE SAYS WHY. A VFD that is unbound, unattested or stale is
 *      refused server-side by `assertActuable`. An operator pressing Stop and
 *      getting a spinner that ends in nothing learns that the app is broken; the
 *      truth is that the drive is not safe to command, and only the reason
 *      distinguishes those.
 *   2. A FAILED FETCH IS NOT A VERDICT. "Drive not found" from a screen that
 *      could not reach the sensor service is the seven-times-found substitution
 *      this app has a whole type to prevent.
 *   3. NO NUMBER IS INVENTED. A drive that reported nothing shows nothing — not
 *      a zero, and not the drive PERCENTAGE the v4 design asks for, which no
 *      brand-neutral field carries.
 *   4. THE ROLE FLOOR IS THE SERVER'S. A role that cannot command sees no
 *      buttons and is told why, rather than pressing one the server will reject.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DriveDetailPage } from '../DriveDetailPage';

const mockUseVfdDrive = vi.fn();
const mockUseFeederSetup = vi.fn();
vi.mock('@/hooks/useVfdDrives', () => ({
  useVfdDrive: (): unknown => mockUseVfdDrive(),
  useFeederSetup: (): unknown => mockUseFeederSetup(),
}));

const mockSend = vi.fn();
let commandState = {
  isSending: false,
  outcome: null as { status: string; message: string } | null,
  canCommand: true,
  isOnline: true,
};
vi.mock('@/hooks/useVfdCommand', () => ({
  useVfdCommand: (): unknown => ({
    send: mockSend,
    clearOutcome: vi.fn(),
    ...commandState,
  }),
  OFFLINE_REFUSAL_MESSAGE: 'Not sent: this device is offline.',
}));

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
      timestamp: new Date().toISOString(),
      isValid: true,
      errorMessage: null,
      parameters: { outputFrequency: 42.5, motorCurrent: 3.1 },
      statusBits: { running: true, fault: false },
    },
    ...overrides,
  };
}

function ready(vfdDevice: unknown): unknown {
  return { data: { vfdDevice }, isLoading: false, isError: false, refetch: vi.fn() };
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/drives/vfd-1']}>
      <Routes>
        <Route path="/drives/:vfdDeviceId" element={<DriveDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockUseVfdDrive.mockReset();
  mockUseFeederSetup.mockReset();
  mockSend.mockReset();
  commandState = { isSending: false, outcome: null, canCommand: true, isOnline: true };
});

describe('DriveDetailPage', () => {
  it('shows the SERVER REASON when the drive refuses commands', () => {
    // A drive bound to equipment the owning service has not confirmed. This is
    // the exact case assertActuable declines.
    mockUseVfdDrive.mockReturnValue(
      ready(
        drive({
          driveBinding: {
            drivenEquipmentId: 'eq-1',
            state: 'PENDING',
            equipmentCategory: null,
            equipmentCode: null,
            equipmentName: null,
            attestedAt: null,
          },
          drivenUnit: {
            outcome: 'UNATTESTED',
            drivenEquipmentId: 'eq-1',
            equipmentCategory: null,
            units: [],
          },
        }),
      ),
    );
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(
      screen.getByText(/has not confirmed it yet, so the server will not command it/i),
    ).toBeDefined();
    // The controls stay visible underneath, so the refusal reads as a fact about
    // the DRIVE rather than a broken screen.
    expect(screen.getByRole('button', { name: /Stop/ })).toBeDefined();
  });

  it('names the reason for an UNBOUND drive specifically', () => {
    mockUseVfdDrive.mockReturnValue(
      ready(
        drive({
          driveBinding: null,
          drivenUnit: {
            outcome: 'UNBOUND',
            drivenEquipmentId: null,
            equipmentCategory: null,
            units: [],
          },
        }),
      ),
    );
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.getByText(/not bound to the equipment it turns/i)).toBeDefined();
    expect(screen.getByText('Not bound to any equipment')).toBeDefined();
  });

  it('does NOT refuse a pump, which legitimately serves no unit', () => {
    mockUseVfdDrive.mockReturnValue(
      ready(
        drive({
          drivenUnit: {
            outcome: 'NOT_A_FEEDER',
            drivenEquipmentId: 'eq-2',
            equipmentCategory: 'pump',
            units: [],
          },
        }),
      ),
    );
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    // "No unit" is an ANSWER here, not a failure — the server actuates a pump.
    expect(screen.getByText(/Drives pump equipment — serves no unit/)).toBeDefined();
    expect(screen.queryByText(/will not command it/i)).toBeNull();
  });

  it('renders UNAVAILABLE on a failed fetch — never "drive not found"', () => {
    mockUseVfdDrive.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Network request failed'),
      refetch: vi.fn(),
    });
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.getByText('Could not load this drive')).toBeDefined();
    expect(screen.getByText(/unavailable, not empty/i)).toBeDefined();
    // The claims the app cannot support must be absent in every form.
    expect(screen.queryByText('Drive not found')).toBeNull();
    expect(screen.queryByText(/Running|Stopped|State unknown/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
  });

  it('shows only what the drive reported, and no invented percentage', () => {
    mockUseVfdDrive.mockReturnValue(ready(drive()));
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.getByText('42.50')).toBeDefined();
    expect(screen.getByText('Hz')).toBeDefined();
    expect(screen.getByText('3.10')).toBeDefined();
    // No speed/power was reported, so neither appears — and no percentage does,
    // because no brand-neutral field carries one.
    expect(screen.queryByText('RPM')).toBeNull();
    expect(screen.queryByText('kW')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('states that a drive with no reading has an UNKNOWN state', () => {
    mockUseVfdDrive.mockReturnValue(ready(drive({ latestReading: null })));
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.getByText('State unknown')).toBeDefined();
    expect(screen.getByText(/has not been observed to be stopped/i)).toBeDefined();
  });

  it('surfaces a fault with its code rather than a bare red dot', () => {
    mockUseVfdDrive.mockReturnValue(
      ready(
        drive({
          latestReading: {
            timestamp: new Date().toISOString(),
            isValid: true,
            errorMessage: null,
            parameters: { outputFrequency: 0, faultCode: 27 },
            statusBits: { running: false, fault: true },
          },
        }),
      ),
    );
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.getByText('Faulted')).toBeDefined();
    expect(screen.getByText(/Fault code 27/)).toBeDefined();
  });

  it('hides the controls for a role below the server floor, and says why', () => {
    commandState = { isSending: false, outcome: null, canCommand: false, isOnline: true };
    mockUseVfdDrive.mockReturnValue(ready(drive()));
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
    expect(screen.getByText(/needs a module-manager role/i)).toBeDefined();
  });

  it('warns BEFORE the press that an offline command will not be queued', () => {
    commandState = { isSending: false, outcome: null, canCommand: true, isOnline: false };
    mockUseVfdDrive.mockReturnValue(ready(drive()));
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    expect(screen.getByText(/Drive commands are never queued/i)).toBeDefined();
    // The buttons stay LIVE on purpose: a disabled control is a silence, and this
    // is the refusal a field worker most needs spoken.
    expect(screen.getByRole('button', { name: /Start/ })).toBeDefined();
  });

  it('ANNOUNCES the offline refusal after the press', async () => {
    commandState = {
      isSending: false,
      outcome: {
        status: 'refused',
        message: 'Not sent: this device is offline. Drive commands are never queued.',
      },
      canCommand: true,
      isOnline: false,
    };
    mockUseVfdDrive.mockReturnValue(ready(drive()));
    mockUseFeederSetup.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('stop');
    });

    // role="alert" — announced by a screen reader, not merely drawn.
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((node) => node.textContent?.includes('never queued'))).toBe(true);
  });
});
