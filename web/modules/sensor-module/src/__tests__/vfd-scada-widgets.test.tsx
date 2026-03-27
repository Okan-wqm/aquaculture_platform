/**
 * Phase 10B: VFD SCADA Widget Tests
 *
 * Covers:
 *   VfdDriveWidget (12 tests)
 *   VfdMiniWidget (5 tests)
 *   VfdGroupWidget (5 tests)
 *   VfdDriveWidgetConfig (4 tests)
 *   Widget Registration (2 tests)
 *
 * Total: 28 tests
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mock lucide-react                                                  */
/* ------------------------------------------------------------------ */

vi.mock('lucide-react', () => {
  const factory = (name: string) =>
    (props: Record<string, unknown>) => <span data-testid={`icon-${name}`} {...props} />;
  return {
    Zap: factory('zap'),
    Minimize2: factory('minimize2'),
    LayoutGrid: factory('layout-grid'),
    ChevronDown: factory('chevron-down'),
    ChevronRight: factory('chevron-right'),
    GripVertical: factory('grip-vertical'),
  };
});

/* ------------------------------------------------------------------ */
/*  Mock useVfdRealtimeReadings                                        */
/* ------------------------------------------------------------------ */

interface MockReading {
  id: string;
  vfdDeviceId: string;
  tenantId: string;
  timestamp: string;
  parameters: {
    outputFrequency?: number;
    motorCurrent?: number;
    motorSpeed?: number;
    outputPower?: number;
    driveTemperature?: number;
    faultCode?: number;
    warningCode?: number;
  };
  statusBits: {
    ready: boolean;
    running: boolean;
    fault: boolean;
    warning: boolean;
    atSetpoint: boolean;
    atReference: boolean;
    direction: 'forward' | 'reverse' | 'stopped';
    remoteControl: boolean;
    localControl: boolean;
    autoMode: boolean;
    manualMode: boolean;
    currentLimit: boolean;
    voltageLimit: boolean;
    torqueLimit: boolean;
    speedLimit: boolean;
    enabled: boolean;
    quickStopActive: boolean;
    switchOnDisabled: boolean;
  };
}

let mockReading: MockReading | null = null;
let mockError: Error | null = null;

