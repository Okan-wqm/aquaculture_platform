import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isAiQueryList,
  isAiQueryReply,
  isBoundedInt,
  isBatchHarvestEligibilityRequest,
  isCriticalHealthEventsRequest,
  isCriticalWaterQualityRequest,
  isFishHealthStatsRequest,
  isHealthEventsRequest,
  isIsoDateString,
  isLiceCountsRequest,
  isOverdueFollowUpsRequest,
  isSystemWqStatsRequest,
  isTankWqStatsRequest,
  isTreatmentApplicationsRequest,
  isUuidString,
  isWaterQualityHistoryRequest,
  isWelfareAssessmentsRequest,
  isWqThresholdsRequest,
  // PR-4 Production guards
  isBatchPerformanceRequest,
  isGrowthAnalysisRequest,
  isGrowthMeasurementsRequest,
  isMortalityByCauseRequest,
  isTransfersSummaryRequest,
  isDailyFeedingPlanRequest,
  isFeedingSummaryRequest,
  isSiteFeedConsumptionRequest,
  isFeedProtocolsRequest,
  isSpeciesListRequest,
  isTankCapacityRequest,
  isHarvestPlansRequest,
  isHarvestPlanStatsRequest,
  isBiomassReportRequest,
  isRegulatoryReportsRequest,
  isFinanceSummaryRequest,
  isFinanceBatchTotalsRequest,
  // PR-5 Operations guards
  isEquipmentListRequest,
  isFeederCalibrationsRequest,
  isOverdueWorkOrdersRequest,
  isWorkOrderStatsRequest,
  isMaintenanceScheduleAlertsRequest,
  isLowStockPartsRequest,
  isStockSummaryRequest,
  isFarmStockInventoryRequest,
  isTodaysTasksRequest,
  isTaskStatsRequest,
} from '../farm-ai-queries';

const TENANT = '33333333-3333-4333-8333-333333333333';
const TANK = '11111111-1111-4111-8111-111111111111';

describe('FARM_AI_QUERY_SUBJECTS', () => {
  const entries = Object.entries(FARM_AI_QUERY_SUBJECTS);

  it('declares exactly the 40 planned subjects (13 PR-3 + 27 PR-4/5)', () => {
    expect(entries).toHaveLength(40);
  });

  it('every subject lives in the request.farm.ai. namespace', () => {
    for (const [key, subject] of entries) {
      expect({ key, subject }).toEqual({
        key,
        subject: expect.stringMatching(/^request\.farm\.ai\.[a-z][A-Za-z]+$/),
      });
    }
  });

  it('subject VALUES are unique (two keys can never alias one responder)', () => {
    const values = entries.map(([, subject]) => subject);
    expect(new Set(values).size).toBe(values.length);
  });

  it('subject KEYS are unique (object literal cannot silently overwrite)', () => {
    const keys = entries.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pins the 13 PR-3 Water & Health subjects to their exact wire names', () => {
    expect(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS).toBe(
      'request.farm.ai.getTankWaterQualityStats',
    );
    expect(FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS).toBe(
      'request.farm.ai.getSystemWaterQualityStats',
    );
    expect(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY).toBe(
      'request.farm.ai.getWaterQualityHistory',
    );
    expect(FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL).toBe(
      'request.farm.ai.listCriticalWaterQuality',
    );
    expect(FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS).toBe(
      'request.farm.ai.getWaterQualityThresholds',
    );
    expect(FARM_AI_QUERY_SUBJECTS.FH_STATS).toBe('request.farm.ai.getFishHealthStats');
    expect(FARM_AI_QUERY_SUBJECTS.FH_EVENTS).toBe('request.farm.ai.listHealthEvents');
    expect(FARM_AI_QUERY_SUBJECTS.FH_CRITICAL).toBe(
      'request.farm.ai.listCriticalHealthEvents',
    );
    expect(FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS).toBe(
      'request.farm.ai.listOverdueHealthFollowUps',
    );
    expect(FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS).toBe('request.farm.ai.listLiceCounts');
    expect(FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS).toBe(
      'request.farm.ai.listTreatmentApplications',
    );
    expect(FARM_AI_QUERY_SUBJECTS.FH_WELFARE).toBe(
      'request.farm.ai.listWelfareAssessments',
    );
    expect(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY).toBe(
      'request.farm.ai.checkBatchHarvestEligibility',
    );
  });

  it('fixes the shared query bounds', () => {
    expect(FARM_AI_QUERY_LIMITS).toEqual({
      DEFAULT_LIST_LIMIT: 20,
      MAX_LIST_LIMIT: 50,
      MAX_STAT_DAYS: 90,
      MAX_RANGE_DAYS: 366,
      MAX_UPCOMING_DAYS: 180,
    });
  });
});

