/**
 * Reply-guard spec for the PR-4 Production specialist tools: each guard
 * accepts its projected shape and rejects near-misses (wrong types, missing
 * keys, null scalars where numbers are required).
 */
import {
  isBatchPerformance,
  isGrowthAnalysis,
  isGrowthMeasurement,
  isMortalityByCause,
  isTransfersSummary,
  isDailyFeedingPlan,
  isFeedingSummary,
  isSiteFeedConsumption,
  isFeedProtocol,
  isSpecies,
  isTankCapacity,
  isHarvestPlan,
  isHarvestPlanStats,
  isBiomassReportOrNull,
  isRegulatoryReport,
  isFinanceSummary,
  isFinanceBatchTotal,
  isAiListOf,
} from '../reply-guards';

const BATCH_PERFORMANCE = {
  batchId: 'b1',
  batchNumber: 'B-1',
  speciesName: 'Seabass',
  currentQuantity: 9500,
  currentBiomassKg: 3400,
  currentAvgWeightG: 358,
  survivalRate: 95.2,
  fcr: { actual: 1.35, target: 1.2, status: 'average' },
  sgr: 1.4,
  performanceIndex: 82,
  performanceStatus: 'good',
  projectedHarvestDate: '2026-11-01T00:00:00.000Z',
};

