/**
 * SENSOR-HIGH-065 / 066 / 067 — a registered drive must be operable, and the
 * screen must not overstate what it knows.
 *
 * Three findings, one surface, because they compound: a drive could not be
 * activated (065), the only panel with drive controls could never mount (066),
 * and the freshness indicator reported the browser's poll loop rather than the
 * data's age (067). Together they made a complete-looking VFD module that could
 * not start a motor and said its stale numbers were live.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('lucide-react', () => {
  const icon =
    (name: string) =>
    (props: Record<string, unknown>): React.ReactElement => (
      <span data-testid={`icon-${name}`} {...props} />
    );
  const names = [
    'ArrowLeft',
    'Zap',
    'Wifi',
    'WifiOff',
    'Loader2',
    'AlertTriangle',
    'MapPin',
    'Clock',
    'Activity',
    'Settings',
    'Power',
    'PowerOff',
    'Play',
    'Square',
    'AlertOctagon',
    'RefreshCw',
    'AlertCircle',
  ];
  return Object.fromEntries(names.map((n) => [n, icon(n)]));
});

const activateDevice = vi.fn();
const deactivateDevice = vi.fn();
const refetch = vi.fn();

let deviceState: Record<string, unknown> = {};
let readingState: { reading: unknown; error: Error | null } = { reading: null, error: null };

vi.mock('../hooks/useVfdRegistration', () => ({
  useVfdDevice: () => ({ data: deviceState, isLoading: false, error: null, refetch }),
  useVfdRegistration: () => ({ activateDevice, deactivateDevice }),
}));

vi.mock('../hooks/useVfdReadings', () => ({
  useVfdRealtimeReadings: () => readingState,
  getVfdStatus: () => ({ status: 'stopped', label: 'Durdu' }),
}));

vi.mock('../hooks/useVfdCommands', () => ({
  useVfdCommands: () => ({
    loading: false,
    lastResult: null,
    start: vi.fn(),
    stop: vi.fn(),
    emergencyStop: vi.fn(),
    resetFault: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ deviceId: 'drive-1' }) };
});

import { VfdDeviceDetailPage } from '../pages/VfdDeviceDetailPage';

function baseDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'drive-1',
    name: 'Aerator drive',
    brand: 'danfoss',
    protocol: 'modbus_tcp',
    status: 'testing',
    pollIntervalMs: 5000,
    isPollingEnabled: true,
    connectionStatus: { isConnected: true },
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <VfdDeviceDetailPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deviceState = baseDevice();
  readingState = { reading: null, error: null };
});

describe('VFD drive operability (SENSOR-HIGH-065/066/067)', () => {
  it('offers activation on a connection-tested drive — the caller that never existed', async () => {
    // activateVfdDevice was on the schema and in the hook with zero callers in
    // web/, so a wizard-registered drive stopped at TESTING forever and every
    // command requires ACTIVE.
    activateDevice.mockResolvedValue(baseDevice({ status: 'active' }));
    renderPage();

    const button = screen.getByTestId('vfd-activate');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(button);

    expect(activateDevice).toHaveBeenCalledWith('drive-1');
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it('refuses to offer activation before a connection test, the way the server does', () => {
    // vfd-device.service.activate throws "Device must pass connection test before
    // activation". Disabling the button states the rule instead of letting the
    // operator find it in a failed request.
    deviceState = baseDevice({ connectionStatus: { isConnected: false } });
    renderPage();

    expect((screen.getByTestId('vfd-activate') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('vfd-activate-blocked-reason')).toBeTruthy();
  });

  it('offers deactivation instead once the drive is active', () => {
    deviceState = baseDevice({ status: 'active' });
    renderPage();

    expect(screen.getByTestId('vfd-deactivate')).toBeTruthy();
    expect(screen.queryByTestId('vfd-activate')).toBeNull();
  });

  it('surfaces a refused activation rather than silently doing nothing', async () => {
    activateDevice.mockResolvedValue(null);
    renderPage();

    await userEvent.click(screen.getByTestId('vfd-activate'));

    await waitFor(() => expect(screen.getByTestId('vfd-lifecycle-error')).toBeTruthy());
    expect(refetch).not.toHaveBeenCalled();
  });

  it('renders the drive control panel on the drive page (SENSOR-HIGH-066)', () => {
    // It used to be mounted only behind `sensor.type.includes('vfd')`, which no
    // SensorType value can satisfy, so it never rendered anywhere.
    renderPage();

    expect(screen.getByText('VFD Durumu')).toBeTruthy();
  });

  it('disables every command while the drive is not ACTIVE', () => {
    renderPage();

    expect(screen.getByTestId('vfd-commands-disabled-notice')).toBeTruthy();
    for (const label of ['Başlat', 'Durdur', 'Acil Dur']) {
      expect((screen.getByText(label).closest('button') as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('enables commands once the drive is ACTIVE', () => {
    deviceState = baseDevice({ status: 'active' });
    renderPage();

    expect(screen.queryByTestId('vfd-commands-disabled-notice')).toBeNull();
    expect((screen.getByText('Acil Dur').closest('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reports the age of the reading, not that the client is polling (SENSOR-HIGH-067)', () => {
    readingState = {
      reading: {
        timestamp: new Date(Date.now() - 5000).toISOString(),
        parameters: { outputFrequency: 42.5 },
        statusBits: {},
      },
      error: null,
    };
    deviceState = baseDevice({ status: 'active' });
    renderPage();

    expect(screen.getByTestId('vfd-reading-age').textContent).toMatch(/Okuma: \d+ sn önce/);
  });

  it('says so when there is no reading at all instead of showing a live indicator', () => {
    renderPage();

    expect(screen.getByTestId('vfd-reading-age').textContent).toBe('Okuma yok');
  });
});
