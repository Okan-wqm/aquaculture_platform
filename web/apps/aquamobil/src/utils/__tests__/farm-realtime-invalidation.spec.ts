import { QueryClient } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';

import {
  FARM_REALTIME_INVALIDATION_SEGMENTS,
  FARM_REALTIME_ALL_SEGMENTS,
  invalidateAllFarmQueries,
  invalidateFarmEventQueries,
  isFarmRealtimeEvent,
} from '../farm-realtime-invalidation';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mockClient(): { client: QueryClient; keys: () => unknown[][] } {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  return {
    client,
    keys: () => spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey),
  };
}

describe('farm-realtime-invalidation', () => {
  it('invalidates the tank + ops caches for a count-affecting event, tenant-prefixed', async () => {
    const { client, keys } = mockClient();
    await invalidateFarmEventQueries(client, TENANT, 'mortalityRecorded');

    const invalidated = keys();
    // every key carries the tenant prefix (no bare keys)
    for (const key of invalidated) {
      expect(key[0]).toBe('tenant');
      expect(key[1]).toBe(TENANT);
    }
    const segments = invalidated.map((k) => k.slice(2));
    expect(segments).toContainEqual(['tanks']);
    expect(segments).toContainEqual(['dailyOpsCounts']);
    expect(segments).toContainEqual(['stockEventsSummary']);
  });

  it('every count-affecting event invalidates the tank cache (the 719-vs-900 class)', async () => {
    for (const eventName of ['mortalityRecorded', 'cullRecorded', 'batchTransferred', 'batchAllocatedToTank', 'feedingRecorded'] as const) {
      const { client, keys } = mockClient();
      await invalidateFarmEventQueries(client, TENANT, eventName);
      const segments = keys().map((k) => k.slice(2));
      expect(segments).toContainEqual(['tanks']);
    }
  });

  it('is a no-op for an unknown / non-farm event (e.g. site management the app does not show)', async () => {
    const { client, keys } = mockClient();
    await invalidateFarmEventQueries(client, TENANT, 'siteCreated');
    await invalidateFarmEventQueries(client, TENANT, 'somethingElse');
    expect(keys()).toHaveLength(0);
    expect(isFarmRealtimeEvent('siteCreated')).toBe(false);
    expect(isFarmRealtimeEvent('mortalityRecorded')).toBe(true);
  });

  it('reconnect invalidates the whole farm namespace (union of all segments)', async () => {
    const { client, keys } = mockClient();
    await invalidateAllFarmQueries(client, TENANT);
    const segments = keys().map((k) => k.slice(2));
    expect(segments).toContainEqual(['tanks']);
    expect(segments).toContainEqual(['feedingDayPlans']);
    expect(segments).toContainEqual(['equipment-params']);
    // the union is de-duplicated
    expect(keys().length).toBe(FARM_REALTIME_ALL_SEGMENTS.length);
  });

  it('the map covers the FarmGateway count/feeding/tank events', () => {
    const mapped = Object.keys(FARM_REALTIME_INVALIDATION_SEGMENTS);
    for (const required of ['mortalityRecorded', 'cullRecorded', 'batchTransferred', 'batchAllocatedToTank', 'feedingRecorded', 'tankUpdated']) {
      expect(mapped).toContain(required);
    }
  });

  it('the map covers the v2 meal engine events (C-2 cutover)', async () => {
    const mapped = Object.keys(FARM_REALTIME_INVALIDATION_SEGMENTS);
    for (const required of [
      'mealFed',
      'mealSkipped',
      'mealMissed',
      'mealUnderfed',
      'feedTypeTransitioned',
      'unfedUnitDetected',
    ]) {
      expect(mapped).toContain(required);
    }

    // Bir öğün dökümü öğün planını, tank kartlarını ve gün sayaçlarını tazeler.
    const { client, keys } = mockClient();
    await invalidateFarmEventQueries(client, TENANT, 'mealFed');
    const segments = keys().map((k) => k.slice(2));
    expect(segments).toContainEqual(['feedingDayPlans']);
    expect(segments).toContainEqual(['tanks']);
    expect(segments).toContainEqual(['dailyOpsCounts']);
  });
});
