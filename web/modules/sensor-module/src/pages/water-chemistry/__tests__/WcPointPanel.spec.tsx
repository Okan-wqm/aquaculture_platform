/**
 * WcPointPanel: draws only from measured values, shows every live source as a
 * tile with its channel's trend (the series narrowed to that channel), and
 * opens a problem where it is fixed.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const sourcesMock = vi.fn();
vi.mock('../useWaterChemistryMonitoring', () => ({
  usePointSources: (...args: unknown[]) => sourcesMock(...args),
}));
const seriesMock = vi.fn();
vi.mock('../../../hooks/useChannelReadings', () => ({
  useChannelSeries: (...args: unknown[]) => seriesMock(...args),
}));
vi.mock('../../../components/charts/MultiParameterTrendCard', () => ({
  MultiParameterTrendCard: (props: { title: string }) => (
    <div data-testid="trend-card">{props.title}</div>
  ),
}));
vi.mock('@platform/shared-ui/water-chemistry/components', () => ({
  DeffeyesChart: () => <div data-testid="deffeyes-chart" />,
  ResultsPanel: () => <div data-testid="results-panel" />,
  UiaVsPhChart: () => <div data-testid="nh3-chart" />,
  H2sVsPhChart: () => <div />,
  CarbonateVsPhChart: () => <div />,
}));

import { WcPointPanel } from '../WcPointPanel';

import { dosingSet, phSource, SENSOR_ID, TANK_ID, toxicitySet } from './wcFixtures';

function Location(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPanel(sets: Parameters<typeof WcPointPanel>[0]['sets']): void {
  render(
    <MemoryRouter initialEntries={['/sensor/water-chemistry']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <WcPointPanel
                point={{ kind: 'tank', id: TANK_ID }}
                label="Tank 3"
                sets={sets}
                chartType="deffeyes"
                onChartTypeChange={vi.fn()}
                now={Date.parse('2026-10-08T10:00:00.000Z')}
              />
              <Location />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WcPointPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seriesMock.mockReturnValue({
      series: {
        channels: [{ channelKey: 'ph', points: [{ avg: 7.0 }, { avg: 7.1 }, { avg: 7.12 }] }],
      },
      loading: false,
      fetching: false,
      error: null,
    });
  });

  it('draws the chart from the tank set and the loop set when every input is measured', () => {
    sourcesMock.mockReturnValue({ data: [phSource()], error: null });
    renderPanel([toxicitySet(), dosingSet()]);
    expect(screen.getByTestId('deffeyes-chart')).toBeInTheDocument();
    expect(screen.getByTestId('results-panel')).toBeInTheDocument();
    expect(screen.getByText('Toxicity: Ready')).toBeInTheDocument();
  });

  it('draws nothing from a missing value, and says which', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    renderPanel([toxicitySet(), dosingSet(null)]);
    expect(screen.queryByTestId('deffeyes-chart')).toBeNull();
    expect(screen.getByTestId('wc-not-drawn')).toHaveTextContent(
      'Not drawn: no value for Alkalinity (mg/L CaCO₃)',
    );
  });

  it("shows each source as a tile with its own channel's trend, and opens the full trend", () => {
    sourcesMock.mockReturnValue({ data: [phSource()], error: null });
    renderPanel([toxicitySet(), dosingSet()]);

    expect(screen.getByText('7.12')).toBeInTheDocument();
    expect(seriesMock).toHaveBeenCalledWith(
      SENSOR_ID,
      { kind: 'relative', preset: '24h' },
      60_000,
      ['ph'],
    );
    fireEvent.click(screen.getByTestId('parameter-source-tile'));
    expect(screen.getByTestId('trend-card')).toHaveTextContent('pH — ph');
  });

  it("opens a channel problem in the sensor's channel manager", () => {
    sourcesMock.mockReturnValue({ data: [phSource(['CHANNEL_HAS_NO_QUANTITY'])], error: null });
    renderPanel([toxicitySet(), dosingSet()]);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Fix: The channel does not say what it measures: declare its quantity',
      }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/sensor/devices/${SENSOR_ID}?tab=channels&channel=ph`,
    );
  });

  it('opens a source problem in the farm Sources tab at the point', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    renderPanel([toxicitySet(), dosingSet()]);
    fireEvent.click(screen.getByRole('button', { name: 'Open Sources' }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/sites/water-chemistry?tab=sources&point=tank:${TANK_ID}`,
    );
  });
});
