import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import type { OperationType } from '@/types';
import type { QueryClient } from '@tanstack/react-query';

// WHY: offline sync is the only write path when field users reconnect. Mapping
// each synced mutation to tenant-scoped read models prevents DB-committed farm
// changes from remaining invisible in cached mobile list/card/detail screens.
const SYNC_INVALIDATION_SEGMENTS: Partial<Record<OperationType, readonly (readonly unknown[])[]>> = {
  recordMortality: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  recordCull: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  createHarvestRecord: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  recordFeeding: [['tanks'], ['feedingPlan'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  recordTransfer: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  createWaterQuality: [['tanks'], ['equipment-params'], ['waterQuality'], ['dailyOpsCounts'], ['ai']],
  recordStockMovement: [['stockEventsSummary'], ['stock-at-location'], ['warehouseSummary']],
  transferStock: [['stockEventsSummary'], ['stock-at-location'], ['warehouseSummary']],
  createLeaveRequest: [['leaveRequests'], ['leaveBalances']],
  completeTask: [['myTasks'], ['taskStats'], ['dailyOpsCounts']],
  startTask: [['myTasks'], ['taskStats'], ['dailyOpsCounts']],
  sendMessage: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
  editMessage: [['messaging', 'channels'], ['messaging', 'messages']],
  deleteMessage: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
  markMessagesRead: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
};

export function getSyncedOperationInvalidationKeys(
  tenantId: string,
  operationTypes: readonly OperationType[],
): readonly (readonly unknown[])[] {
  const uniqueSegments = new Map<string, readonly unknown[]>();

  for (const operationType of operationTypes) {
    for (const segments of SYNC_INVALIDATION_SEGMENTS[operationType] ?? []) {
      uniqueSegments.set(JSON.stringify(segments), segments);
    }
  }

  return Array.from(uniqueSegments.values()).map((segments) =>
    createTenantQueryKey(tenantId, ...segments),
  );
}

export async function invalidateSyncedOperationQueries(
  queryClient: QueryClient,
  tenantId: string,
  operationTypes: readonly OperationType[],
): Promise<void> {
  // WHY 2026-04-29: online and offline mutation paths must converge through one
  // awaited invalidation map. Fire-and-forget invalidation left committed DB
  // changes invisible until staleTime/cache TTL elapsed on mobile screens.
  await Promise.all(
    getSyncedOperationInvalidationKeys(tenantId, operationTypes).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}
