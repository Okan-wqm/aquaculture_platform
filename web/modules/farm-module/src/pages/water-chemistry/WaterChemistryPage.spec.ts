import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engineMockState = vi.hoisted(() => ({ failPHGeneration: false }));

vi.mock('@platform/aquaculture-engines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platform/aquaculture-engines')>();
  return {
    ...actual,
    generateDeffeyesPHChartData: (...args: Parameters<typeof actual.generateDeffeyesPHChartData>) => {
      if (engineMockState.failPHGeneration) {
        throw new Error('forced DIC/pH generation failure');
      }
      return actual.generateDeffeyesPHChartData(...args);
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

import { getVisibleH2SChartZones, shouldUseLegacyDeffeyesChart } from './WaterChemistryPage';
import WaterChemistryPage from './WaterChemistryPage';

function renderWaterChemistryPage(route = '/water-chemistry') {
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
  engineMockState.failPHGeneration = false;
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

  it('allows query override back to pH mode unless pH generation failed', () => {
    expect(shouldUseLegacyDeffeyesChart('legacy', 'ph')).toBe(false);
    expect(shouldUseLegacyDeffeyesChart('ph', 'ph', true)).toBe(true);
  });
});

describe('getVisibleH2SChartZones', () => {
  it('renders full safe domain when the H2S critical pH is absent or below the visible chart', () => {
    expect(getVisibleH2SChartZones(NaN)).toEqual({
      safe: { x1: 4, x2: 9 },
      showCriticalLine: false,
    });
    expect(getVisibleH2SChartZones(3.5)).toEqual({
      safe: { x1: 4, x2: 9 },
      showCriticalLine: false,
    });
  });

  it('renders full danger domain when the H2S critical pH is above the visible chart', () => {
    expect(getVisibleH2SChartZones(12.5)).toEqual({
      danger: { x1: 4, x2: 9 },
      showCriticalLine: false,
    });
  });

  it('splits danger, alert, and safe bands inside the visible chart', () => {
    expect(getVisibleH2SChartZones(6)).toEqual({
      danger: { x1: 4, x2: 6 },
      alert: { x1: 6, x2: 6.2 },
      safe: { x1: 6.2, x2: 9 },
      showCriticalLine: true,
    });
  });
});

describe('WaterChemistryPage Deffeyes DIC/pH integration', () => {
  it('exports report SVGs with safety overlays even when the H2S chart toggle is off', async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    const print = vi.fn();
    const close = vi.fn();
    const write = vi.fn((html: string) => {
      written.push(html);
    });
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write, close },
      print,
    } as unknown as Window);

    renderWaterChemistryPage();
    expect(await screen.findByTestId('deffeyes-ph-chart')).toBeInTheDocument();

    await user.click(screen.getByLabelText('H₂S Toxic'));
    expect(screen.queryByTestId('deffeyes-layer-h2s-toxic')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /print report/i }));

    const html = written.join('');
    expect(html).toContain('deffeyes-layer-nh3-toxic-polygon');
    expect(html).toContain('deffeyes-layer-co2-toxic-polygon');
    expect(html).toContain('deffeyes-layer-h2s-toxic-polygon');
    expect(html).toContain('Toxic H₂S pH Border');
    expect(html).toContain('H₂S Status');
  });

  it('supports legacy rollback, pH override, and generation-failure fallback', async () => {
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'ph');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=legacy');
    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();

    cleanup();
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'legacy');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=ph');
    expect(await screen.findByTestId('deffeyes-ph-chart')).toBeInTheDocument();

    cleanup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    engineMockState.failPHGeneration = true;
    vi.stubEnv('VITE_DEFFEYES_CHART_MODE', 'ph');
    renderWaterChemistryPage('/water-chemistry?deffeyesMode=ph');
    expect(await screen.findByRole('alert')).toHaveTextContent('DIC/pH chart generation failed');
    expect(screen.queryByTestId('deffeyes-ph-chart')).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[WaterChemistry] Deffeyes pH data generation error:',
      expect.any(Error)
    );
  });
});
