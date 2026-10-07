/**
 * PR-6: the multi-parameter card derives one ChartLine per channel (colors,
 * axis grouping, threshold zones) and hands TrendChart custom-mode data.
 * uPlot renders into a stubbed canvas; assertions target the wiring, not pixels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { colors, I18nProvider } from '@aquaculture/shared-ui';
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

  it('renders one line per channel with unit-suffixed labels and axis grouping', () => {
    mockSeries();
    renderCard();

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
    renderCard(CHANNELS.slice(1));

    const lines = JSON.parse(String(screen.getByTestId('trend-chart').getAttribute('data-lines')));
    expect(lines[0].color).toBe(colors.primary[700]); // first palette entry
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
    expect(screen.getByTestId('trend-chart').getAttribute('data-timezone')).toBe('Europe/Oslo');
  });

  it('breaks lines where a channel has no data instead of joining across it', () => {
    mockSeries();
    renderCard();
    const lines = JSON.parse(String(screen.getByTestId('trend-chart').getAttribute('data-lines')));
    expect(lines.every((line: { spanGaps: boolean }) => line.spanGaps === false)).toBe(true);
    expect(lines.every((line: { showIsolatedPoints: boolean }) => line.showIsolatedPoints)).toBe(
      true,
    );
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

  it('breaks each line at the gaps the server reported for that channel', () => {
    mockSeries();
    renderCard();
    const breaks = JSON.parse(
      String(screen.getByTestId('trend-chart').getAttribute('data-breaks')),
    );
    expect(breaks).toEqual({
      temperature: [Date.parse('1970-01-01T06:00:00.000Z')],
      ph: [],
      dissolved_oxygen: [],
    });
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
