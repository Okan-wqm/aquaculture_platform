import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engineMockState = vi.hoisted(() => ({
  failPHGeneration: false,
  generatePHCalls: 0,
  projectLineCalls: 0,
  projectPointCalls: 0,
  sampleSegmentCalls: 0,
}));

vi.mock('@platform/aquaculture-engines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/aquaculture-engines')>();
  return {
    ...actual,
    generateDeffeyesPHChartData: (...args: Parameters<typeof actual.generateDeffeyesPHChartData>) => {
      engineMockState.generatePHCalls += 1;
      if (engineMockState.failPHGeneration) {
        throw new Error('forced DIC/pH generation failure');
      }
      return actual.generateDeffeyesPHChartData(...args);
    },
    projectAlkDicLineSegmentsToDicPh: (...args: Parameters<typeof actual.projectAlkDicLineSegmentsToDicPh>) => {
      engineMockState.projectLineCalls += 1;
      return actual.projectAlkDicLineSegmentsToDicPh(...args);
    },
    projectAlkDicPointToDicPh: (...args: Parameters<typeof actual.projectAlkDicPointToDicPh>) => {
      engineMockState.projectPointCalls += 1;
      return actual.projectAlkDicPointToDicPh(...args);
    },
    sampleAlkDicSegmentSegmentsToDicPh: (...args: Parameters<typeof actual.sampleAlkDicSegmentSegmentsToDicPh>) => {
      engineMockState.sampleSegmentCalls += 1;
      return actual.sampleAlkDicSegmentSegmentsToDicPh(...args);
    },
  };
});

vi.mock('@aquaculture/shared-ui', () => ({
  useCanMutate: () => false,
}));

vi.mock('./components/RecordTab', () => ({ RecordTab: () => null }));
vi.mock('./components/BulkRecordTab', () => ({ BulkRecordTab: () => null }));
vi.mock('./components/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('./components/ParameterConfigManager', () => ({ ParameterConfigManager: () => null }));

import { WATER_CHEMISTRY_DIAGNOSTIC_EVENT } from './waterChemistryDiagnostics';
import type { WaterChemistryDiagnosticDetail } from './waterChemistryDiagnostics';
import { getVisibleH2SChartZones, shouldUseLegacyDeffeyesChart } from './WaterChemistryPage';
import WaterChemistryPage from './WaterChemistryPage';

function renderWaterChemistryPage(route = '/water-chemistry'): ReturnType<typeof render> {
  window.history.pushState({}, '', route);
  return render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [route], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
      React.createElement(WaterChemistryPage)
    )
  );
}

function resetEngineCounters(): void {
  engineMockState.generatePHCalls = 0;
  engineMockState.projectLineCalls = 0;
  engineMockState.projectPointCalls = 0;
  engineMockState.sampleSegmentCalls = 0;
}

function expectNoDicPhProjectionWork(): void {
  expect(engineMockState.generatePHCalls).toBe(0);
  expect(engineMockState.projectLineCalls).toBe(0);
  expect(engineMockState.projectPointCalls).toBe(0);
  expect(engineMockState.sampleSegmentCalls).toBe(0);
}

afterEach(() => {
  engineMockState.failPHGeneration = false;
  resetEngineCounters();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanup();
});

describe('shouldUseLegacyDeffeyesChart', () => {
  it('defaults to the DIC/pH chart', () => {
    expect(shouldUseLegacyDeffeyesChart(undefined, null)).toBe(false);
  });

  it('uses legacy mode from environment or query override', () => {
    expect(shouldUseLegacyDeffeyesChart('legacy', null)).toBe(true);
    expect(shouldUseLegacyDeffeyesChart('ph', 'legacy')).toBe(true);
  });

  it('denies pH query bypass while env rollback is active unless diagnostic override is built in', () => {
    expect(shouldUseLegacyDeffeyesChart('legacy', 'ph')).toBe(true);
    expect(shouldUseLegacyDeffeyesChart('legacy', 'ph', false, true)).toBe(false);
    expect(shouldUseLegacyDeffeyesChart('ph', 'ph', true, true)).toBe(true);
  });

  it('trims mode values, ignores invalid query modes, and fails closed on invalid env mode', () => {
    expect(shouldUseLegacyDeffeyesChart(' legacy ', ' ph ', false, true)).toBe(false);
    expect(shouldUseLegacyDeffeyesChart('ph', ' legacy ')).toBe(true);
    expect(shouldUseLegacyDeffeyesChart('legacy', 'typo')).toBe(true);
    expect(shouldUseLegacyDeffeyesChart('typo', 'ph', false, true)).toBe(true);
  });
});

