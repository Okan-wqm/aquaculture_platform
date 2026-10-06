/**
 * Dashboard widgets read by channel (SENSOR-HIGH-142).
 *
 * A widget's selected channels used to be resolved through the nine-parameter
 * latestReadingsBatch / aggregatedReadings projections, so a channel outside
 * that vocabulary (conductivity, ORP, a vendor key) never showed a value, and
 * every value was reported with status 'normal'. The hook now reads
 * channelLatestValues / channelSeries and matches by channel id.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WidgetConfig } from '../../components/dashboard/types';
import { CHANNEL_LATEST_VALUES_QUERY, CHANNEL_SERIES_QUERY } from '../../graphql/channelReadings';

const SENSOR_ID = 'f0b8b1a6-df19-42de-ba9a-8523c949ea65';
const fetchMock = vi.fn();

vi.mock('../../config/api', () => ({
  graphqlFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../useSensorSocket', () => ({
  useSensorSocket: () => ({
    isConnected: false,
    readings: new Map(),
    getLatestReading: () => null,
  }),
}));

import { useWidgetData } from '../useWidgetData';

const CONFIG: WidgetConfig = {
  id: 'w-1',
  type: 'line-chart',
  title: 'Su kalitesi',
  timeRange: '1h',
  refreshInterval: 60_000,
  gridPosition: { x: 0, y: 0, w: 4, h: 3 },
  selectedChannels: [
    {
      id: 'ch-ammonia',
      channelKey: 'ammonia',
      displayLabel: 'Amonyak',
      unit: 'mg/L',
      sensorId: SENSOR_ID,
      sensorName: 'WT-CODEX-01',
    },
    {
      id: 'ch-conductivity',
      channelKey: 'conductivity',
      displayLabel: 'İletkenlik',
      unit: 'µS/cm',
      sensorId: SENSOR_ID,
      sensorName: 'WT-CODEX-01',
    },
  ],
};

function latest(channelId: string, channelKey: string, value: number, alertLevel: string) {
  return {
    sensorId: SENSOR_ID,
    channelId,
    channelKey,
    displayLabel: channelKey,
    unit: null,
    unitSymbol: null,
    displayOrder: 1,
    precision: 2,
    value,
    time: '2026-10-06T10:32:07.803Z',
    qualityCode: 192,
    alertLevel,
  };
}

describe('useWidgetData — selected channels', () => {
  afterEach(() => fetchMock.mockReset());

  it('shows each selected channel, including one outside the nine parameters, with its alert level', async () => {
    fetchMock.mockImplementation((query: string) => {
      if (query === CHANNEL_LATEST_VALUES_QUERY) {
        return Promise.resolve({
          channelLatestValues: [
            latest('ch-ammonia', 'ammonia', 0.42, 'WARNING'),
            latest('ch-conductivity', 'conductivity', 41_350, 'NORMAL'),
            latest('ch-ph', 'ph', 7.3, 'NORMAL'),
          ],
        });
      }
      if (query === CHANNEL_SERIES_QUERY) {
        return Promise.resolve({
          channelSeries: {
            sensorId: SENSOR_ID,
            interval: '1 minute',
            startTime: '',
            endTime: '',
            channels: [
              {
                channelId: 'ch-conductivity',
                channelKey: 'conductivity',
                points: [
                  {
                    bucket: '2026-10-06T10:31:00.000Z',
                    avg: 41_300,
                    min: 41_200,
                    max: 41_400,
                    count: 6,
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected query: ${query.slice(0, 60)}`));
    });

    const { result } = renderHook(() => useWidgetData(CONFIG));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(
      result.current.data.map(({ sensorId, value, status }) => ({ sensorId, value, status })),
    ).toEqual([
      { sensorId: 'ch-ammonia', value: 0.42, status: 'warning' },
      { sensorId: 'ch-conductivity', value: 41_350, status: 'normal' },
    ]);
    await waitFor(() => expect(result.current.history).toHaveLength(1));
    expect(result.current.history[0]).toMatchObject({
      sensorId: 'ch-conductivity',
      channelKey: 'conductivity',
      value: 41_300,
    });
    expect(fetchMock).toHaveBeenCalledWith(CHANNEL_LATEST_VALUES_QUERY, { sensorIds: [SENSOR_ID] });
  });
});