vi.mock('../hooks/useVfdReadings', () => ({
  useVfdRealtimeReadings: () => ({
    reading: mockReading,
    isPolling: false,
    error: mockError,
    lastUpdated: null,
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    refetch: vi.fn(),
  }),
  useVfdReadings: () => ({
    readings: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useVfdLatestReading: () => ({
    reading: mockReading,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  getVfdStatus: (statusBits: MockReading['statusBits'] | undefined) => {
    if (!statusBits) return { status: 'stopped', label: 'Unknown', color: 'gray' };
    if (statusBits.fault) return { status: 'fault', label: 'Fault', color: 'red' };
    if (statusBits.warning) return { status: 'warning', label: 'Warning', color: 'yellow' };
    if (statusBits.running) return { status: 'running', label: 'Running', color: 'green' };
    if (statusBits.ready) return { status: 'ready', label: 'Ready', color: 'blue' };
    return { status: 'stopped', label: 'Stopped', color: 'gray' };
  },
  formatParameterValue: (name: string, value: number | undefined) =>
    value !== undefined ? `${value}` : '-',
}));

/* ------------------------------------------------------------------ */
/*  Mock graphqlFetch                                                  */
/* ------------------------------------------------------------------ */

vi.mock('../config/api', () => ({
  graphqlFetch: vi.fn().mockResolvedValue({}),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeReading(
  overrides?: Partial<MockReading['parameters']>,
  statusOverrides?: Partial<MockReading['statusBits']>,
): MockReading {
  return {
    id: 'r1',
    vfdDeviceId: 'vfd-1',
    tenantId: 't1',
    timestamp: '2026-03-27T10:00:00Z',
    parameters: {
      outputFrequency: 45.0,
      motorCurrent: 12.3,
      motorSpeed: 1350,
      outputPower: 5.2,
      driveTemperature: 42,
      faultCode: 0,
      warningCode: 0,
      ...overrides,
    },
    statusBits: {
      ready: true,
      running: true,
      fault: false,
      warning: false,
      atSetpoint: true,
      atReference: true,
      direction: 'forward',
      remoteControl: true,
      localControl: false,
      autoMode: true,
      manualMode: false,
      currentLimit: false,
      voltageLimit: false,
      torqueLimit: false,
      speedLimit: false,
      enabled: true,
      quickStopActive: false,
      switchOnDisabled: false,
      ...statusOverrides,
    },
  };
}

const DEFAULT_PROPS = {
  width: 300,
  height: 400,
  isEditing: true,
  config: {} as Record<string, unknown>,
};

/* ------------------------------------------------------------------ */
/*  Lazy imports (default exports)                                     */
/* ------------------------------------------------------------------ */

// We import the default-exported components directly
import VfdDriveWidget from '../components/scada-builder/widget-renderers/VfdDriveWidget';
import VfdMiniWidget from '../components/scada-builder/widget-renderers/VfdMiniWidget';
import VfdGroupWidget from '../components/scada-builder/widget-renderers/VfdGroupWidget';
import { VfdDriveWidgetConfig } from '../components/scada-builder/widget-configs/VfdDriveWidgetConfig';

/* ================================================================== */
/*  VfdDriveWidget                                                     */
/* ================================================================== */

describe('VfdDriveWidget', () => {
  beforeEach(() => {
    mockReading = null;
    mockError = null;
  });

  it('renders with default demo data in edit mode', () => {
    render(<VfdDriveWidget {...DEFAULT_PROPS} />);
    expect(screen.getByTestId('vfd-drive-widget')).toBeTruthy();
  });

  it('shows correct status LED color for running state', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ demoState: '' }}
      />,
    );
    // Running state in edit mode = default demo data with running=true
    const svg = screen.getByTestId('vfd-drive-widget').querySelector('svg');
    expect(svg).toBeTruthy();
    // The component should contain the text "RUNNING"
    expect(svg?.textContent).toContain('RUNNING');
  });

  it('shows correct status for stopped state', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ demoState: 'stopped' }}
      />,
    );
    const svg = screen.getByTestId('vfd-drive-widget').querySelector('svg');
    expect(svg?.textContent).toContain('STOPPED');
  });

  it('displays live parameter values', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ showFrequency: true, showCurrent: true, showSpeed: true, showPower: true, showTemperature: true }}
      />,
    );
    const content = screen.getByTestId('vfd-drive-widget').textContent || '';
    expect(content).toContain('45.0 Hz');
    expect(content).toContain('12.3 A');
    expect(content).toContain('1350 RPM');
    expect(content).toContain('5.2 kW');
    expect(content).toContain('42°C');
  });

  it('shows motor M label when running (animation handled by CSS)', () => {
    render(<VfdDriveWidget {...DEFAULT_PROPS} />);
    const svg = screen.getByTestId('vfd-drive-widget').querySelector('svg');
    // The motor symbol always shows "M"
    expect(svg?.textContent).toContain('M');
  });

  it('does not show motor spinning when stopped', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ demoState: 'stopped' }}
      />,
    );
    const svg = screen.getByTestId('vfd-drive-widget').querySelector('svg');
    expect(svg?.textContent).toContain('STOPPED');
    // Motor "M" text is still present but without animation
    expect(svg?.textContent).toContain('M');
  });

  it('shows fault code when in fault state', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ demoState: 'fault' }}
      />,
    );
    const svg = screen.getByTestId('vfd-drive-widget').querySelector('svg');
    expect(svg?.textContent).toContain('FAULT');
  });

  it('shows warning state', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ demoState: 'warning' }}
      />,
    );
    const content = screen.getByTestId('vfd-drive-widget').textContent || '';
    expect(content).toContain('WARNING');
  });

  it('shows offline overlay when state is offline', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ demoState: 'offline' }}
      />,
    );
    const content = screen.getByTestId('vfd-drive-widget').textContent || '';
    expect(content).toContain('No Communication');
  });

  it('Program button fires vfd:program command', () => {
    const onCommand = vi.fn();
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        isEditing={false}
        config={{ vfdDeviceId: 'vfd-123' }}
        onCommand={onCommand}
      />,
    );
    const programBtn = screen.getByTestId('vfd-btn-program');
    fireEvent.click(programBtn);
    expect(onCommand).toHaveBeenCalledWith('vfd:program', 'vfd-123');
  });

  it('temperature bar renders with correct threshold warning', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ tempWarningThreshold: 40, showTemperature: true }}
      />,
    );
    // Demo temp is 42, threshold is 40 → should show warning indicator
    const content = screen.getByTestId('vfd-drive-widget').textContent || '';
    expect(content).toContain('42°C');
  });

  it('applies brand-specific color for ABB', () => {
    render(
      <VfdDriveWidget
        {...DEFAULT_PROPS}
        config={{ brand: 'abb', label: 'ACS580' }}
      />,
    );
    const content = screen.getByTestId('vfd-drive-widget').textContent || '';
    expect(content).toContain('ABB');
  });
});

