import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import { messagingQueryKeys } from '@/utils/messaging-query-keys';
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
};

const MESSAGING_INVALIDATION_KEYS: Partial<
  Record<OperationType, (tenantId: string) => readonly (readonly unknown[])[]>
> = {
  sendMessage: (tenantId) => [
    messagingQueryKeys.channels(tenantId),
    messagingQueryKeys.allMessages(tenantId),
    messagingQueryKeys.unreadCount(tenantId),
  ],
  editMessage: (tenantId) => [
    messagingQueryKeys.channels(tenantId),
    messagingQueryKeys.allMessages(tenantId),
  ],
  deleteMessage: (tenantId) => [
    messagingQueryKeys.channels(tenantId),
    messagingQueryKeys.allMessages(tenantId),
    messagingQueryKeys.unreadCount(tenantId),
  ],
  markMessagesRead: (tenantId) => [
    messagingQueryKeys.channels(tenantId),
    messagingQueryKeys.allMessages(tenantId),
    messagingQueryKeys.unreadCount(tenantId),
  ],
};

export function getSyncedOperationInvalidationKeys(
  tenantId: string,
  operationTypes: readonly OperationType[],
): readonly (readonly unknown[])[] {
  const uniqueKeys = new Map<string, readonly unknown[]>();
  const addKey = (queryKey: readonly unknown[]) => {
    uniqueKeys.set(JSON.stringify(queryKey), queryKey);
  };

  for (const operationType of operationTypes) {
    for (const segments of SYNC_INVALIDATION_SEGMENTS[operationType] ?? []) {
      addKey(createTenantQueryKey(tenantId, ...segments));
    }
    for (const queryKey of MESSAGING_INVALIDATION_KEYS[operationType]?.(tenantId) ?? []) {
      addKey(queryKey);
    }
  }

  return Array.from(uniqueKeys.values());
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
