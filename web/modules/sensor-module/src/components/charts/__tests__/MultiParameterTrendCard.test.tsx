/**
 * PR-6: the multi-parameter card derives one ChartLine per channel (colors,
 * axis grouping, threshold zones) and hands TrendChart custom-mode data.
 * uPlot renders into a stubbed canvas; assertions target the wiring, not pixels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { colors } from '@aquaculture/shared-ui';

const seriesMock = vi.fn();
vi.mock('../../../hooks/useAggregatedMultiSeries', () => ({
  useAggregatedMultiSeries: (...args: unknown[]) => seriesMock(...args),
}));

vi.mock('../TrendChart', () => ({
  TrendChart: (props: Record<string, unknown>) => (
    <div
      data-testid="trend-chart"
      data-lines={JSON.stringify(props['lines'])}
      data-mode={String(props['mode'])}
    />
  ),
}));

import { MultiParameterTrendCard, type TrendChannelSpec } from '../MultiParameterTrendCard';

const CHANNELS: TrendChannelSpec[] = [
  {
    channelKey: 'temperature',
    displayLabel: 'Su Sıcaklığı',
    unit: '°C',
    color: '#146f84',
    thresholds: { warning: { low: 10, high: 30 }, critical: { low: 5, high: 35 } },
  },
  { channelKey: 'ph', displayLabel: 'pH', unit: 'pH' },
  { channelKey: 'dissolved_oxygen', displayLabel: 'Çözünmüş Oksijen', unit: 'mg/L' },
];

function mockSeries(loading = false, error: string | null = null, hasData = true) {
  seriesMock.mockReturnValue({
    loading,
    error,
    series: hasData
      ? {
          temperature: [{ timestamp: 1_000, value: 22.5 }],
          ph: [{ timestamp: 1_000, value: 7.4 }],
          dissolved_oxygen: [],
        }
      : { temperature: [], ph: [], dissolved_oxygen: [] },
    refetch: () => undefined,
  });
}

describe('MultiParameterTrendCard', () => {
  beforeEach(() => {
    seriesMock.mockReset();
  });

  it('renders one line per channel with unit-suffixed labels and axis grouping', () => {
    mockSeries();
    render(<MultiParameterTrendCard sensorId="sensor-1" channels={CHANNELS} />);

    const chart = screen.getByTestId('trend-chart');
    const lines = JSON.parse(String(chart.getAttribute('data-lines'))) as Array<{
      label: string;
      yAxis: number;
      color: string;
      zones?: unknown[];
    }>;

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ label: 'Su Sıcaklığı (°C)', yAxis: 1, color: '#146f84' });
    expect(lines[1]).toMatchObject({ yAxis: 2 }); // pH on the secondary axis
    // Thresholds become warning+critical value zones on the temperature line
    expect(lines[0].zones).toHaveLength(2);
    expect(lines[1].zones).toBeUndefined();
  });

  it('falls back to the palette when a channel has no color', () => {
    mockSeries();
    render(<MultiParameterTrendCard sensorId="sensor-1" channels={CHANNELS.slice(1)} />);

    const lines = JSON.parse(String(screen.getByTestId('trend-chart').getAttribute('data-lines')));
    expect(lines[0].color).toBe(colors.primary[700]); // first palette entry
  });

  it('shows the empty state when no series has points', () => {
    mockSeries(false, null, false);
    render(<MultiParameterTrendCard sensorId="sensor-1" channels={CHANNELS} />);
    expect(screen.getByText(/aralıkta trend verisi yok/i)).toBeTruthy();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
  });

  it('surfaces fetch errors as an alert', () => {
    mockSeries(false, 'gateway 502', false);
    render(<MultiParameterTrendCard sensorId="sensor-1" channels={CHANNELS} />);
    expect(screen.getByRole('alert').textContent).toContain('gateway 502');
  });
});