describe('farm-ai-query primitive guards', () => {
  it('isUuidString accepts UUIDs and rejects near-misses', () => {
    expect(isUuidString(TENANT)).toBe(true);
    expect(isUuidString('tenant_x')).toBe(false);
    expect(isUuidString('')).toBe(false);
    expect(isUuidString(42)).toBe(false);
    expect(isUuidString(null)).toBe(false);
  });

  it('isIsoDateString accepts ISO dates/datetimes and rejects junk', () => {
    expect(isIsoDateString('2026-09-18')).toBe(true);
    expect(isIsoDateString('2026-09-18T08:00:00.000Z')).toBe(true);
    expect(isIsoDateString('18/09/2026')).toBe(false);
    expect(isIsoDateString('not-a-date')).toBe(false);
    expect(isIsoDateString(new Date())).toBe(false);
    expect(isIsoDateString(undefined)).toBe(false);
  });

  it('isBoundedInt enforces integer bounds', () => {
    const oneToNinety = isBoundedInt(1, 90);
    expect(oneToNinety(1)).toBe(true);
    expect(oneToNinety(90)).toBe(true);
    expect(oneToNinety(0)).toBe(false);
    expect(oneToNinety(91)).toBe(false);
    expect(oneToNinety(7.5)).toBe(false);
    expect(oneToNinety('7')).toBe(false);
    expect(oneToNinety(NaN)).toBe(false);
  });
});

describe('farm-ai-query reply guards', () => {
  it('isAiQueryReply accepts both envelope arms', () => {
    expect(isAiQueryReply({ ok: true, data: { items: [] } })).toBe(true);
    expect(isAiQueryReply({ ok: false, error: 'INVALID_REQUEST' })).toBe(true);
    expect(isAiQueryReply({ ok: false, error: 'INTERNAL_ERROR' })).toBe(true);
  });

  it('isAiQueryReply rejects {ok:true} without data, bare values, and bad errors', () => {
    expect(isAiQueryReply({ ok: true })).toBe(false);
    expect(isAiQueryReply({ ok: false })).toBe(false);
    expect(isAiQueryReply({ ok: false, error: 'MAYBE' })).toBe(false);
    expect(isAiQueryReply({ ok: 'true', data: {} })).toBe(false);
    expect(isAiQueryReply(null)).toBe(false);
    expect(isAiQueryReply([1, 2, 3])).toBe(false);
  });

  it('isAiQueryList rejects a bare array where a list reply is expected', () => {
    expect(isAiQueryList([{ id: 'a' }])).toBe(false);
    expect(isAiQueryList('items')).toBe(false);
    expect(isAiQueryList({ items: [] })).toBe(false); // missing truncated
    expect(isAiQueryList({ items: [], truncated: 'no' })).toBe(false);
    expect(isAiQueryList({ items: [], truncated: false, total: 'x' })).toBe(false);
    expect(isAiQueryList({ items: [], truncated: false })).toBe(true);
    expect(isAiQueryList({ items: [{ id: 'a' }], truncated: true, total: 51 })).toBe(true);
  });
});

