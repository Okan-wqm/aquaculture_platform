import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// PARTIAL mock: the page now imports the real water-chemistry SSoT
// (computeWaterChemistryOutputs / buildDeffeyesData / getVisible*ChartZones /
// WaterChemistryInputs) from shared-ui — a full-replace mock would make those
// undefined and crash the render. Keep every real export, override only the guard.
vi.mock('@aquaculture/shared-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aquaculture/shared-ui')>()),
  useCanMutate: () => false,
}));

vi.mock('./components/RecordTab', () => ({ RecordTab: () => null }));
vi.mock('./components/BulkRecordTab', () => ({ BulkRecordTab: () => null }));
vi.mock('./components/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('./components/ParameterConfigManager', () => ({ ParameterConfigManager: () => null }));

import { WATER_CHEMISTRY_DIAGNOSTIC_EVENT } from './waterChemistryDiagnostics';
import type { WaterChemistryDiagnosticDetail } from './waterChemistryDiagnostics';
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
