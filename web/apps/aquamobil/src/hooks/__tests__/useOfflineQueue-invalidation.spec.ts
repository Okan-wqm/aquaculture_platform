/**
 * Offline queue read-after-write invalidation tests.
 *
 * WHY: queued farm mutations are confirmed asynchronously. If sync succeeds
 * without invalidating tenant-scoped farm query keys, the database can contain
 * the updated row while mobile list/card/detail screens continue rendering
 * stale React Query or offline-cache data.
 */
import { describe, expect, it } from 'vitest';

import { getSyncedOperationInvalidationKeys } from '@/utils/offline-sync-invalidation';
import type { OperationType } from '@/types';

describe('offline queue synced operation invalidation', () => {
  it('invalidates tenant-scoped farm visibility keys for feeding, mortality, transfer, harvest, and water-quality syncs', () => {
    const operationTypes: OperationType[] = [
      'recordFeeding',
      'recordMortality',
      'recordTransfer',
      'createHarvestRecord',
      'createWaterQuality',
    ];

    expect(getSyncedOperationInvalidationKeys('tenant-1', operationTypes)).toEqual([
      ['tenant', 'tenant-1', 'tanks'],
      ['tenant', 'tenant-1', 'feedingPlan'],
      ['tenant', 'tenant-1', 'dailyOpsCounts'],
      ['tenant', 'tenant-1', 'stockEventsSummary'],
      ['tenant', 'tenant-1', 'ai'],
      ['tenant', 'tenant-1', 'equipment-params'],
      ['tenant', 'tenant-1', 'waterQuality'],
    ]);
  });

  it('deduplicates shared invalidation keys across synced operation types', () => {
    expect(getSyncedOperationInvalidationKeys('tenant-1', ['recordFeeding', 'recordMortality'])).toEqual([
      ['tenant', 'tenant-1', 'tanks'],
      ['tenant', 'tenant-1', 'feedingPlan'],
      ['tenant', 'tenant-1', 'dailyOpsCounts'],
      ['tenant', 'tenant-1', 'stockEventsSummary'],
      ['tenant', 'tenant-1', 'ai'],
    ]);
  });

  it('invalidates task, storage, and messaging read models through the same tenant-scoped map', () => {
    expect(getSyncedOperationInvalidationKeys('tenant-1', [
      'completeTask',
      'recordStockMovement',
      'sendMessage',
    ])).toEqual([
      ['tenant', 'tenant-1', 'myTasks'],
      ['tenant', 'tenant-1', 'taskStats'],
      ['tenant', 'tenant-1', 'dailyOpsCounts'],
      ['tenant', 'tenant-1', 'stockEventsSummary'],
      ['tenant', 'tenant-1', 'stock-at-location'],
      ['tenant', 'tenant-1', 'warehouseSummary'],
      ['tenant', 'tenant-1', 'messaging', 'channels'],
      ['tenant', 'tenant-1', 'messaging', 'messages'],
      ['tenant', 'tenant-1', 'messaging', 'unreadCount'],
    ]);
  });
});
