/**
 * PR-6 → small multiples: the card renders ONE chart per channel, each
 * parameter on its own y-axis (time shared on x), colors from the channel or
 * the design-system chartPalette, threshold bands as value-range zones.
 * uPlot renders into a stubbed TrendChart; assertions target the wiring, not
 * pixels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { chartPalette, I18nProvider } from '@aquaculture/shared-ui';
import type { TimeRangeSpec } from '@aquaculture/shared-contracts';

const seriesMock = vi.fn();
vi.mock('../../../hooks/useChannelReadings', () => ({
  useChannelSeries: (...args: unknown[]) => seriesMock(...args),
}));

vi.mock('../TrendChart', () => ({
  TrendChart: (props: Record<string, unknown>) => (
    <div
      data-testid="trend-chart"
      data-lines={JSON.stringify(props['lines'])}
      data-mode={String(props['mode'])}
      data-timezone={String(props['timeZone'])}
      data-breaks={JSON.stringify(props['breaks'])}
      data-options={JSON.stringify(props['options'] ?? {})}
      data-class={String(props['className'])}
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

const RANGE: TimeRangeSpec = { kind: 'relative', preset: '24h' };

function renderCard(
  channels: TrendChannelSpec[] = CHANNELS,
  extra: Partial<React.ComponentProps<typeof MultiParameterTrendCard>> = {},
): void {
  render(
    <I18nProvider locale="tr">
      <MultiParameterTrendCard sensorId="sensor-1" channels={channels} range={RANGE} {...extra} />
    </I18nProvider>,
  );
}

interface ChartLineJson {
  label: string;
  yAxis: number;
  color: string;
  zones?: unknown[];
}

/** The mocked charts on screen, each carrying exactly one line. */
function chartLines(): ChartLineJson[] {
  return screen.getAllByTestId('trend-chart').map((chart) => {
    const lines = JSON.parse(String(chart.getAttribute('data-lines'))) as ChartLineJson[];
    expect(lines).toHaveLength(1);
    return lines[0]!;
  });
}

function mockSeries(
  loading = false,
  error: string | null = null,
  hasData = true,
  displayTimeZoneSource: 'SITE' | 'TENANT' | 'UNAVAILABLE' = 'SITE',
) {
  seriesMock.mockReturnValue({
    loading,
    fetching: loading,
    error,
    // channelSeries shape: one entry per channel, points keyed by bucket.
    series: {
      sensorId: 'sensor-1',
      interval: '15 minutes',
      resolution: 'FIFTEEN_MINUTES',
      sourceTier: 'MINUTE',
      bucketTimeZone: displayTimeZoneSource === 'UNAVAILABLE' ? 'UTC' : 'Europe/Oslo',
      displayTimeZone: displayTimeZoneSource === 'UNAVAILABLE' ? 'UTC' : 'Europe/Oslo',
      displayTimeZoneSource,
      startTime: '1970-01-01T00:00:00.000Z',
      endTime: '1970-01-02T00:00:00.000Z',
      channels: [
        {
          channelId: 'c-temperature',
          channelKey: 'temperature',
          gaps: [{ start: '1970-01-01T06:00:00.000Z', end: '1970-01-01T08:00:00.000Z' }],
          points: hasData
            ? [{ bucket: '1970-01-01T00:00:01.000Z', avg: 22.5, min: 22, max: 23, count: 4 }]
            : [],
        },
        {
          channelId: 'c-ph',
          channelKey: 'ph',
          gaps: [],
          points: hasData
            ? [{ bucket: '1970-01-01T00:00:01.000Z', avg: 7.4, min: 7.3, max: 7.5, count: 4 }]
            : [],
        },
        { channelId: 'c-do', channelKey: 'dissolved_oxygen', gaps: [], points: [] },
      ],
    },
  });
}

