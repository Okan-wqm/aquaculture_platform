import {
  FARM_AI_QUERY_SUBJECTS,
  isBatchPerformanceRequest,
  isBiomassReportRequest,
  isBoundedListRequest,
  isCriticalWaterQualityRequest,
  isDailyFeedingPlanRequest,
  isEquipmentListRequest,
  isFarmStockInventoryRequest,
  isFeederCalibrationsRequest,
  isFeedingProtocolsRequest,
  isFeedingSummaryRequest,
  isFinanceBatchTotalsRequest,
  isFinanceSummaryRequest,
  isFishHealthStatsRequest,
  isGrowthMeasurementsRequest,
  isHarvestEligibilityRequest,
  isHarvestPlanStatsRequest,
  isHarvestPlansRequest,
  isHealthEventsRequest,
  isLiceCountsRequest,
  isRegulatoryReportsRequest,
  isSiteWindowRequest,
  isSpareStockSummaryRequest,
  isSpeciesListRequest,
  isSystemWaterQualityStatsRequest,
  isTankCapacityRequest,
  isTankWaterQualityStatsRequest,
  isTaskStatsRequest,
  isTreatmentApplicationsRequest,
  isWaterQualityHistoryRequest,
  isWaterQualityThresholdsRequest,
  isWelfareAssessmentsRequest,
  isWorkOrderStatsRequest,
  type FarmAiQuerySubject,
} from '@platform/event-contracts';

import type { OwnedIds } from './farm-two-tenant.harness';

/** One farm AI subject as the red-team attacks it. */
export interface SubjectCase {
  /** The subject's own request guard (the responder's `isRequest`). */
  readonly guard: (value: unknown) => boolean;
  /**
   * The request (without tenantId) naming EVERY id the subject accepts — each
   * filled with the victim's real ids. Empty of ids when the subject takes none.
   */
  readonly request: (ids: OwnedIds) => Record<string, unknown>;
}

const WINDOW = { fromDate: '2026-01-01', toDate: '2026-03-01' };

/**
 * Every farm AI subject (V-T1a-6, V-T1b-1). A `Record` over FarmAiQuerySubject,
 * so a subject added to the contract without an entry here does not compile.
 *
 * Each request names every id field its guard accepts — optional ones too — so
 * the attack exercises the owner check of every field. The red-team spec also
 * proves the list complete: adding any other owned id field to a request must
 * make the subject's guard refuse it.
 */