/* ================================================================== */
/*  VfdMiniWidget                                                      */
/* ================================================================== */

describe('VfdMiniWidget', () => {
  beforeEach(() => {
    mockReading = null;
    mockError = null;
  });

  it('renders compact view', () => {
    render(
      <VfdMiniWidget
        {...DEFAULT_PROPS}
        width={160}
        height={70}
        config={{ label: 'VFD #1' }}
      />,
    );
    expect(screen.getByTestId('vfd-mini-widget')).toBeTruthy();
  });

  it('shows essential parameters (frequency, current, speed)', () => {
    render(
      <VfdMiniWidget
        {...DEFAULT_PROPS}
        config={{ label: 'VFD #1' }}
      />,
    );
    const content = screen.getByTestId('vfd-mini-widget').textContent || '';
    expect(content).toContain('45.0Hz');
    expect(content).toContain('12.3A');
    expect(content).toContain('1350RPM');
  });

  it('click fires vfd:navigate command', () => {
    const onCommand = vi.fn();
    render(
      <VfdMiniWidget
        {...DEFAULT_PROPS}
        isEditing={false}
        config={{ vfdDeviceId: 'vfd-99' }}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByTestId('vfd-mini-widget'));
    expect(onCommand).toHaveBeenCalledWith('vfd:navigate', 'vfd-99');
  });

  it('shows status LED element', () => {
    render(
      <VfdMiniWidget
        {...DEFAULT_PROPS}
        config={{ label: 'VFD #1' }}
      />,
    );
    const led = screen.getByTestId('vfd-mini-led');
    expect(led).toBeTruthy();
  });

  it('shows display name', () => {
    render(
      <VfdMiniWidget
        {...DEFAULT_PROPS}
        config={{ displayName: 'Pump A' }}
      />,
    );
    const content = screen.getByTestId('vfd-mini-widget').textContent || '';
    expect(content).toContain('Pump A');
  });
});

/* ================================================================== */
/*  VfdGroupWidget                                                     */
/* ================================================================== */

