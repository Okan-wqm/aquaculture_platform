/**
 * WcPointPanel: draws only from usable values (the shared composition: a tank
 * reads its own set and its loop's alkalinity, calcium and volume), shows
 * where every field was read, tells an outage from a missing value, charts
 * each source's trend from one series request per sensor, and opens a
 * problem where it is fixed.
 */
import type { JSX } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const sourcesMock = vi.fn();
vi.mock('../useWaterChemistryMonitoring', () => ({
  usePointSources: (...args: unknown[]) => sourcesMock(...args),
}));
const seriesMock = vi.fn();
vi.mock('../../../hooks/useChannelReadings', () => ({
  useChannelSeriesBySensor: (...args: unknown[]) => seriesMock(...args),
}));
vi.mock('../../../components/charts/MultiParameterTrendCard', () => ({
  MultiParameterTrendCard: (props: { title: string }) => (
    <div data-testid="trend-card">{props.title}</div>
  ),
}));
vi.mock('@platform/shared-ui/water-chemistry/components', () => ({
  DeffeyesChart: () => <div data-testid="deffeyes-chart" />,
  ResultsPanel: (props: { dosingUnavailable?: string }) => (
    <div data-testid="results-panel">{props.dosingUnavailable}</div>
  ),
  UiaVsPhChart: () => <div data-testid="nh3-chart" />,
  H2sVsPhChart: () => <div />,
  CarbonateVsPhChart: () => <div />,
}));

import { pointStateOf, type PointState } from '../pointState';
import { WcPointPanel } from '../WcPointPanel';

import {
  answer,
  dosingSet,
  phSource,
  SENSOR_ID,
  SYSTEM_ID,
  TANK_ID,
  temperatureSource,
  toxicitySet,
} from './wcFixtures';

function Location(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPanel(state: PointState, kind: 'tank' | 'system' = 'tank'): void {
  render(
    <MemoryRouter initialEntries={['/sensor/water-chemistry']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <WcPointPanel
                point={{ kind, id: kind === 'tank' ? TANK_ID : SYSTEM_ID }}
                label="Tank 3"
                state={state}
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

const TANK_READY = pointStateOf(answer(toxicitySet()), answer(dosingSet()));

describe('WcPointPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seriesMock.mockReturnValue(
      new Map([
        [
          SENSOR_ID,
          {
            sensorId: SENSOR_ID,
            startTime: '2026-10-07T10:00:00.000Z',
            endTime: '2026-10-08T10:00:00.000Z',
            channels: [
              {
                channelKey: 'ph',
                unit: 'pH',
                unitSymbol: null,
                points: [
                  { bucket: '2026-10-08T08:00:00.000Z', avg: 7.0 },
                  { bucket: '2026-10-08T09:00:00.000Z', avg: 7.12 },
                ],
                gaps: [],
              },
            ],
          },
        ],
      ]),
    );
  });

  it("draws from the tank's set and the loop's carbonate state, shows where each field was read", () => {
    sourcesMock.mockReturnValue({ data: [phSource()], error: null });
    renderPanel(TANK_READY);
    expect(screen.getByTestId('deffeyes-chart')).toBeInTheDocument();
    expect(screen.getByText('Toxicity inputs: Ready')).toBeInTheDocument();
    const fields = screen.getByTestId('wc-point-fields');
    const alkalinity = within(fields).getByText('Alkalinity (mg/L CaCO₃)').parentElement;
    expect(alkalinity).toHaveTextContent('from the loop');
    // Monitoring doses nowhere, and says the limits are the calculator's.
    expect(screen.getByTestId('results-panel')).toHaveTextContent(
      'Dosing recipes are computed in the farm calculator, at the system',
    );
    expect(
      screen.getByText(/Targets and toxic limits are the calculator defaults/),
    ).toBeInTheDocument();
  });

  it('draws nothing from a missing value, and says which', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    renderPanel(pointStateOf(answer(toxicitySet()), answer(dosingSet(null))));
    expect(screen.queryByTestId('deffeyes-chart')).toBeNull();
    expect(screen.getByTestId('wc-not-drawn')).toHaveTextContent(
      'The calculation does not run: Alkalinity (mg/L CaCO₃)',
    );
  });

  it('explains a system point by where TAN and H₂S are read, not as missing values', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    renderPanel(pointStateOf(answer(dosingSet()), null), 'system');
    expect(screen.getByTestId('wc-not-drawn')).toHaveTextContent(
      'Not drawn: the toxic zones need TAN and H₂S, which are read at tanks',
    );
  });

  it('reads no loop for a tank the backend places in two live systems, and says why', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    const ambiguous = { ...toxicitySet(), loopSystemIds: [SYSTEM_ID, 'another-system'] };
    renderPanel(pointStateOf(answer(ambiguous), answer(dosingSet())));
    expect(screen.queryByTestId('deffeyes-chart')).toBeNull();
    const fields = screen.getByTestId('wc-point-fields');
    expect(within(fields).getByText('Alkalinity (mg/L CaCO₃)').parentElement).toHaveTextContent(
      'The tank is in two or more live systems',
    );
  });

  it('tells an outage from a missing value', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    renderPanel(pointStateOf(answer(undefined, new Error('HTTP 503')), answer(dosingSet())));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not read: the farm service did not answer (HTTP 503)',
    );
    expect(screen.queryByTestId('wc-not-drawn')).toBeNull();
  });

  it('charts every source of a sensor from one series request, in the parameter unit', () => {
    sourcesMock.mockReturnValue({ data: [phSource(), temperatureSource()], error: null });
    renderPanel(TANK_READY);

    expect(seriesMock).toHaveBeenLastCalledWith(
      [{ sensorId: SENSOR_ID, channelKeys: ['ph', 'temperature'] }],
      { kind: 'relative', preset: '24h' },
      60_000,
    );
    // The temperature channel reports °F; the tile shows the parameter's 13.0 °C.
    expect(screen.getByText('13.0')).toBeInTheDocument();
    expect(screen.getByText('last 24 h, in pH')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { description: 'Show the trend of pH' }));
    expect(screen.getByTestId('trend-card')).toHaveTextContent('pH — ph');
  });

  it("opens a channel problem in the sensor's channel manager, a source problem in farm Sources", () => {
    sourcesMock.mockReturnValue({ data: [phSource(['CHANNEL_HAS_NO_QUANTITY'])], error: null });
    renderPanel(TANK_READY);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Fix: The channel does not say what it measures: declare its quantity',
      }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/sensor/devices/${SENSOR_ID}?tab=channels&channel=ph`,
    );
  });

  it('opens the farm Sources tab at the point when nothing is read there', () => {
    sourcesMock.mockReturnValue({ data: [], error: null });
    renderPanel(TANK_READY);
    fireEvent.click(screen.getByRole('button', { name: 'Open Sources' }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/sites/water-chemistry?tab=sources&point=tank:${TANK_ID}`,
    );
  });
});
