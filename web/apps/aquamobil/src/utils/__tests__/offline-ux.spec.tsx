// MOB-LOW-011 — offline UX polish: a global last-synced clock and optimistic
// KPI bumps for offline farm writes.
//
// Before: the `aquamobil_last_sync_at` stamp was written ONLY by the Account
// page's manual sync button (auto-drains never updated it), and an offline
// mortality/feeding/WQ record left the Daily Ops KPI cards stale until the
// server round-trip. recordLastSyncAt() now lives at the drain convergence
// point, and applyOptimisticKpiBump() flips the tenant-scoped KPI caches the
// instant an operation is queued — server truth reconciles on sync.

import { QueryClient } from '@tanstack/react-query';
import { describe, it, expect, beforeEach } from 'vitest';

import { getLastSyncAt, recordLastSyncAt, LAST_SYNC_STORAGE_KEY } from '../last-sync';
import { applyOptimisticKpiBump } from '../offline-optimistic';

const TENANT = 'tenant-1';

describe('last-sync clock (MOB-LOW-011)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records and reads the stamp', () => {
    expect(getLastSyncAt()).toBeNull();
    recordLastSyncAt();
    const stamp = getLastSyncAt();
    expect(stamp).toBeTruthy();
    expect(new Date(stamp as string).getTime()).toBeGreaterThan(0);
    expect(localStorage.getItem(LAST_SYNC_STORAGE_KEY)).toBe(stamp);
  });
});

describe('optimistic KPI bumps (MOB-LOW-011)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it('bumps the daily-ops mortality counter on a queued mortality', () => {
    const key = ['tenant', TENANT, 'dailyOpsCounts', TENANT];
    queryClient.setQueryData(key, {
      mortalityCount: 2,
      wqReadingsCount: 1,
      feedingCompletedCount: 0,
      feedingTotalCount: 4,
    });

    applyOptimisticKpiBump(queryClient, TENANT, 'recordMortality');

    expect(queryClient.getQueryData(key)).toMatchObject({ mortalityCount: 3, wqReadingsCount: 1 });
  });

  it('bumps WQ readings and feeding-completed for their operations', () => {
    const key = ['tenant', TENANT, 'dailyOpsCounts', TENANT];
    queryClient.setQueryData(key, {
      mortalityCount: 0,
      wqReadingsCount: 1,
      feedingCompletedCount: 2,
      feedingTotalCount: 4,
    });

    applyOptimisticKpiBump(queryClient, TENANT, 'createWaterQuality');
    applyOptimisticKpiBump(queryClient, TENANT, 'recordFeeding');

    expect(queryClient.getQueryData(key)).toMatchObject({
      wqReadingsCount: 2,
      feedingCompletedCount: 3,
    });
  });

  it('bumps feeding-completed for a FINALIZING meal pour only (Faz 6 öğün cutover)', () => {
    const key = ['tenant', TENANT, 'dailyOpsCounts', TENANT];
    queryClient.setQueryData(key, {
      mortalityCount: 0,
      wqReadingsCount: 0,
      feedingCompletedCount: 2,
      feedingTotalCount: 4,
    });

    // finalize'sız döküm öğünü partially_fed bırakır — "tamamlandı" sayılamaz.
    applyOptimisticKpiBump(queryClient, TENANT, 'recordMealFeeding', {
      mealId: 'meal-1',
      pourKg: 2,
      finalize: false,
    });
    expect(queryClient.getQueryData(key)).toMatchObject({ feedingCompletedCount: 2 });

    applyOptimisticKpiBump(queryClient, TENANT, 'recordMealFeeding', {
      mealId: 'meal-1',
      pourKg: 4,
      finalize: true,
    });
    expect(queryClient.getQueryData(key)).toMatchObject({ feedingCompletedCount: 3 });
  });

  it('bumps the stock-events weekly counter for cull/harvest/transfer', () => {
    const key = ['tenant', TENANT, 'stockEventsSummary', TENANT];
    queryClient.setQueryData(key, { thisWeekEventsCount: 5 });

    applyOptimisticKpiBump(queryClient, TENANT, 'recordCull');
    applyOptimisticKpiBump(queryClient, TENANT, 'createHarvestRecord');
    applyOptimisticKpiBump(queryClient, TENANT, 'recordTransfer');

    expect(queryClient.getQueryData(key)).toMatchObject({ thisWeekEventsCount: 8 });
  });

  it('is a no-op for operations without a KPI mapping and for cold caches', () => {
    applyOptimisticKpiBump(queryClient, TENANT, 'sendMessage');
    applyOptimisticKpiBump(queryClient, TENANT, 'recordMortality');

    // Nothing was seeded, so nothing must be created out of thin air.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