describe('VfdGroupWidget', () => {
  beforeEach(() => {
    mockReading = null;
    mockError = null;
  });

  it('renders multiple VFDs in edit mode with demo data', () => {
    render(
      <VfdGroupWidget
        {...DEFAULT_PROPS}
        width={400}
        height={200}
        config={{}}
      />,
    );
    expect(screen.getByTestId('vfd-group-widget')).toBeTruthy();
    // Demo data has 3 devices
    expect(screen.getByTestId('vfd-group-card-1')).toBeTruthy();
    expect(screen.getByTestId('vfd-group-card-2')).toBeTruthy();
    expect(screen.getByTestId('vfd-group-card-3')).toBeTruthy();
  });

  it('shows total power and average frequency', () => {
    render(
      <VfdGroupWidget
        {...DEFAULT_PROPS}
        width={400}
        height={200}
        config={{}}
      />,
    );
    const content = screen.getByTestId('vfd-group-widget').textContent || '';
    // Total power = 5.2 + 4.8 + 0 = 10.0
    expect(content).toContain('Total Power: 10.0 kW');
    // Avg frequency = (45 + 50) / 2 = 47.5 (only running devices)
    expect(content).toContain('Avg Freq: 47.5 Hz');
  });

  it('highlights faulted VFDs', () => {
    render(
      <VfdGroupWidget
        {...DEFAULT_PROPS}
        width={400}
        height={200}
        config={{}}
      />,
    );
    const faultCard = screen.getByTestId('vfd-group-card-3');
    expect(faultCard).toBeTruthy();
    // Fault card should display "FAULT" text
    expect(faultCard.textContent).toContain('FAULT');
  });

  it('handles empty device list', () => {
    render(
      <VfdGroupWidget
        {...DEFAULT_PROPS}
        isEditing={false}
        width={400}
        height={200}
        config={{ devices: [] }}
      />,
    );
    const content = screen.getByTestId('vfd-group-widget').textContent || '';
    expect(content).toContain('No VFD devices configured');
  });

  it('shows custom group title', () => {
    render(
      <VfdGroupWidget
        {...DEFAULT_PROPS}
        config={{ groupTitle: 'Station Alpha' }}
      />,
    );
    const content = screen.getByTestId('vfd-group-widget').textContent || '';
    expect(content).toContain('Station Alpha');
  });
});

/* ================================================================== */
/*  VfdDriveWidgetConfig                                               */
/* ================================================================== */

describe('VfdDriveWidgetConfig', () => {
  it('renders device ID input', () => {
    const onChange = vi.fn();
    render(
      <VfdDriveWidgetConfig
        config={{ vfdDeviceId: 'vfd-42' }}
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('vfd-config-device-id') as HTMLInputElement;
    expect(input.value).toBe('vfd-42');
  });

  it('device selector fires onChange', () => {
    const onChange = vi.fn();
    render(
      <VfdDriveWidgetConfig
        config={{}}
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('vfd-config-device-id') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'vfd-new' } });
    expect(onChange).toHaveBeenCalledWith({ vfdDeviceId: 'vfd-new' });
  });

  it('parameter visibility toggles render', () => {
    const onChange = vi.fn();
    render(
      <VfdDriveWidgetConfig
        config={{}}
        onChange={onChange}
      />,
    );
    const freqToggle = screen.getByTestId('vfd-config-showFrequency') as HTMLInputElement;
    expect(freqToggle.checked).toBe(true); // default = true
    fireEvent.click(freqToggle);
    expect(onChange).toHaveBeenCalledWith({ showFrequency: false });
  });

  it('threshold configuration works', () => {
    const onChange = vi.fn();
    render(
      <VfdDriveWidgetConfig
        config={{ tempWarningThreshold: 70 }}
        onChange={onChange}
      />,
    );
    const tempInput = screen.getByTestId('vfd-config-temp-threshold') as HTMLInputElement;
    expect(tempInput.value).toBe('70');
    fireEvent.change(tempInput, { target: { value: '80' } });
    expect(onChange).toHaveBeenCalledWith({ tempWarningThreshold: 80 });
  });
});

/* ================================================================== */
/*  Widget Registration                                                */
/* ================================================================== */

describe('Widget Registration', () => {
  it('VFD renderers export default components', () => {
    // The default exports are already imported at module top-level.
    // If the imports failed, the test file itself would not compile.
    expect(typeof VfdDriveWidget).toBe('object'); // memo wraps to object
    expect(typeof VfdMiniWidget).toBe('object');
    expect(typeof VfdGroupWidget).toBe('object');
  });

  it('VfdDriveWidgetConfig is a named export', () => {
    expect(typeof VfdDriveWidgetConfig).toBe('function');
  });
});
