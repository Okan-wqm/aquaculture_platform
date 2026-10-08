/**
 * WaterChemistryMonitoringPage: a tab per farm system, the loop's points
 * overlaid from the farm API's resolved inputs, the selected point's live
 * tiles — and nothing read from the retired browser-local mock.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';

vi.mock('@aquaculture/shared-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aquaculture/shared-ui')>()),
  useAuth: () => ({ tenantId: TENANT, token: 'jwt', hasAnyRole: () => true }),
}));

const hooks = vi.hoisted(() => ({
  systems: vi.fn(),
  tanks: vi.fn(),
  tankSystem: vi.fn(),
  inputSets: vi.fn(),
  sources: vi.fn(),
}));
vi.mock('../useWaterChemistryMonitoring', () => ({
  WC_REFRESH_MS: 30_000,
  useWcSystemList: () => hooks.systems(),
  useSystemTanks: (id: string | null) => hooks.tanks(id),
  useTankSystem: (id: string | null) => hooks.tankSystem(id),
  usePointInputSets: (requests: unknown) => hooks.inputSets(requests),
  usePointSources: (point: unknown) => hooks.sources(point),
}));
vi.mock('../../../hooks/useChannelReadings', () => ({
  useChannelSeries: () => ({ series: null, loading: false, fetching: false, error: null }),
}));
vi.mock('../../../components/charts/MultiParameterTrendCard', () => ({
  MultiParameterTrendCard: () => <div data-testid="trend-card" />,
}));
vi.mock('@platform/shared-ui/water-chemistry/components', () => ({
  DeffeyesChart: (props: { overlays?: Array<{ label: string }> }) => (
    <div data-testid="deffeyes-chart">{(props.overlays ?? []).map((o) => o.label).join('|')}</div>
  ),
  ResultsPanel: () => <div data-testid="results-panel" />,
  UiaVsPhChart: () => <div data-testid="nh3-chart" />,
  H2sVsPhChart: () => <div />,
  CarbonateVsPhChart: () => <div />,
}));

import WaterChemistryMonitoringPage from '../WaterChemistryMonitoringPage';

import { dosingSet, phSource, SYSTEM_ID, TANK_ID, toxicitySet } from './wcFixtures';

function renderPage(route = '/sensor/water-chemistry'): void {
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/sensor/water-chemistry" element={<WaterChemistryMonitoringPage />} />
        <Route
          path="/sensor/water-chemistry/:scopeKind/:scopeId"
          element={<WaterChemistryMonitoringPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WaterChemistryMonitoringPage', () => {
  beforeEach(() => {
    localStorage.clear();
    hooks.systems.mockReturnValue({
      data: [{ id: SYSTEM_ID, name: 'RAS A', code: 'RAS-A', type: 'RAS', siteId: 'site-1' }],
      error: null,
      isSuccess: true,
    });
    hooks.tanks.mockReturnValue({ data: [{ id: TANK_ID, name: 'Tank 3', code: 'T3' }] });
    hooks.tankSystem.mockReturnValue({ data: SYSTEM_ID });
    hooks.inputSets.mockReturnValue([{ data: dosingSet() }, { data: toxicitySet() }]);
    hooks.sources.mockReturnValue({ data: [phSource()], error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never reads the retired mock keys, and removes them', () => {
    localStorage.setItem('wc-cards-v1', '[{"id":"mock"}]');
    localStorage.setItem('wc-systems-v1', '[{"id":"mock"}]');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');

    renderPage();

    const readKeys = getItem.mock.calls.map(([key]) => key);
    expect(readKeys).not.toContain('wc-cards-v1');
    expect(readKeys).not.toContain('wc-systems-v1');
    expect(localStorage.getItem('wc-cards-v1')).toBeNull();
    expect(localStorage.getItem('wc-systems-v1')).toBeNull();
  });

  it('opens a tab per system and overlays the points whose values are all measured', () => {
    renderPage();

    expect(screen.getByRole('tab', { name: 'RAS A' })).toHaveAttribute('aria-selected', 'true');
    expect(hooks.inputSets).toHaveBeenCalledWith([
      { point: { kind: 'system', id: SYSTEM_ID }, set: 'DOSING' },
      { point: { kind: 'tank', id: TANK_ID }, set: 'TOXICITY' },
    ]);
    // The tank reads TOXICITY at the tank and the loop's carbonate state; the
    // system point has no TAN or H₂S of its own, so it is listed, not drawn.
    expect(screen.getAllByTestId('deffeyes-chart')[0]).toHaveTextContent('Tank 3');
    const legend = screen.getByRole('list', { name: 'Measurement points' });
    expect(within(legend).getByText(/RAS A \(system\)/).parentElement).toHaveTextContent(
      'Not drawn: no value for TAN (mg/L as N), H₂S (µg/L)',
    );
  });

  it("shows the selected point's live sources as tiles", () => {
    renderPage(`/sensor/water-chemistry/tank/${TANK_ID}`);

    expect(hooks.tankSystem).toHaveBeenCalledWith(TANK_ID);
    expect(hooks.sources).toHaveBeenCalledWith({ kind: 'tank', id: TANK_ID });
    expect(screen.getByText('7.12')).toBeInTheDocument();
  });

  it('keeps the chart-type choice per tenant, and only that', () => {
    renderPage(`/sensor/water-chemistry/tank/${TANK_ID}`);
    fireEvent.change(screen.getByLabelText('Chart'), { target: { value: 'nh3' } });
    expect(screen.getByTestId('nh3-chart')).toBeInTheDocument();

    const keys = Object.keys(localStorage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(TENANT);
    expect(keys[0]).toContain('wc-monitoring-chart-type');
  });
});
