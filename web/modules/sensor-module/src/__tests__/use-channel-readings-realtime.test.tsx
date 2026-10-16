/**
 * useChannelReadingsRealtime: a socket push is a SIGNAL, not a value source.
 * An arrival invalidates the tenant-scoped channel-reading queries (the
 * server stays the SSoT for what is shown); a burst of arrivals collapses
 * into one refetch round; an unauthenticated session invalidates nothing.
 */
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SensorReading } from '../hooks/useSensorSocket';

let readingsValue: Map<string, SensorReading> = new Map();
let connectedValue = true;
let tenantIdValue: string | null = 'tenant-1';

const socketMock = vi.fn();

vi.mock('../hooks/useSensorSocket', () => ({
  useSensorSocket: (...args: unknown[]) => socketMock(...args),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return { ...actual, useAuth: () => ({ tenantId: tenantIdValue }) };
});

import { useChannelReadingsRealtime } from '../hooks/useChannelReadingsRealtime';

function reading(): SensorReading {
  return {
    eventId: 'evt-1',
    sensorId: 's1',
    sensorName: 'Sonde',
    tenantId: 'tenant-1',
    readings: { temperature: 24.2 },
    timestamp: new Date().toISOString(),
  };
}

function renderRealtime() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const utils = renderHook(() => useChannelReadingsRealtime(['s1']), {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { ...utils, invalidateSpy };
}

describe('useChannelReadingsRealtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    readingsValue = new Map();
    connectedValue = true;
    tenantIdValue = 'tenant-1';
    socketMock.mockReset();
    socketMock.mockImplementation(() => ({ isConnected: connectedValue, readings: readingsValue }));
  });

  it('invalidates the channel-reading query families on an arrival', () => {
    const { invalidateSpy, rerender } = renderRealtime();
    expect(invalidateSpy).not.toHaveBeenCalled();

    readingsValue = new Map([['s1', reading()]]);
    act(() => {
      rerender();
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(3);
    const keys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toEqual([
      ['tenant', 'tenant-1', 'sensor', 'channel-latest-values'],
      ['tenant', 'tenant-1', 'sensor', 'channel-series'],
      ['tenant', 'tenant-1', 'sensor', 'channel-data-bounds'],
    ]);
  });

  it('collapses a burst of arrivals into one refetch round', () => {
    const { invalidateSpy, rerender } = renderRealtime();

    readingsValue = new Map([['s1', reading()]]);
    act(() => {
      rerender();
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);

    // A second push within the throttle window must not refetch again.
    readingsValue = new Map([['s1', { ...reading(), eventId: 'evt-2' }]]);
    act(() => {
      rerender();
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);

    // Past the window, the next arrival refreshes again.
    act(() => {
      vi.setSystemTime(new Date('2026-10-16T10:00:05Z'));
    });
    readingsValue = new Map([['s1', { ...reading(), eventId: 'evt-3' }]]);
    act(() => {
      rerender();
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(6);
  });

  it('invalidates nothing while unauthenticated', () => {
    tenantIdValue = null;
    const { invalidateSpy, rerender } = renderRealtime();

    readingsValue = new Map([['s1', reading()]]);
    rerender();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('reports the socket connection state', () => {
    connectedValue = false;
    const { result } = renderRealtime();
    expect(result.current).toBe(false);
  });
});
