import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', () => ({
  useCanMutate: () => false,
}));

vi.mock('./components/RecordTab', () => ({ RecordTab: () => null }));
vi.mock('./components/BulkRecordTab', () => ({ BulkRecordTab: () => null }));
vi.mock('./components/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('./components/ParameterConfigManager', () => ({ ParameterConfigManager: () => null }));

import { WATER_CHEMISTRY_DIAGNOSTIC_EVENT } from './waterChemistryDiagnostics';
import type { WaterChemistryDiagnosticDetail } from './waterChemistryDiagnostics';
import { getVisibleH2SChartZones, getVisibleNH3ChartZones } from './WaterChemistryPage';
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanup();
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

describe('getVisibleNH3ChartZones (NH₃ toxic ABOVE crit, clamped to 6.0–9.5)', () => {
  it('renders full safe domain when the NH₃ critical pH is absent or above the visible chart', () => {
    // Regression guard: off-domain critical pH must NOT leave the chart unshaded.
    expect(getVisibleNH3ChartZones(NaN)).toEqual({
      safe: { x1: 6, x2: 9.5 },
      showCriticalLine: false,
    });
    expect(getVisibleNH3ChartZones(10)).toEqual({
      safe: { x1: 6, x2: 9.5 },
      showCriticalLine: false,
    });
  });

  it('renders full danger domain when the NH₃ critical pH is below the visible chart', () => {
    expect(getVisibleNH3ChartZones(5)).toEqual({
      danger: { x1: 6, x2: 9.5 },
      showCriticalLine: false,
    });
  });

  it('splits safe, alert, and danger bands inside the visible chart', () => {
    expect(getVisibleNH3ChartZones(8)).toEqual({
      safe: { x1: 6, x2: 7.8 },
      alert: { x1: 7.8, x2: 8 },
      danger: { x1: 8, x2: 9.5 },
      showCriticalLine: true,
    });
  });
});

describe('WaterChemistryPage Deffeyes (legacy ALK/DIC, single chart)', () => {
  it('renders the ALK/DIC Deffeyes chart and never a DIC/pH chart', async () => {
    renderWaterChemistryPage();

    // The legacy ALK/DIC Deffeyes diagram is the only chart.
    expect(await screen.findByText('Water Quality Management Chart')).toBeInTheDocument();
    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
  });

  it('exposes the H₂S toxic-zone layer toggle on the chart', async () => {
    renderWaterChemistryPage();

    expect(await screen.findByText('Water Quality Management Chart')).toBeInTheDocument();
    // NH₃, CO₂ and the newly-added H₂S toxic zone are all toggleable.
    expect(screen.getByLabelText('NH₃ Toxic')).toBeInTheDocument();
    expect(screen.getByLabelText('CO₂ Toxic')).toBeInTheDocument();
    expect(screen.getByLabelText('H₂S Toxic')).toBeInTheDocument();
  });

  it('prints a report with H₂S safety rows and no stale DIC/pH projection diagnostics', () => {
    renderWaterChemistryPage();

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
    expect(html).toContain('Toxic H₂S pH Border');
    expect(html).toContain('H₂S Status');
    expect(html).toContain('H₂S Measured');
    expect(html).toContain('Current H₂S');
    // The DIC/pH projection machinery is gone — its report rows must not appear.
    expect(html).not.toContain('DIC/pH Projection Diagnostics');
    expect(html).not.toContain('deffeyes-ph-chart');

    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(1000);
  }, 30000);

  it('uses the single realtime pH for H₂S — no separate H₂S measurement pH input or readout', async () => {
    renderWaterChemistryPage();
    expect(await screen.findByText('Water Quality Management Chart')).toBeInTheDocument();

    // H₂S, CO₂ and NH₃ all share the one realtime pH; the separate H₂S
    // measurement-pH knob and its readout row are gone.
    expect(screen.queryByLabelText('H₂S pH')).not.toBeInTheDocument();
    expect(screen.queryByText('H₂S measured at pH')).not.toBeInTheDocument();
  }, 15000);

  it('prints through the iframe without reporting a fallback diagnostic', async () => {
    const diagnosticEvents: CustomEvent<WaterChemistryDiagnosticDetail>[] = [];
    window.addEventListener(WATER_CHEMISTRY_DIAGNOSTIC_EVENT, (event) => {
      diagnosticEvents.push(event as CustomEvent<WaterChemistryDiagnosticDetail>);
    });

    renderWaterChemistryPage();
    expect(await screen.findByText('Water Quality Management Chart')).toBeInTheDocument();

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