describe('farm-ai-query PR-3 request guards', () => {
  it('tank stats guard: accepts valid, rejects bad uuid / out-of-range days / non-object', () => {
    expect(isTankWqStatsRequest({ tenantId: TENANT, tankId: TANK, days: 30 })).toBe(true);
    expect(isTankWqStatsRequest({ tenantId: TENANT, tankId: TANK })).toBe(true);
    expect(isTankWqStatsRequest({ tenantId: TENANT, tankId: 'tank-1' })).toBe(false);
    expect(isTankWqStatsRequest({ tenantId: TENANT, tankId: TANK, days: 0 })).toBe(false);
    expect(isTankWqStatsRequest({ tenantId: TENANT, tankId: TANK, days: 91 })).toBe(false);
    expect(isTankWqStatsRequest({ tenantId: TENANT, tankId: TANK, days: '7' })).toBe(false);
    expect(isTankWqStatsRequest([TENANT, TANK])).toBe(false);
    expect(isTankWqStatsRequest(null)).toBe(false);
  });

  it('system stats guard mirrors the tank guard on systemId', () => {
    expect(isSystemWqStatsRequest({ tenantId: TENANT, systemId: TANK, days: 7 })).toBe(true);
    expect(isSystemWqStatsRequest({ tenantId: 'nope', systemId: TANK })).toBe(false);
    expect(isSystemWqStatsRequest({ tenantId: TENANT, systemId: TANK, days: 999 })).toBe(false);
  });

  it('history guard requires both ISO dates with a window ≤ 90 days', () => {
    expect(
      isWaterQualityHistoryRequest({ tenantId: TENANT, tankId: TANK }),
    ).toBe(false);
    const ok = {
      tenantId: TENANT,
      tankId: TANK,
      fromDate: '2026-06-01',
      toDate: '2026-06-30',
    };
    expect(isWaterQualityHistoryRequest(ok)).toBe(true);
    expect(
      isWaterQualityHistoryRequest({
        ...ok,
        fromDate: '2026-01-01',
        toDate: '2026-06-30',
      }),
    ).toBe(false); // > 90 days
    expect(isWaterQualityHistoryRequest({ ...ok, toDate: '2026-05-01' })).toBe(
      false,
    ); // to before from
    expect(
      isWaterQualityHistoryRequest({ ...ok, fromDate: '01-06-2026' }),
    ).toBe(false);
    expect(isWaterQualityHistoryRequest({ ...ok, limit: 51 })).toBe(false);
  });

  it('list-subject guards accept {tenantId, limit?} and reject bad limits', () => {
    expect(isCriticalWaterQualityRequest({ tenantId: TENANT })).toBe(true);
    expect(isCriticalWaterQualityRequest({ tenantId: TENANT, limit: 50 })).toBe(true);
    expect(isCriticalWaterQualityRequest({ tenantId: TENANT, limit: 0 })).toBe(false);
    expect(isCriticalWaterQualityRequest({ tenantId: TENANT, limit: 51 })).toBe(false);
    expect(isCriticalWaterQualityRequest([TENANT])).toBe(false);
    expect(isCriticalHealthEventsRequest({ tenantId: TENANT, limit: 20 })).toBe(true);
    expect(isCriticalHealthEventsRequest({ tenantId: 'bad' })).toBe(false);
    expect(isOverdueFollowUpsRequest({ tenantId: TENANT, limit: 20 })).toBe(true);
    expect(isOverdueFollowUpsRequest({ tenantId: TENANT, limit: 1.5 })).toBe(false);
    expect(isFishHealthStatsRequest({ tenantId: TENANT })).toBe(true);
    expect(isFishHealthStatsRequest({})).toBe(false);
  });

  it('thresholds guard accepts optional speciesId uuid', () => {
    expect(isWqThresholdsRequest({ tenantId: TENANT })).toBe(true);
    expect(isWqThresholdsRequest({ tenantId: TENANT, speciesId: TANK })).toBe(true);
    expect(isWqThresholdsRequest({ tenantId: TENANT, speciesId: 'salmon' })).toBe(false);
  });

  it('health events guard validates optional filters and severity vocabulary', () => {
    expect(isHealthEventsRequest({ tenantId: TENANT })).toBe(true);
    expect(
      isHealthEventsRequest({ tenantId: TENANT, severity: 'critical', limit: 10 }),
    ).toBe(true);
    expect(isHealthEventsRequest({ tenantId: TENANT, severity: 'catastrophic' })).toBe(false);
    expect(isHealthEventsRequest({ tenantId: TENANT, batchId: 'b1' })).toBe(false);
    expect(isHealthEventsRequest({ tenantId: TENANT, tankId: TANK })).toBe(true);
    expect(isHealthEventsRequest({ tenantId: TENANT, activeOnly: 'yes' })).toBe(false);
    expect(isHealthEventsRequest({ tenantId: TENANT, activeOnly: false })).toBe(true);
  });

  it('lice counts guard bounds reporting year/week', () => {
    expect(
      isLiceCountsRequest({ tenantId: TENANT, siteId: TANK, reportingWeek: 42 }),
    ).toBe(true);
    expect(isLiceCountsRequest({ tenantId: TENANT, reportingYear: 1999 })).toBe(false);
    expect(isLiceCountsRequest({ tenantId: TENANT, reportingYear: 2026 })).toBe(true);
    expect(isLiceCountsRequest({ tenantId: TENANT, reportingWeek: 54 })).toBe(false);
    expect(isLiceCountsRequest({ tenantId: TENANT, reportingWeek: 0 })).toBe(false);
    expect(isLiceCountsRequest({ tenantId: TENANT, tankId: TANK, limit: 50 })).toBe(true);
  });

  it('treatment/welfare guards cap the date window at 366 days', () => {
    expect(
      isTreatmentApplicationsRequest({
        tenantId: TENANT,
        siteId: TANK,
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
      }),
    ).toBe(true);
    expect(
      isTreatmentApplicationsRequest({
        tenantId: TENANT,
        fromDate: '2025-01-01',
        toDate: '2026-12-31',
      }),
    ).toBe(false);
    expect(
      isTreatmentApplicationsRequest({ tenantId: TENANT, fromDate: '2026-01-01' }),
    ).toBe(false); // one-sided window is not a valid range
    expect(
      isWelfareAssessmentsRequest({
        tenantId: TENANT,
        siteId: TANK,
        tankId: TANK,
        fromDate: '2026-01-01',
        toDate: '2026-01-31',
        limit: 20,
      }),
    ).toBe(true);
    expect(
      isWelfareAssessmentsRequest({ tenantId: TENANT, tankId: 'pen-3' }),
    ).toBe(false);
  });

  it('harvest eligibility guard requires batchId uuid and ISO harvestDate', () => {
    expect(
      isBatchHarvestEligibilityRequest({
        tenantId: TENANT,
        batchId: TANK,
        harvestDate: '2026-10-01',
      }),
    ).toBe(true);
    expect(
      isBatchHarvestEligibilityRequest({ tenantId: TENANT, batchId: TANK }),
    ).toBe(false);
    expect(
      isBatchHarvestEligibilityRequest({
        tenantId: TENANT,
        batchId: 'batch-7',
        harvestDate: '2026-10-01',
      }),
    ).toBe(false);
    expect(
      isBatchHarvestEligibilityRequest({
        tenantId: TENANT,
        batchId: TANK,
        harvestDate: 'tomorrow',
      }),
    ).toBe(false);
  });
});

