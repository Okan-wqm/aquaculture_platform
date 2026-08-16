/**
 * ForecastRefreshListener (D-6) — debounce + filtre davranışı pinleri:
 * aynı tenant'ın olay patlaması TEK yeniden hesapta birleşir, feed-dışı ve
 * out/waste stok hareketleri tetiklemez, geçersiz tenant fail-closed.
 */
import { createBaseEvent, type BaseEvent } from '@platform/event-contracts';
import type { DataSource } from 'typeorm';

import {
  FORECAST_REFRESH_DEBOUNCE_MS,
  ForecastRefreshListener,
} from '../listeners/forecast-refresh.listener';
import type { FeedingOperationCommandPort } from '../feeding-operation-command.port';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Tek-cast mock köprüsü (scheduled operation spec ailesiyle aynı desen). */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

function event(overrides: Partial<BaseEvent> & Record<string, unknown>): BaseEvent {
  return Object.assign(
    createBaseEvent('FeedingProtocolAssigned', TENANT, {
      aggregateId: SITE,
      aggregateType: 'ProtocolAssignment',
    }),
    { siteId: SITE },
    overrides,
  );
}

describe('ForecastRefreshListener (D-6)', () => {
  const refreshForecast = jest.fn<
    ReturnType<FeedingOperationCommandPort['refreshForecast']>,
    Parameters<FeedingOperationCommandPort['refreshForecast']>
  >(() => Promise.resolve(1));
  const listener = new ForecastRefreshListener({ refreshForecast }, mock<DataSource>({}));

  beforeEach(() => {
    jest.useFakeTimers();
    refreshForecast.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aynı tenantın olay patlamasını tek yeniden hesapta birleştirir (trailing debounce)', async () => {
    const first = event({});
    await listener.onEvent(first);
    await listener.onEvent(event({}));
    await listener.onEvent(event({}));
    expect(refreshForecast).not.toHaveBeenCalled();

    jest.advanceTimersByTime(FORECAST_REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    expect(refreshForecast).toHaveBeenCalledTimes(1);
    expect(refreshForecast).toHaveBeenCalledWith({
      tenantId: TENANT,
      siteId: SITE,
      actorId: 'event-bus:feeding-forecast',
      requestId: first.eventId,
      emitCoverageEvents: false,
    });

    // Pencere kapandıktan sonra yeni olay yeni pencere açar.
    await listener.onEvent(event({}));
    jest.advanceTimersByTime(FORECAST_REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    expect(refreshForecast).toHaveBeenCalledTimes(2);
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
