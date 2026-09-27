/**
 * PR-6: per-channel series mapping over the tiered aggregatedReadings query —
 * bucket→unix-ms conversion, snake_case channelKey → avgCamelCase field
 * resolution, null-skip for parameters absent from a bucket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';

const graphqlFetchMock = vi.fn();
vi.mock('../../config/api', () => ({
  graphqlFetch: (...args: unknown[]) => graphqlFetchMock(...args),
}));

import { useAggregatedMultiSeries } from '../useAggregatedMultiSeries';

function wrapper({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

describe('useAggregatedMultiSeries', () => {
  beforeEach(() => {
    graphqlFetchMock.mockReset();
  });

  it('maps buckets to per-channel points resolving snake_case keys', async () => {
    graphqlFetchMock.mockResolvedValue({
      aggregatedReadings: {
        data: [
          {
            bucket: '2026-09-16T10:00:00.000Z',
            count: 6,
            avgTemperature: 22.5,
            avgPh: 7.4,
            avgDissolvedOxygen: 6.2,
          },
          {
            bucket: '2026-09-16T10:01:00.000Z',
            count: 6,
            avgTemperature: 22.7,
            avgDissolvedOxygen: 6.1,
          },
        ],
      },
    });

    const { result } = renderHook(
      () =>
        useAggregatedMultiSeries('sensor-1', ['temperature', 'ph', 'dissolved_oxygen'], 3_600_000),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.series['temperature']).toEqual([
      { timestamp: Date.parse('2026-09-16T10:00:00.000Z'), value: 22.5 },
      { timestamp: Date.parse('2026-09-16T10:01:00.000Z'), value: 22.7 },
    ]);
    // Parameter missing from the second bucket is skipped, not zero-filled.
    expect(result.current.series['ph']).toHaveLength(1);
    expect(result.current.series['dissolved_oxygen']).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('surfaces fetch errors and empties the series', async () => {
    graphqlFetchMock.mockRejectedValue(new Error('gateway 502'));

    const { result } = renderHook(
      () => useAggregatedMultiSeries('sensor-1', ['temperature'], 3_600_000),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBe('gateway 502'));
    expect(result.current.series['temperature']).toEqual([]);
  });

  it('does not fetch without a sensorId', async () => {
    const { result } = renderHook(
      () => useAggregatedMultiSeries(null, ['temperature'], 3_600_000),
      { wrapper },
    );

    expect(graphqlFetchMock).not.toHaveBeenCalled();
    expect(result.current.series['temperature']).toEqual([]);
  });

  it('requests the window derived from rangeMs', async () => {
    graphqlFetchMock.mockResolvedValue({ aggregatedReadings: { data: [] } });

    const { result } = renderHook(
      () => useAggregatedMultiSeries('sensor-1', ['temperature'], 60_000),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const variables = graphqlFetchMock.mock.calls[0][1];
    const deltaMs = Date.parse(variables.endTime) - Date.parse(variables.startTime);
    expect(Math.abs(deltaMs - 60_000)).toBeLessThan(2_000);
  });
});
