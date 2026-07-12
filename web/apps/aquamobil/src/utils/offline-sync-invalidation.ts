import type { QueryClient } from '@tanstack/react-query';

import type { OperationType } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

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
  // FARM-HIGH-214: synced field-capture records feed the scheduled report
  // drafts — invalidate the mobile reports-due read models so a subsequent
  // draft refresh/review reflects the new source rows.
  recordLiceCount: [['reportDrafts'], ['reportDeadlines']],
  recordWelfareAssessment: [['reportDrafts'], ['reportDeadlines']],
  recordEscapeIncident: [['reportDrafts'], ['reportDeadlines']],
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

// WHY: dedup is performed on the raw segments (BEFORE the tenant prefix is
// applied) so the two public functions share ONE source of truth for which
// read models a set of synced operations touches. The tenant prefix is then
// applied at each call site via createTenantQueryKey, keeping the
// no-bare-tenant-query-key invariant statically verifiable everywhere.
function getSyncedOperationSegments(
  operationTypes: readonly OperationType[],
): readonly (readonly unknown[])[] {
  const uniqueSegments = new Map<string, readonly unknown[]>();

  for (const operationType of operationTypes) {
    for (const segments of SYNC_INVALIDATION_SEGMENTS[operationType] ?? []) {
      uniqueSegments.set(JSON.stringify(segments), segments);
    }
  }

  return Array.from(uniqueSegments.values());
}

export function getSyncedOperationInvalidationKeys(
  tenantId: string,
  operationTypes: readonly OperationType[],
): readonly (readonly unknown[])[] {
  return getSyncedOperationSegments(operationTypes).map((segments) =>
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
  // The queryKey is built inline via createTenantQueryKey so the
  // no-bare-tenant-query-key rule can statically prove tenant-prefix discipline.
  await Promise.all(
    getSyncedOperationSegments(operationTypes).map((segments) =>
      queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, ...segments) }),
    ),
  );
}