describe('production reply-guards (PR-4)', () => {
  it('batch performance accepts the projected shape, rejects drift', () => {
    expect(isBatchPerformance(BATCH_PERFORMANCE)).toBe(true);
    expect(isBatchPerformance({ ...BATCH_PERFORMANCE, projectedHarvestDate: null })).toBe(true);
    expect(isBatchPerformance({ ...BATCH_PERFORMANCE, survivalRate: null })).toBe(false);
    expect(isBatchPerformance({ ...BATCH_PERFORMANCE, fcr: { actual: 1 } })).toBe(false);
    expect(isBatchPerformance({ ...BATCH_PERFORMANCE, batchId: 7 })).toBe(false);
  });

  it('growth analysis + measurements accept projected shapes', () => {
    expect(
      isGrowthAnalysis({
        batchId: 'b1',
        batchNumber: 'B-1',
        speciesName: 'Seabass',
        currentAvgWeightG: 358,
        avgDailyGrowthG: 1.47,
        specificGrowthRate: 1.4,
        cumulativeFCR: 1.35,
        avgWeightCV: 11.2,
        needsGrading: false,
        overallPerformance: 'good',
        performanceIndex: 82,
        growthTrend: [],
        recommendations: [],
      }),
    ).toBe(true);
    expect(
      isGrowthMeasurement({
        id: 'gm1',
        batchId: 'b1',
        measurementDate: '2026-09-01T00:00:00.000Z',
        measurementType: 'sample',
        sampleSize: 50,
        averageWeightG: 358,
        weightCV: 11.2,
        performance: 'good',
      }),
    ).toBe(true);
    expect(
      isGrowthMeasurement({
        id: 'gm1',
        batchId: 'b1',
        measurementDate: null,
        measurementType: 'sample',
        sampleSize: 50,
        averageWeightG: 358,
        weightCV: 11.2,
        performance: null,
      }),
    ).toBe(true);
  });

  it('mortality + transfers aggregates validate counters and rows', () => {
    expect(
      isMortalityByCause({
        totalCount: 500,
        byCause: [{ cause: 'predation', count: 500 }],
        details: [{ date: '2026-03-01', cause: 'predation', count: 6 }],
        detailsTruncated: true,
        recordCount: 80,
      }),
    ).toBe(true);
    expect(
      isMortalityByCause({ totalCount: 500, byCause: [], details: [], recordCount: 1 }),
    ).toBe(false); // missing detailsTruncated
    expect(
      isTransfersSummary({
        records: [
          { date: '2026-03-01', direction: 'OUT', speciesCode: 'SEABASS', fishCount: 1, biomassKg: 1 },
        ],
        recordsTruncated: false,
        recordCount: 1,
      }),
    ).toBe(true);
  });

  it('feeding plan/summary/consumption + protocol guards', () => {
    expect(
      isDailyFeedingPlan({
        date: '2026-09-18T00:00:00.000Z',
        siteId: 's1',
        plannedFeedings: [],
        plannedFeedingsTruncated: false,
        totalPlannedKg: 1,
        totalActualKg: 1,
        completionPercent: 100,
      }),
    ).toBe(true);
    expect(
      isFeedingSummary({
        entityId: 'e1',
        entityType: 'batch',
        entityName: 'B-1',
        startDate: null,
        endDate: null,
        totalActualKg: 1,
        totalPlannedKg: 1,
        totalVarianceKg: 0,
        avgDailyFeedingKg: 1,
        appetiteDistribution: { good: 1 },
        feedTypeDistribution: [],
        dailyTrend: [],
        dailyTrendTruncated: false,
      }),
    ).toBe(true);
    expect(
      isSiteFeedConsumption({
        totalKg: 1,
        byFeedType: [{ feedName: 'F', quantityKg: 1 }],
        byFeedTypeTruncated: false,
        recordCount: 1,
      }),
    ).toBe(true);
    expect(
      isFeedProtocol({
        id: 'fp1',
        name: 'P',
        species: 'Seabass',
        stage: 'grower',
        targetFcr: null,
        isActive: true,
        isDefault: false,
      }),
    ).toBe(true);
  });

  it('species + tank capacity guards', () => {
    expect(
      isSpecies({
        id: 'sp1',
        scientificName: 'D. labrax',
        commonName: 'Seabass',
        code: 'SEABASS',
        category: 'warm_water',
        waterType: 'saltwater',
        status: 'active',
        isActive: true,
      }),
    ).toBe(true);
    const tank = {
      tankId: 't1',
      tankCode: 'TNK-001',
      tankName: 'Havuz 1',
      volumeM3: 120,
      maxCapacityKg: 12000,
      currentBiomassKg: 3400,
      currentDensityKgM3: 28.3,
      capacityUsedPercent: 28.3,
      densityStatus: 'low',
      capacityStatus: 'available',
      warnings: [],
    };
    expect(isTankCapacity(tank)).toBe(true);
    expect(isTankCapacity({ ...tank, warnings: 'none' })).toBe(false);
  });

  it('harvest plan + stats guards', () => {
    const plan = {
      id: 'hp1',
      planCode: 'HP-1',
      name: 'Autumn',
      batchId: 'b1',
      status: 'approved',
      harvestType: 'partial',
      productForm: 'fresh',
      plannedDate: '2026-10-01T00:00:00.000Z',
      estimates: { estimatedQuantity: 5000, estimatedBiomassKg: 2100 },
    };
    expect(isHarvestPlan(plan)).toBe(true);
    expect(isHarvestPlan({ ...plan, plannedDate: null })).toBe(true);
    expect(isHarvestPlan({ ...plan, estimates: { estimatedQuantity: 1 } })).toBe(false);
    expect(
      isHarvestPlanStats({
        total: 10,
        upcomingCount: 4,
        overdueCount: 1,
        totalEstimatedBiomass: 21000,
        totalActualBiomass: 1500,
      }),
    ).toBe(true);
  });

  it('biomass report accepts null (absent month) and the projected shape', () => {
    expect(isBiomassReportOrNull(null)).toBe(true);
    const report = {
      id: 'br1',
      siteId: 's1',
      reportMonth: 8,
      reportYear: 2026,
      status: 'submitted',
      totalBiomassKg: 12000,
      currentBiomass: { totalKg: 12000 },
      mortality: { totalCount: 480 },
      feedConsumption: { totalKg: 3900 },
    };
    expect(isBiomassReportOrNull(report)).toBe(true);
    expect(isBiomassReportOrNull({ ...report, reportMonth: '8' })).toBe(false);
  });

  it('regulatory report + finance guards', () => {
    expect(
      isRegulatoryReport({
        id: 'rr1',
        reportType: 'SEA_LICE',
        klientReferanse: 'ref-1',
        status: 'SUBMITTED',
        lokalitetsnummer: 12345,
        attemptCount: 1,
        submittedAt: null,
      }),
    ).toBe(true);
    expect(
      isFinanceSummary({
        currency: 'NOK',
        totalExpense: 1,
        totalRevenue: 1,
        netResult: 0,
        byCategory: [],
        byCategoryTruncated: false,
        series: [],
        seriesTruncated: false,
      }),
    ).toBe(true);
    expect(isFinanceBatchTotal({ batchId: 'b1', totalExpense: 1, totalRevenue: 2 })).toBe(true);
    expect(isFinanceBatchTotal({ batchId: 'b1', totalExpense: null })).toBe(false);
  });

  it('isAiListOf rejects bare arrays and mixed items', () => {
    const isList = isAiListOf(isFinanceBatchTotal);
    expect(
      isList({ items: [{ batchId: 'b1', totalExpense: 1, totalRevenue: 2 }], truncated: false }),
    ).toBe(true);
    expect(isList([{ batchId: 'b1', totalExpense: 1, totalRevenue: 2 }])).toBe(false);
    expect(
      isList({ items: [{ batchId: 'b1', totalExpense: 1 }], truncated: false, total: 1 }),
    ).toBe(false);
  });
});
