/**
 * /sensor/readings renders stored channel values (SENSOR-HIGH-138).
 *
 * Regression: the page generated Math.random() values per sensor TYPE, so a
 * five-channel water-quality sonde of type "temperature" showed one invented
 * temperature. Here the page must show every enabled channel of the sensor
 * with exactly the value the backend returned.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@aquaculture/shared-ui';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ChannelLatestValue } from '../graphql/channelReadings';
import type { RegisteredSensor } from '../hooks/useSensorList';

const SENSOR: RegisteredSensor = {
  id: 'f0b8b1a6-df19-42de-ba9a-8523c949ea65',
  name: 'Codex Su Sıcaklığı Simülatörü',
  type: 'temperature',
  protocolCode: 'MQTT',
  protocolConfiguration: { topic: 'sensors/codex-test/water-temp-01' },
  registrationStatus: 'draft',
  tenantId: '7f6b08ab-90e2-46d3-a260-cb985f1fd897',
  createdAt: '',
  updatedAt: '',
};

function channel(
  channelKey: string,
  displayLabel: string,
  value: number,
  unit: string,
  precision: number,
  alertLevel: ChannelLatestValue['alertLevel'] = 'NORMAL',
): ChannelLatestValue {
  return {
    sensorId: SENSOR.id,
    channelId: `ch-${channelKey}`,
    channelKey,
    displayLabel,
    unit,
    unitSymbol: unit,
    displayOrder: 1,
    precision,
    value,
    time: new Date(Date.now() - 10_000).toISOString(),
    qualityCode: 192,
    alertLevel,
  };
}

const CHANNELS: ChannelLatestValue[] = [
  channel('temperature', 'Su Sıcaklığı', 24.2, '°C', 1),
  channel('ph', 'pH', 7.34, 'pH', 2),
  channel('dissolved_oxygen', 'Çözünmüş Oksijen', 5.86, 'mg/L', 2),
  channel('salinity', 'Tuzluluk', 19.9, '‰', 1),
  channel('ammonia', 'Amonyak (NH3-N)', 0.114, 'mg/L', 3, 'WARNING'),
];

const latestHook = vi.fn();
const seriesHook = vi.fn();
const zoneHook = vi.fn();

vi.mock('../hooks/useSensorList', () => ({
  useSensorList: () => ({ sensors: [SENSOR], loading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('../hooks/useChannelReadings', () => ({
  useChannelLatestValues: (...args: unknown[]) => latestHook(...args),
  useChannelSeries: (...args: unknown[]) => seriesHook(...args),
  useSeriesDisplayTimeZone: (...args: unknown[]) => zoneHook(...args),
  useChannelDataBounds: () =>
    new Map([
      [
        'ch-temperature',
        {
          sensorId: SENSOR.id,
          channelId: 'ch-temperature',
          firstSampleAt: '2026-09-16T08:00:00.000Z',
          lastSampleAt: '2026-09-19T14:02:00.000Z',
        },
      ],
    ]),
}));
vi.mock('../components/charts/TrendChart', () => ({ TrendChart: () => null }));

import ReadingsPage from '../pages/ReadingsPage';

/** The page under its router and the Turkish locale, at a URL. */
function renderAt(url = '/sensor/readings'): void {
  render(
    <I18nProvider locale="tr">
      <MemoryRouter initialEntries={[url]}>
        <ReadingsPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('ReadingsPage', () => {
  beforeEach(() => {
    latestHook.mockReturnValue({
      bySensor: new Map([[SENSOR.id, CHANNELS]]),
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    seriesHook.mockReturnValue({ series: null, loading: false, error: null });
    zoneHook.mockReturnValue({
      zone: { displayTimeZone: 'Europe/Oslo', source: 'SITE' },
      loading: false,
      error: null,
    });
  });

  it('shows every channel of the sensor with the stored value, not one random temperature', () => {
    const random = vi.spyOn(Math, 'random');
    renderAt();

    for (const [key, text] of [
      ['temperature', '24,2'],
      ['ph', '7,34'],
      ['dissolved_oxygen', '5,86'],
      ['salinity', '19,9'],
      ['ammonia', '0,114'],
    ] as const) {
      expect(
        within(screen.getByTestId(`channel-tile-${key}`)).getByText(text, { exact: false }),
      ).toBeTruthy();
    }
    expect(screen.getByText('Veri akıyor')).toBeTruthy();
    expect(within(screen.getByTestId('channel-tile-ammonia')).getByText('Uyarı')).toBeTruthy();
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('asks only for the sensors that own channels and refreshes every 30 s', () => {
    renderAt();
    expect(latestHook).toHaveBeenLastCalledWith([SENSOR.id], 30_000);
  });

  it('stops polling when switched to manual', () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: 'Otomatik (30s)' }));
    expect(latestHook).toHaveBeenLastCalledWith([SENSOR.id], false);
  });

  it('filters the tiles by parameter', () => {
    renderAt();
    fireEvent.change(screen.getByLabelText('Parametre'), { target: { value: 'ph' } });
    expect(screen.getByTestId('channel-tile-ph')).toBeTruthy();
    expect(screen.queryByTestId('channel-tile-temperature')).toBeNull();
  });

  it('charts the range the link names', () => {
    renderAt('/sensor/readings?range=7d');
    expect(seriesHook).toHaveBeenLastCalledWith(SENSOR.id, { kind: 'relative', preset: '7d' });
    expect(screen.getByRole('button', { name: /Son 7 gün/ })).toBeTruthy();
  });

  it('says so when the link carries a range it cannot use, and charts the default', () => {
    renderAt('/sensor/readings?range=forever');
    expect(screen.getByRole('alert').textContent).toContain('varsayılan aralık');
    expect(seriesHook).toHaveBeenLastCalledWith(SENSOR.id, { kind: 'relative', preset: '24h' });
  });

  it('offers no picker until the server names the zone to pick days in', () => {
    zoneHook.mockReturnValue({ zone: null, loading: true, error: null });
    renderAt();
    expect(screen.queryByRole('button', { name: /Zaman aralığı seç/ })).toBeNull();
  });

  it('puts a broken link right when its default range is picked', () => {
    renderAt('/sensor/readings?range=forever');
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Zaman aralığı seç: Son 24 saat/ }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Son 24 saat' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the zone for the charts cannot be read', () => {
    zoneHook.mockReturnValue({ zone: null, loading: false, error: 'gateway 502' });
    renderAt();
    expect(screen.getByRole('alert').textContent).toContain('gateway 502');
  });
});
