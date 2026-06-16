import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import type { OperationType } from '@/types';
import type { QueryClient } from '@tanstack/react-query';

// WHY: offline sync is the only write path when field users reconnect. Mapping
// each synced mutation to tenant-scoped read models prevents DB-committed farm
// changes from remaining invisible in cached mobile list/card/detail screens.
// `satisfies Record<OperationType, ...>` (NOT Partial) makes this map EXHAUSTIVE:
// adding a queueable OperationType without a sync-invalidation entry is now a
// compile-time error (tier-1 make-it-impossible), so an offline write can never
// again silently leave its read model stale. FE-HIGH-052: clockIn/clockOut were
// the missing entries that left the Daily Ops "clocked-in" KPI (and the
// attendance screens) stale after offline attendance sync.
const SYNC_INVALIDATION_SEGMENTS = {
  recordMortality: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  recordCull: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  createHarvestRecord: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  recordFeeding: [['tanks'], ['feedingPlan'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  recordTransfer: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary'], ['ai']],
  createWaterQuality: [['tanks'], ['equipment-params'], ['waterQuality'], ['dailyOpsCounts'], ['ai']],
  recordStockMovement: [['stockEventsSummary'], ['stock-at-location'], ['warehouseSummary']],
  transferStock: [['stockEventsSummary'], ['stock-at-location'], ['warehouseSummary']],
  clockIn: [['dailyOpsCounts'], ['todaysAttendance'], ['attendanceRecords'], ['attendanceSummary']],
  clockOut: [['dailyOpsCounts'], ['todaysAttendance'], ['attendanceRecords'], ['attendanceSummary']],
  createLeaveRequest: [['leaveRequests'], ['leaveBalances']],
  completeTask: [['myTasks'], ['taskStats'], ['dailyOpsCounts']],
  startTask: [['myTasks'], ['taskStats'], ['dailyOpsCounts']],
  // FARM-HIGH-057: a checklist SET changes the task's checklist state shown in
  // the task detail/list read models — invalidate them so a synced offline
  // toggle becomes visible without waiting for staleTime.
  setChecklistItem: [['myTasks'], ['task']],
  sendMessage: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
  // MSG-MEDIUM-055: the binary offline lane produces a sent message on replay,
  // so it invalidates the SAME messaging read models as a plain sendMessage.
  uploadAndSendMessage: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
  editMessage: [['messaging', 'channels'], ['messaging', 'messages']],
  deleteMessage: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
  markMessagesRead: [['messaging', 'channels'], ['messaging', 'messages'], ['messaging', 'unreadCount']],
} satisfies Record<OperationType, readonly (readonly unknown[])[]>;

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
