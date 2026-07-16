// farm-realtime-invalidation — maps a live farm domain event (broadcast on the
// gateway `/farms` Socket.IO namespace) to the React Query keys it invalidates.
//
// WHY: the backbone already delivers farm events to every connected client of a
// tenant (command → outbox → NATS → FarmGateway → room `tenant:{id}`), but no
// frontend listened, so a mortality/feeding recorded on one device (or the web
// tenant panel) left this app's tank counts stale until a poll/refetch. This
// map is the cross-surface analogue of `offline-sync-invalidation.ts`: a change
// anywhere invalidates the same read models here, so all surfaces converge.
//
// The map is keyed by the FarmGateway event name (camelCase, see
// apps/gateway-api/src/websocket/farm.gateway.ts `emitFarmEvent`). Events with
// no aquamobil-visible read model (site/department/system/supplier management —
// not part of the field-worker app) are intentionally absent → no-op.
import type { QueryClient } from '@tanstack/react-query';

import { createTenantQueryKey } from './tenant-query-keys';

export type FarmRealtimeEvent =
  | 'mortalityRecorded'
  | 'cullRecorded'
  | 'batchAllocatedToTank'
  | 'batchTransferred'
  | 'batchHarvested'
  | 'batchCreated'
  | 'batchClosed'
  | 'batchStatusChanged'
  | 'batchProductionCompleted'
  | 'feedingRecorded'
  | 'feedInventoryLow'
  | 'lowStockDetected'
  | 'feederCalibrationsSaved'
  | 'tankCreated'
  | 'tankUpdated'
  | 'tankDeleted'
  | 'tankStatusChanged'
  | 'tankCleared'
  | 'equipmentCreated'
  | 'equipmentUpdated'
  | 'equipmentDeleted'
  | 'subEquipmentCreated'
  | 'subEquipmentUpdated'
  | 'subEquipmentDeleted';

// Each event → the query-key SEGMENTS (tenant prefix added at invalidation time
// via createTenantQueryKey, so the no-bare-tenant-query-key rule stays provable).
export const FARM_REALTIME_INVALIDATION_SEGMENTS: Record<
  FarmRealtimeEvent,
  readonly (readonly unknown[])[]
> = {
  // Count-affecting events — the 719-vs-900 class: keep tank counts + ops live.
  mortalityRecorded: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary']],
  cullRecorded: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary']],
  batchAllocatedToTank: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary']],
  batchTransferred: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary']],
  batchHarvested: [['tanks'], ['dailyOpsCounts'], ['stockEventsSummary']],
  batchCreated: [['tanks'], ['dailyOpsCounts']],
  batchClosed: [['tanks'], ['dailyOpsCounts']],
  batchStatusChanged: [['tanks']],
  batchProductionCompleted: [['tanks']],
  // Feeding.
  feedingRecorded: [['tanks'], ['feedingPlan'], ['dailyOpsCounts'], ['stockEventsSummary']],
  feedInventoryLow: [['stockEventsSummary'], ['feedingPlan']],
  // Storage-ledger low-stock sink (successor of feedInventoryLow).
  lowStockDetected: [['warehouseSummary'], ['stockEventsSummary'], ['feedingPlan']],
  feederCalibrationsSaved: [['feedingPlan']],
  // Tank structure/state.
  tankCreated: [['tanks']],
  tankUpdated: [['tanks']],
  tankDeleted: [['tanks']],
  tankStatusChanged: [['tanks']],
  tankCleared: [['tanks'], ['dailyOpsCounts']],
  // Equipment (tank cards surface equipment params).
  equipmentCreated: [['tanks'], ['equipment-params']],
  equipmentUpdated: [['tanks'], ['equipment-params']],
  equipmentDeleted: [['tanks'], ['equipment-params']],
  subEquipmentCreated: [['tanks']],
  subEquipmentUpdated: [['tanks']],
  subEquipmentDeleted: [['tanks']],
};

export function isFarmRealtimeEvent(name: string): name is FarmRealtimeEvent {
  return Object.prototype.hasOwnProperty.call(FARM_REALTIME_INVALIDATION_SEGMENTS, name);
}

// The union of every segment — used on RECONNECT to catch events missed while
// the socket was down (mirrors the messaging M3 reconnect reconciliation).
export const FARM_REALTIME_ALL_SEGMENTS: readonly (readonly unknown[])[] = (() => {
  const unique = new Map<string, readonly unknown[]>();
  for (const segments of Object.values(FARM_REALTIME_INVALIDATION_SEGMENTS)) {
    for (const segment of segments) {
      unique.set(JSON.stringify(segment), segment);
    }
  }
  return Array.from(unique.values());
})();

export async function invalidateFarmEventQueries(
  queryClient: QueryClient,
  tenantId: string,
  eventName: string,
): Promise<void> {
  if (!isFarmRealtimeEvent(eventName)) return;
  await Promise.all(
    FARM_REALTIME_INVALIDATION_SEGMENTS[eventName].map((segments) =>
      queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, ...segments) }),
    ),
  );
}

export async function invalidateAllFarmQueries(
  queryClient: QueryClient,
  tenantId: string,
): Promise<void> {
  await Promise.all(
    FARM_REALTIME_ALL_SEGMENTS.map((segments) =>
      queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, ...segments) }),
    ),
  );
}