describe('MultiParameterTrendCard', () => {
  beforeEach(() => {
    seriesMock.mockReset();
  });

  it('renders one chart per parameter, each on its own y-axis', () => {
    mockSeries();
    renderCard();

    // Temperature and pH have points → two charts; DO's empty range keeps a
    // grid cell instead of an empty chart.
    const charts = screen.getAllByTestId('trend-chart');
    expect(charts).toHaveLength(2);
    const lines = chartLines();
    expect(lines.map((line) => line.label)).toEqual(['Su Sıcaklığı (°C)', 'pH (pH)']);
    // Own chart → own scale: no axis is shared between units.
    expect(lines.every((line) => line.yAxis === 1)).toBe(true);
    expect(lines[0]).toMatchObject({ label: 'Su Sıcaklığı (°C)', color: '#146f84' });
    // Thresholds become warning+critical value zones on the temperature chart
    expect(lines[0].zones).toHaveLength(2);
    expect(lines[1].zones).toBeUndefined();
    // The uPlot legend is off: the cell header is the legend.
    expect(JSON.parse(String(charts[0]!.getAttribute('data-options')))).toEqual({
      legendMode: 'never',
    });
  });

  it('keeps a labelled cell for a parameter with no points in the range', () => {
    mockSeries();
    renderCard();

    expect(screen.getByText(/Çözünmüş Oksijen \(mg\/L\) — Bu aralıkta veri yok\./)).toBeTruthy();
    expect(screen.getAllByTestId('trend-chart')).toHaveLength(2);
  });

  it('falls back to the design-system chartPalette when a channel has no color', () => {
    mockSeries();
    renderCard(CHANNELS.slice(1));

    // Only pH has points (DO keeps an empty cell); pH leads the palette.
    const lines = chartLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.color).toBe(chartPalette[0]);
  });

  it('shows the empty state when no series has points', () => {
    mockSeries(false, null, false);
    renderCard();
    expect(screen.getByText('Bu aralıkta veri yok.')).toBeTruthy();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
  });

  it('surfaces fetch errors as an alert', () => {
    mockSeries(false, 'gateway 502', false);
    renderCard();
    expect(screen.getByRole('alert').textContent).toContain('gateway 502');
  });

  it('says what it returned: bucket width, store and the zone buckets were counted in', () => {
    mockSeries();
    renderCard();
    expect(screen.getByText('15 dakikalık kova · dakika özeti · Europe/Oslo')).toBeTruthy();
    for (const chart of screen.getAllByTestId('trend-chart')) {
      expect(chart.getAttribute('data-timezone')).toBe('Europe/Oslo');
    }
  });

  it('breaks lines where a channel has no data instead of joining across it', () => {
    mockSeries();
    renderCard();
    const parsed = screen.getAllByTestId('trend-chart').map(
      (chart) =>
        JSON.parse(String(chart.getAttribute('data-lines'))) as Array<{
          spanGaps: boolean;
          showIsolatedPoints: boolean;
        }>,
    );
    expect(
      parsed.every(([line]) => line.spanGaps === false && line.showIsolatedPoints === true),
    ).toBe(true);
  });

  it('offers to show the last stored data when the range is empty', () => {
    mockSeries(false, null, false);
    const onShowRange = vi.fn();
    const lastSampleAt = Date.parse('2026-09-19T14:02:30Z');
    renderCard(CHANNELS, { lastSampleAt, onShowRange });
    fireEvent.click(screen.getByRole('button', { name: 'Son veriyi göster' }));
    // Same length as the range shown (24 h), ending with the last sample's minute.
    expect(onShowRange).toHaveBeenCalledWith({
      kind: 'absolute',
      startMs: Date.parse('2026-09-18T14:03:00Z'),
      endMs: Date.parse('2026-09-19T14:03:00Z'),
    });
  });

  it('says when the site zone could not be read and times are in UTC', () => {
    mockSeries(false, null, true, 'UNAVAILABLE');
    renderCard();
    expect(screen.getByText('Saha saat dilimi okunamadı; saatler UTC')).toBeTruthy();
  });

  it('breaks each chart at the gaps the server reported for its channel', () => {
    mockSeries();
    renderCard();

    const byChannel = screen
      .getAllByTestId('trend-chart')
      .map(
        (chart) =>
          JSON.parse(String(chart.getAttribute('data-breaks'))) as Record<string, number[]>,
      );
    // Each chart carries only its own channel's gaps.
    expect(byChannel[0]).toEqual({ temperature: [Date.parse('1970-01-01T06:00:00.000Z')] });
    expect(byChannel[1]).toEqual({ ph: [] });
  });

  it('never says "no data" before the answer for the range has arrived', () => {
    seriesMock.mockReturnValue({ series: null, loading: true, fetching: true, error: null });
    renderCard(CHANNELS, {
      lastSampleAt: Date.parse('2026-09-19T14:02:30Z'),
      onShowRange: vi.fn(),
    });
    expect(screen.queryByText('Bu aralıkta veri yok.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Son veriyi göster' })).toBeNull();
  });

  it('judges "no data" by the channels it shows, not the sensor\'s others', () => {
    mockSeries();
    // Only dissolved oxygen is shown (the page filter); it has no points,
    // though temperature and pH do.
    renderCard([CHANNELS[2]!]);
    expect(screen.getByText('Bu aralıkta veri yok.')).toBeTruthy();
    expect(screen.queryByTestId('trend-chart')).toBeNull();
  });

  it("names the sensor in its buttons' accessible names", () => {
    mockSeries();
    renderCard(CHANNELS, { sensorName: 'Sonde A' });
    expect(screen.getByRole('button', { name: 'Sonde A serisini dışa aktar' })).toBeTruthy();
  });
});