describe('getVisibleH2SChartZones', () => {
  it('renders full safe domain when the H2S critical pH is absent or below the visible chart', () => {
    expect(getVisibleH2SChartZones(NaN)).toEqual({
      safe: { x1: 4, x2: 12.5 },
      showCriticalLine: false,
    });
    expect(getVisibleH2SChartZones(3.5)).toEqual({
      safe: { x1: 4, x2: 12.5 },
      showCriticalLine: false,
    });
  });

  it('renders full danger domain when the H2S critical pH is above the visible chart', () => {
    expect(getVisibleH2SChartZones(12.5)).toEqual({
      danger: { x1: 4, x2: 12.5 },
      showCriticalLine: true,
    });
  });

  it('splits danger, alert, and safe bands inside the visible chart', () => {
    expect(getVisibleH2SChartZones(6)).toEqual({
      danger: { x1: 4, x2: 6 },
      alert: { x1: 6, x2: 6.2 },
      safe: { x1: 6.2, x2: 12.5 },
      showCriticalLine: true,
    });
  });
});

describe('WaterChemistryPage Deffeyes DIC/pH integration', () => {
  it('exports report SVGs with safety overlays even when the H2S chart toggle is off', async () => {
    const user = userEvent.setup();

    renderWaterChemistryPage();
    expect(await screen.findByTestId('deffeyes-ph-chart')).toBeInTheDocument();

    await user.click(screen.getByLabelText('H₂S Toxic'));
    expect(screen.queryByTestId('deffeyes-layer-h2s-toxic')).not.toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /print report/i }));
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Water Chemistry Report"]');
    expect(frame).toBeInTheDocument();
    if (frame?.contentWindow) {
      Object.defineProperty(frame.contentWindow, 'focus', { value: vi.fn(), configurable: true });
      Object.defineProperty(frame.contentWindow, 'print', { value: vi.fn(), configurable: true });
    }

    const html = frame?.contentDocument?.documentElement.outerHTML ?? '';
    expect(html).not.toContain('<script');
    expect(html).toContain('deffeyes-layer-nh3-toxic-polygon');
    expect(html).toContain('deffeyes-layer-co2-toxic-polygon');
    expect(html).toContain('deffeyes-layer-h2s-toxic-polygon');
    expect(html).toContain('Toxic H₂S pH Border');
    expect(html).toContain('H₂S Status');
    expect(html).toContain('H₂S Measured');
    expect(html).toContain('Current H₂S');
    expect(html).toContain('DIC/pH Projection Diagnostics');
    expect(html).toContain('Projection Warning');
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(1000);
  }, 30000);

  it('supports legacy rollback, pH override, and generation-failure fallback', async () => {
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'ph');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=legacy');
    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
    expect(engineMockState.generatePHCalls).toBe(0);

    cleanup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=ph');
    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
    expect(engineMockState.generatePHCalls).toBe(0);

    cleanup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    vi.stubEnv('VITE_DEFFEYES_ALLOW_DIAGNOSTIC_MODE_OVERRIDE', 'true');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=ph');
    expect(await screen.findByTestId('deffeyes-ph-chart')).toBeInTheDocument();

    cleanup();
    const diagnostics: CustomEvent<WaterChemistryDiagnosticDetail>[] = [];
    window.addEventListener(WATER_CHEMISTRY_DIAGNOSTIC_EVENT, (event) => {
      diagnostics.push(event as CustomEvent<WaterChemistryDiagnosticDetail>);
    });
    engineMockState.failPHGeneration = true;
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'ph');
    vi.stubEnv('VITE_DEFFEYES_ALLOW_DIAGNOSTIC_MODE_OVERRIDE', 'false');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=ph');
    expect(await screen.findByRole('alert')).toHaveTextContent('DIC/pH chart generation failed');
    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
    expect(diagnostics.some(event => event.detail.code === 'deffeyes-ph-data-generation')).toBe(true);
  }, 30000);

  it('keeps DIC/pH projection helpers isolated in legacy mode for one reagent', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    renderWaterChemistryPage();

    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
    expectNoDicPhProjectionWork();

    await user.click(screen.getByRole('button', { name: 'Reagents' }));
    const reagentCheckboxes = screen.getAllByRole('checkbox');
    for (let i = 0; i < reagentCheckboxes.length; i++) {
      const shouldBeChecked = i === 0;
      const checkbox = reagentCheckboxes[i] as HTMLInputElement | undefined;
      if (checkbox && checkbox.checked !== shouldBeChecked) {
        await user.click(checkbox);
      }
    }

    expectNoDicPhProjectionWork();
  }, 30000);

  it('keeps DIC/pH projection helpers isolated in legacy mode for two reagents', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    renderWaterChemistryPage();

    await user.click(screen.getByRole('button', { name: 'Reagents' }));
    const reagentCheckboxes = screen.getAllByRole('checkbox');
    for (let i = 0; i < reagentCheckboxes.length; i++) {
      const shouldBeChecked = i < 2;
      const checkbox = reagentCheckboxes[i] as HTMLInputElement | undefined;
      if (checkbox && checkbox.checked !== shouldBeChecked) {
        await user.click(checkbox);
      }
    }

    expectNoDicPhProjectionWork();
  }, 30000);

  it('keeps DIC/pH projection helpers isolated in legacy mode for on-demand amounts', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    renderWaterChemistryPage();

    await user.click(screen.getByRole('button', { name: 'Simulator' }));
    const amountInput = screen.getAllByRole('spinbutton')[0];
    expect(amountInput).toBeInTheDocument();
    await user.clear(amountInput);
    await user.type(amountInput, '10');

    expectNoDicPhProjectionWork();
  }, 30000);

  it('prints legacy reports without DIC/pH projection diagnostics while rollback is active', () => {
    const diagnosticEvents: CustomEvent<WaterChemistryDiagnosticDetail>[] = [];
    window.addEventListener(WATER_CHEMISTRY_DIAGNOSTIC_EVENT, (event) => {
      diagnosticEvents.push(event as CustomEvent<WaterChemistryDiagnosticDetail>);
    });
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=ph');

    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
    expectNoDicPhProjectionWork();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /print report/i }));
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Water Chemistry Report"]');
    expect(frame).toBeInTheDocument();
    if (frame?.contentWindow) {
      Object.defineProperty(frame.contentWindow, 'focus', { value: vi.fn(), configurable: true });
      Object.defineProperty(frame.contentWindow, 'print', { value: vi.fn(), configurable: true });
    }
    const reportHtml = frame?.contentDocument?.documentElement.outerHTML ?? '';

    expect(reportHtml).toContain('Legacy ALK/DIC');
    expect(reportHtml).not.toContain('deffeyes-ph-chart');
    expect(reportHtml).not.toContain('DIC/pH Projection Diagnostics');
    expect(reportHtml).not.toMatch(/\b(?:projected|rejected|clipped)\b/i);
    expect(diagnosticEvents.some(event => event.detail.code === 'deffeyes-ph-data-generation')).toBe(false);

    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(1000);
  }, 30000);

  it('falls back to realtime pH when optional H2S measurement pH is cleared', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'ph');
    renderWaterChemistryPage();
    expect(await screen.findByTestId('deffeyes-ph-chart')).toBeInTheDocument();

    const h2sPHInput = screen.getByLabelText('H₂S pH');
    await user.clear(h2sPHInput);

    expect(screen.getByText('H₂S measured at pH')).toBeInTheDocument();
    expect(screen.getByText('7.00')).toBeInTheDocument();
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
  }, 30000);

  it('prints through iframe without reporting a fallback diagnostic', async () => {
    const diagnosticEvents: CustomEvent<WaterChemistryDiagnosticDetail>[] = [];
    window.addEventListener(WATER_CHEMISTRY_DIAGNOSTIC_EVENT, (event) => {
      diagnosticEvents.push(event as CustomEvent<WaterChemistryDiagnosticDetail>);
    });

    renderWaterChemistryPage();
    expect(await screen.findByTestId('deffeyes-ph-chart')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /print report/i }));
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Water Chemistry Report"]');
    expect(frame).toBeInTheDocument();
    if (frame?.contentWindow) {
      Object.defineProperty(frame.contentWindow, 'focus', { value: vi.fn(), configurable: true });
      Object.defineProperty(frame.contentWindow, 'print', { value: vi.fn(), configurable: true });
    }
    expect(diagnosticEvents.some(event => event.detail.code === 'report-print-fallback')).toBe(false);

    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('iframe[title="Water Chemistry Report"]')).not.toBeInTheDocument();
    vi.useRealTimers();
  }, 15000);
});
