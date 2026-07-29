/**
 * ForecastRefreshListener (D-6) — debounce + filtre davranışı pinleri:
 * aynı tenant'ın olay patlaması TEK yeniden hesapta birleşir, feed-dışı ve
 * out/waste stok hareketleri tetiklemez, geçersiz tenant fail-closed.
 */
import type { BaseEvent } from '@platform/event-contracts';

import {
  FORECAST_REFRESH_DEBOUNCE_MS,
  ForecastRefreshListener,
} from '../listeners/forecast-refresh.listener';
import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';
import { stub } from '@aquaculture/testing';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function event(overrides: Partial<BaseEvent> & Record<string, unknown>): BaseEvent {
  return { eventType: 'FeedTypeTransitioned', tenantId: TENANT, ...overrides } as BaseEvent;
}

describe('ForecastRefreshListener (D-6)', () => {
  const refreshTenant = jest.fn().mockResolvedValue(1);
  const listener = new ForecastRefreshListener(
    stub<ProtocolFeedForecastService>({ refreshTenant }),
  );

  beforeEach(() => {
    jest.useFakeTimers();
    refreshTenant.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aynı tenantın olay patlamasını tek yeniden hesapta birleştirir (trailing debounce)', async () => {
    await listener.onEvent(event({}));
    await listener.onEvent(event({ eventType: 'FeedingProtocolAssigned' }));
    await listener.onEvent(event({ eventType: 'FeedingProtocolAssignmentPaused' }));
    expect(refreshTenant).not.toHaveBeenCalled();

    jest.advanceTimersByTime(FORECAST_REFRESH_DEBOUNCE_MS);
    expect(refreshTenant).toHaveBeenCalledTimes(1);
    expect(refreshTenant).toHaveBeenCalledWith(TENANT);

    // Pencere kapandıktan sonra yeni olay yeni pencere açar.
    await listener.onEvent(event({}));
    jest.advanceTimersByTime(FORECAST_REFRESH_DEBOUNCE_MS);
    expect(refreshTenant).toHaveBeenCalledTimes(2);
  });

  it('stok hareketlerinde yalnız feed in|adjustment tetikler (out/waste/chemical değil)', () => {
    const stock = (movementType: string, itemType = 'feed'): BaseEvent =>
      event({ eventType: 'StockMovementRecorded', movementType, itemType });
    expect(listener.shouldRefresh(stock('in'))).toBe(true);
    expect(listener.shouldRefresh(stock('adjustment'))).toBe(true);
    expect(listener.shouldRefresh(stock('out'))).toBe(false);
    expect(listener.shouldRefresh(stock('waste'))).toBe(false);
    expect(listener.shouldRefresh(stock('in', 'chemical'))).toBe(false);
  });

  it('geçersiz tenant kimliği fail-closed elenir', () => {
    expect(listener.shouldRefresh(event({ tenantId: 'not-a-uuid' }))).toBe(false);
    expect(listener.shouldRefresh(event({ tenantId: undefined }))).toBe(false);
  });
});