export const FARM_AI_SUBJECT_CASES: Readonly<Record<FarmAiQuerySubject, SubjectCase>> = {
  [FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS]: {
    guard: isTankWaterQualityStatsRequest,
    request: (ids) => ({ tankId: ids.tankId, days: 7 }),
  },
  [FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS]: {
    guard: isSystemWaterQualityStatsRequest,
    request: (ids) => ({ systemId: ids.systemId, days: 7 }),
  },
  [FARM_AI_QUERY_SUBJECTS.WQ_HISTORY]: {
    guard: isWaterQualityHistoryRequest,
    request: (ids) => ({
      tankId: ids.tankId,
      fromDate: '2026-01-01',
      toDate: '2026-02-15',
      limit: 5,
    }),
  },
  [FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL]: {
    guard: isCriticalWaterQualityRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS]: {
    guard: isWaterQualityThresholdsRequest,
    request: () => ({}),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_STATS]: { guard: isFishHealthStatsRequest, request: () => ({}) },
  [FARM_AI_QUERY_SUBJECTS.FH_EVENTS]: {
    guard: isHealthEventsRequest,
    request: (ids) => ({ batchId: ids.batchId, tankId: ids.tankId, activeOnly: false, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_CRITICAL]: {
    guard: isBoundedListRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS]: {
    guard: isBoundedListRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS]: {
    guard: isLiceCountsRequest,
    request: (ids) => ({ siteId: ids.siteId, tankId: ids.tankId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS]: {
    guard: isTreatmentApplicationsRequest,
    request: (ids) => ({ siteId: ids.siteId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_WELFARE]: {
    guard: isWelfareAssessmentsRequest,
    request: (ids) => ({ siteId: ids.siteId, tankId: ids.tankId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY]: {
    guard: isHarvestEligibilityRequest,
    request: (ids) => ({ batchId: ids.batchId, harvestDate: '2026-10-01' }),
  },
  [FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE]: {
    guard: isBatchPerformanceRequest,
    request: (ids) => ({ batchId: ids.batchId }),
  },
  [FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE]: {
    guard: isSiteWindowRequest,
    request: (ids) => ({ siteId: ids.siteId, ...WINDOW }),
  },
  [FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY]: {
    guard: isSiteWindowRequest,
    request: (ids) => ({ siteId: ids.siteId, ...WINDOW }),
  },
  [FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS]: {
    guard: isBatchPerformanceRequest,
    request: (ids) => ({ batchId: ids.batchId }),
  },
  [FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS]: {
    guard: isGrowthMeasurementsRequest,
    request: (ids) => ({ batchId: ids.batchId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.SPECIES_LIST]: { guard: isSpeciesListRequest, request: () => ({}) },
  [FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY]: {
    guard: isTankCapacityRequest,
    request: (ids) => ({ tankId: ids.tankId }),
  },
  [FARM_AI_QUERY_SUBJECTS.FEEDING_DAILY_PLAN]: {
    guard: isDailyFeedingPlanRequest,
    request: (ids) => ({ siteId: ids.siteId, date: '2026-02-01', departmentId: ids.departmentId }),
  },
  [FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY]: {
    guard: isFeedingSummaryRequest,
    request: (ids) => ({ entityType: 'batch', entityId: ids.batchId, ...WINDOW }),
  },
  [FARM_AI_QUERY_SUBJECTS.FEEDING_SITE_CONSUMPTION]: {
    guard: isSiteWindowRequest,
    request: (ids) => ({ siteId: ids.siteId, ...WINDOW }),
  },
  [FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS]: {
    guard: isFeedingProtocolsRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.HARVEST_PLANS]: {
    guard: isHarvestPlansRequest,
    request: () => ({ scope: 'upcoming', days: 30, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS]: {
    guard: isHarvestPlanStatsRequest,
    request: () => ({}),
  },
  [FARM_AI_QUERY_SUBJECTS.REG_BIOMASS_REPORT]: {
    guard: isBiomassReportRequest,
    request: (ids) => ({ siteId: ids.siteId, reportMonth: 1, reportYear: 2026 }),
  },
  [FARM_AI_QUERY_SUBJECTS.REG_REPORTS]: {
    guard: isRegulatoryReportsRequest,
    request: (ids) => ({ reportType: 'SEA_LICE', siteId: ids.siteId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY]: {
    guard: isFinanceSummaryRequest,
    request: () => ({ ...WINDOW, granularity: 'MONTH' }),
  },
  [FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS]: {
    guard: isFinanceBatchTotalsRequest,
    request: () => ({ ...WINDOW, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.EQUIPMENT_LIST]: {
    guard: isEquipmentListRequest,
    request: (ids) => ({ equipmentTypeId: ids.equipmentTypeId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS]: {
    guard: isFeederCalibrationsRequest,
    request: (ids) => ({ equipmentId: ids.equipmentId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.MAINT_OVERDUE_WORK_ORDERS]: {
    guard: isBoundedListRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS]: {
    guard: isWorkOrderStatsRequest,
    request: () => ({ ...WINDOW }),
  },
  [FARM_AI_QUERY_SUBJECTS.MAINT_SCHEDULE_ALERTS]: {
    guard: isBoundedListRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.MAINT_LOW_STOCK]: {
    guard: isBoundedListRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.MAINT_STOCK_SUMMARY]: {
    guard: isSpareStockSummaryRequest,
    request: () => ({}),
  },
  [FARM_AI_QUERY_SUBJECTS.FARM_STOCK_INVENTORY]: {
    guard: isFarmStockInventoryRequest,
    request: (ids) => ({ siteId: ids.siteId, limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.TASKS_TODAY]: {
    guard: isBoundedListRequest,
    request: () => ({ limit: 5 }),
  },
  [FARM_AI_QUERY_SUBJECTS.TASK_STATS]: { guard: isTaskStatsRequest, request: () => ({}) },
};

/** The id fields of a request (every `*Id` key but the tenant's). */
export function idFieldsOf(request: Record<string, unknown>): string[] {
  return Object.keys(request).filter((key) => /Id$/.test(key) && key !== 'tenantId');
}