describe('farm-ai-query PR-4 request guards (Production specialist)', () => {
  const SITE = '22222222-2222-4222-8222-222222222222';
  const BATCH = '11111111-1111-4111-8111-111111111111';
  const RANGE = { fromDate: '2026-01-01', toDate: '2026-06-30' };

  it('batch performance / growth analysis / tank capacity guards require a uuid target', () => {
    expect(isBatchPerformanceRequest({ tenantId: TENANT, batchId: BATCH })).toBe(true);
    expect(isBatchPerformanceRequest({ tenantId: TENANT, batchId: 'b1' })).toBe(false);
    expect(isBatchPerformanceRequest({ tenantId: TENANT })).toBe(false);
    expect(isGrowthAnalysisRequest({ tenantId: TENANT, batchId: BATCH })).toBe(true);
    expect(isGrowthAnalysisRequest({ tenantId: 'x', batchId: BATCH })).toBe(false);
    expect(isTankCapacityRequest({ tenantId: TENANT, tankId: BATCH })).toBe(true);
    expect(isTankCapacityRequest({ tenantId: TENANT, tankId: 'TNK-1' })).toBe(false);
  });

  it('growth measurements guard bounds the limit', () => {
    expect(isGrowthMeasurementsRequest({ tenantId: TENANT, batchId: BATCH, limit: 50 })).toBe(true);
    expect(isGrowthMeasurementsRequest({ tenantId: TENANT, batchId: BATCH })).toBe(true);
    expect(isGrowthMeasurementsRequest({ tenantId: TENANT, batchId: BATCH, limit: 51 })).toBe(false);
    expect(isGrowthMeasurementsRequest({ tenantId: TENANT })).toBe(false);
  });

  it('mortality/cause + transfers + site consumption guards enforce the ≤366d window', () => {
    expect(isMortalityByCauseRequest({ tenantId: TENANT, siteId: SITE, ...RANGE })).toBe(true);
    expect(
      isMortalityByCauseRequest({
        tenantId: TENANT,
        siteId: SITE,
        fromDate: '2026-01-01',
        toDate: '2027-01-03',
      }),
    ).toBe(false);
    expect(isMortalityByCauseRequest({ tenantId: TENANT, siteId: SITE, fromDate: '2026-01-01' })).toBe(false);
    expect(isTransfersSummaryRequest({ tenantId: TENANT, siteId: SITE, ...RANGE })).toBe(true);
    // (no limit input on this subject — extra keys are ignored, as in PR-3)
    expect(isSiteFeedConsumptionRequest({ tenantId: TENANT, siteId: SITE, ...RANGE })).toBe(true);
    expect(
      isSiteFeedConsumptionRequest({ tenantId: TENANT, siteId: SITE, fromDate: '2026-06-30', toDate: '2026-01-01' }),
    ).toBe(false);
  });

  it('daily feeding plan guard requires ISO date + optional uuid department', () => {
    expect(
      isDailyFeedingPlanRequest({ tenantId: TENANT, siteId: SITE, date: '2026-09-18' }),
    ).toBe(true);
    expect(
      isDailyFeedingPlanRequest({
        tenantId: TENANT,
        siteId: SITE,
        date: '2026-09-18',
        departmentId: SITE,
      }),
    ).toBe(true);
    expect(isDailyFeedingPlanRequest({ tenantId: TENANT, siteId: SITE })).toBe(false);
    expect(isDailyFeedingPlanRequest({ tenantId: TENANT, siteId: SITE, date: 'today' })).toBe(false);
    expect(
      isDailyFeedingPlanRequest({ tenantId: TENANT, siteId: SITE, date: '2026-09-18', departmentId: 'd1' }),
    ).toBe(false);
  });

  it('feeding summary guard pins entityType vocabulary + optional window', () => {
    expect(
      isFeedingSummaryRequest({ tenantId: TENANT, entityType: 'batch', entityId: BATCH }),
    ).toBe(true);
    expect(
      isFeedingSummaryRequest({ tenantId: TENANT, entityType: 'tank', entityId: BATCH, ...RANGE }),
    ).toBe(true);
    expect(
      isFeedingSummaryRequest({ tenantId: TENANT, entityType: 'pond', entityId: BATCH }),
    ).toBe(false);
    expect(isFeedingSummaryRequest({ tenantId: TENANT, entityType: 'batch' })).toBe(false);
    expect(
      isFeedingSummaryRequest({ tenantId: TENANT, entityType: 'batch', entityId: BATCH, fromDate: '2026-01-01' }),
    ).toBe(false); // one-sided window
  });

  it('feed protocols / species list / stats-style guards accept tenant-only payloads', () => {
    expect(isFeedProtocolsRequest({ tenantId: TENANT })).toBe(true);
    expect(isFeedProtocolsRequest({ tenantId: TENANT, limit: 50 })).toBe(true);
    expect(isFeedProtocolsRequest({ tenantId: TENANT, limit: 51 })).toBe(false);
    expect(isSpeciesListRequest({ tenantId: TENANT })).toBe(true);
    expect(isSpeciesListRequest({})).toBe(false);
    expect(isHarvestPlanStatsRequest({ tenantId: TENANT })).toBe(true);
    expect(isHarvestPlanStatsRequest({ tenantId: 'bad' })).toBe(false);
  });

  it('harvest plans guard pins scope vocabulary and days 1..180', () => {
    expect(
      isHarvestPlansRequest({ tenantId: TENANT, scope: 'upcoming', days: 30, limit: 50 }),
    ).toBe(true);
    expect(isHarvestPlansRequest({ tenantId: TENANT, scope: 'overdue', days: 30 })).toBe(true);
    expect(isHarvestPlansRequest({ tenantId: TENANT, scope: 'later', days: 30 })).toBe(false);
    expect(isHarvestPlansRequest({ tenantId: TENANT, scope: 'upcoming' })).toBe(false);
    expect(isHarvestPlansRequest({ tenantId: TENANT, scope: 'upcoming', days: 181 })).toBe(false);
    expect(isHarvestPlansRequest({ tenantId: TENANT, scope: 'upcoming', days: 0 })).toBe(false);
  });

  it('biomass report guard bounds month/year', () => {
    expect(
      isBiomassReportRequest({ tenantId: TENANT, siteId: SITE, reportMonth: 8, reportYear: 2026 }),
    ).toBe(true);
    expect(
      isBiomassReportRequest({ tenantId: TENANT, siteId: SITE, reportMonth: 13, reportYear: 2026 }),
    ).toBe(false);
    expect(
      isBiomassReportRequest({ tenantId: TENANT, siteId: SITE, reportMonth: 0, reportYear: 2026 }),
    ).toBe(false);
    expect(
      isBiomassReportRequest({ tenantId: TENANT, siteId: SITE, reportMonth: 8, reportYear: 1999 }),
    ).toBe(false);
  });

  it('regulatory reports guard pins the report-type vocabulary', () => {
    expect(isRegulatoryReportsRequest({ tenantId: TENANT, reportType: 'SEA_LICE' })).toBe(true);
    expect(
      isRegulatoryReportsRequest({ tenantId: TENANT, reportType: 'DISEASE_OUTBREAK', siteId: SITE, limit: 50 }),
    ).toBe(true);
    expect(isRegulatoryReportsRequest({ tenantId: TENANT })).toBe(false);
    expect(isRegulatoryReportsRequest({ tenantId: TENANT, reportType: 'NOT_A_TYPE' })).toBe(false);
    expect(isRegulatoryReportsRequest({ tenantId: TENANT, reportType: 'SEA_LICE', siteId: 'x' })).toBe(false);
  });

  it('finance guards enforce the window and granularity vocabulary', () => {
    expect(
      isFinanceSummaryRequest({ tenantId: TENANT, ...RANGE, granularity: 'MONTH' }),
    ).toBe(true);
    expect(
      isFinanceSummaryRequest({ tenantId: TENANT, ...RANGE, granularity: 'HOUR' }),
    ).toBe(false);
    expect(
      isFinanceSummaryRequest({ tenantId: TENANT, fromDate: '2026-01-01', toDate: '2027-01-03', granularity: 'DAY' }),
    ).toBe(false); // > 366 days
    expect(isFinanceBatchTotalsRequest({ tenantId: TENANT, ...RANGE })).toBe(true);
    expect(isFinanceBatchTotalsRequest({ tenantId: TENANT, ...RANGE, limit: 50 })).toBe(true);
    expect(isFinanceBatchTotalsRequest({ tenantId: TENANT, fromDate: '2026-01-01' })).toBe(false);
  });
});

