import { render } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import { DataProviderContext } from '../../providers';
import { useRealtimeData } from '../useRealtimeData';
import type { IDataProvider, HistoricalDataResult } from '../../types/scada-runtime.types';

/**
 * Subscription-id de-collision (SENSOR-HIGH-040).
 *
 * Every useRealtimeData consumer must subscribe under its OWN id so the
 * ref-counting manager tracks each independently. Previously all consumers
 * shared a fixed '__live_provider__' id, so one widget unmounting recomputed
 * and re-subscribed the shared set, silently dropping tags other mounted
 * consumers still needed.
 */

function makeMockProvider() {
  const subscribeToTags = vi.fn();
  const unsubscribeFromTags = vi.fn();
  const provider: IDataProvider = {
    subscribeToTags,
    unsubscribeFromTags,
    writeTagValue: async () => {},
    getTagValue: () => null,
    getTagSnapshot: () => ({}),
    queryHistory: async (): Promise<HistoricalDataResult> => ({ data: {} }),
    connectionState: 'connected',
  };
  return { provider, subscribeToTags, unsubscribeFromTags };
}

const Consumer: React.FC<{ tag: string }> = ({ tag }) => {
  useRealtimeData([tag]);
  return null;
};

describe('useRealtimeData subscription id (SENSOR-HIGH-040)', () => {
  it('subscribes each consumer under a distinct component id', () => {
    const { provider, subscribeToTags } = makeMockProvider();
    render(
      <DataProviderContext.Provider value={provider}>
        <Consumer tag="tagA" />
        <Consumer tag="tagB" />
      </DataProviderContext.Provider>,
    );

    expect(subscribeToTags).toHaveBeenCalledTimes(2);
    const ids = subscribeToTags.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(2); // two distinct ids, no collision
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('unsubscribes by the same component id on unmount', () => {
    const { provider, subscribeToTags, unsubscribeFromTags } = makeMockProvider();
    const { unmount } = render(
      <DataProviderContext.Provider value={provider}>
        <Consumer tag="tagA" />
      </DataProviderContext.Provider>,
    );
    const subscribedId = subscribeToTags.mock.calls[0][0] as string;
    unmount();
    expect(unsubscribeFromTags).toHaveBeenCalledWith(subscribedId);
  });
});
