import type { QueryClient } from '@tanstack/react-query';
import { FEEDING_MEAL_MOBILE_COMMAND_V1 } from '@aquaculture/feeding-contracts/feeding-record-vocabulary';

import { createTenantQueryKey } from './tenant-query-keys';

import type { OperationPayload, OperationType } from '@/types';

/**
 * MOB-LOW-011 — optimistic KPI bumps for queued farm writes.
 *
 * The offline queue is the single mobile write path, but its convergence
 * (post-sync invalidation) needs a server round-trip — offline, a just-
 * recorded mortality left the Daily Ops KPI cards stale for the whole shift.
 * This applies the minimal, additive flip to the tenant-scoped aggregate
 * caches at ENQUEUE time; server truth reconciles on the next successful
 * sync's invalidation. Only counters we can bump additively are touched —
 * nothing is fabricated for cold caches (updaters run only on existing data).
 */

interface DailyOpsCountsSlice {
  mortalityCount: number;
  wqReadingsCount: number;
  feedingCompletedCount: number;
  feedingTotalCount: number;
}

interface StockEventsSummarySlice {
  thisWeekEventsCount: number;
}

type DailyOpsCounterKey = Exclude<keyof DailyOpsCountsSlice, 'feedingTotalCount'>;

/** Queued op type → which daily-ops counter it increments. */
const DAILY_OPS_BUMPS: Partial<Record<OperationType, DailyOpsCounterKey>> = {
  recordMortality: 'mortalityCount',
  createWaterQuality: 'wqReadingsCount',
};

/** Queued op types that count as a stock event this week. */
const STOCK_EVENT_TYPES: readonly OperationType[] = [
  'recordCull',
  'createHarvestRecord',
  'recordTransfer',
];

/**
 * Faz 6 öğün cutover'ı: bir döküm yalnız `finalize=true` ile öğünü bitirir
 * (fed) — finalize'sız döküm partially_fed bırakır ve "tamamlandı" sayacını
 * ŞİŞİRMEMELİDİR. Bu yüzden recordMealFeeding bump'ı sabit haritada değil,
 * payload'ın finalize bayrağına bakan bu kapıdan geçer.
 */
function dailyOpsCounterFor(
  type: OperationType,
  payload?: OperationPayload,
): DailyOpsCounterKey | undefined {
  if (type === FEEDING_MEAL_MOBILE_COMMAND_V1.operationType) {
    return payload && 'finalize' in payload && payload.finalize === true
      ? 'feedingCompletedCount'
      : undefined;
  }
  if (type === 'finalizeMeal') return 'feedingCompletedCount';
  return DAILY_OPS_BUMPS[type];
}

export function applyOptimisticKpiBump(
  queryClient: QueryClient,
  tenantId: string,
  type: OperationType,
  payload?: OperationPayload,
): void {
  const dailyOpsCounter = dailyOpsCounterFor(type, payload);
  if (dailyOpsCounter) {
    queryClient.setQueriesData<DailyOpsCountsSlice>(
      { queryKey: createTenantQueryKey(tenantId, 'dailyOpsCounts') },
      (existing) =>
        existing ? { ...existing, [dailyOpsCounter]: existing[dailyOpsCounter] + 1 } : existing,
    );
  }

  if (STOCK_EVENT_TYPES.includes(type)) {
    queryClient.setQueriesData<StockEventsSummarySlice>(
      { queryKey: createTenantQueryKey(tenantId, 'stockEventsSummary') },
      (existing) =>
        existing
          ? { ...existing, thisWeekEventsCount: existing.thisWeekEventsCount + 1 }
          : existing,
    );
  }
}