describe('farm-ai-query PR-5 request guards (Operations specialist)', () => {
  const EQUIPMENT = '55555555-5555-4555-8555-555555555555';
  const SITE = '22222222-2222-4222-8222-222222222222';

  it('equipment list guard validates optional filters', () => {
    expect(isEquipmentListRequest({ tenantId: TENANT })).toBe(true);
    expect(
      isEquipmentListRequest({
        tenantId: TENANT,
        equipmentTypeId: EQUIPMENT,
        status: 'maintenance',
        isTank: true,
        limit: 50,
      }),
    ).toBe(true);
    expect(isEquipmentListRequest({ tenantId: TENANT, status: 'broken' })).toBe(false);
    expect(isEquipmentListRequest({ tenantId: TENANT, equipmentTypeId: 'type' })).toBe(false);
    expect(isEquipmentListRequest({ tenantId: TENANT, isTank: 'yes' })).toBe(false);
  });

  it('feeder calibrations guard requires the equipment uuid', () => {
    expect(
      isFeederCalibrationsRequest({ tenantId: TENANT, equipmentId: EQUIPMENT, limit: 20 }),
    ).toBe(true);
    expect(isFeederCalibrationsRequest({ tenantId: TENANT, equipmentId: 'feeder-1' })).toBe(false);
    expect(isFeederCalibrationsRequest({ tenantId: TENANT })).toBe(false);
  });

  it('limit-only list guards share the same bounds', () => {
    for (const guard of [
      isOverdueWorkOrdersRequest,
      isMaintenanceScheduleAlertsRequest,
      isLowStockPartsRequest,
      isTodaysTasksRequest,
    ]) {
      expect(guard.name || 'guard').toBeTruthy();
      expect(guard({ tenantId: TENANT })).toBe(true);
      expect(guard({ tenantId: TENANT, limit: 50 })).toBe(true);
      expect(guard({ tenantId: TENANT, limit: 51 })).toBe(false);
      expect(guard({ tenantId: TENANT, limit: 0 })).toBe(false);
      expect(guard({ tenantId: 'bad', limit: 10 })).toBe(false);
      expect(guard([TENANT])).toBe(false);
    }
  });

  it('work order stats guard validates the optional window', () => {
    expect(isWorkOrderStatsRequest({ tenantId: TENANT })).toBe(true);
    expect(
      isWorkOrderStatsRequest({ tenantId: TENANT, fromDate: '2026-01-01', toDate: '2026-06-30' }),
    ).toBe(true);
    expect(isWorkOrderStatsRequest({ tenantId: TENANT, fromDate: '2026-01-01' })).toBe(false);
    expect(
      isWorkOrderStatsRequest({ tenantId: TENANT, fromDate: '2026-01-01', toDate: '01-06-2026' }),
    ).toBe(false);
  });

  it('tenant-only stats guards', () => {
    expect(isStockSummaryRequest({ tenantId: TENANT })).toBe(true);
    expect(isStockSummaryRequest({ tenantId: TENANT, extra: 1 })).toBe(true); // extras tolerated like PR-3
    expect(isStockSummaryRequest({})).toBe(false);
    expect(isTaskStatsRequest({ tenantId: TENANT })).toBe(true);
    expect(isTaskStatsRequest(null)).toBe(false);
  });

  it('farm stock inventory guard validates optional filters', () => {
    expect(isFarmStockInventoryRequest({ tenantId: TENANT })).toBe(true);
    expect(
      isFarmStockInventoryRequest({
        tenantId: TENANT,
        siteId: SITE,
        status: 'active',
        hasActiveBatch: true,
        limit: 50,
      }),
    ).toBe(true);
    expect(isFarmStockInventoryRequest({ tenantId: TENANT, siteId: 'site' })).toBe(false);
    expect(isFarmStockInventoryRequest({ tenantId: TENANT, hasActiveBatch: 'yes' })).toBe(false);
    expect(isFarmStockInventoryRequest({ tenantId: TENANT, limit: 51 })).toBe(false);
  });
});
