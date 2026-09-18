import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { BatchAiQueryResponder } from '../batch-ai-query.responder';
import { GetBatchPerformanceQuery } from '../../queries/get-batch-performance.query';
import { GetMortalityByCauseQuery } from '../../queries/get-mortality-by-cause.query';
import { GetTransfersSummaryQuery } from '../../queries/get-transfers-summary.query';
import { GetGrowthAnalysisQuery } from '../../../growth/queries/get-growth-analysis.query';
import { GetGrowthMeasurementsQuery } from '../../../growth/queries/get-growth-measurements.query';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const BATCH = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

const PERFORMANCE = {
  batchId: BATCH,
  batchNumber: 'B-2026-001',
  speciesName: 'Seabass',
  initialQuantity: 10000,
  currentQuantity: 9500,
  initialBiomassKg: 500,
  currentBiomassKg: 3400,
  initialAvgWeightG: 50,
  currentAvgWeightG: 358,
  weightGainG: 308,
  weightGainPercent: 616,
  totalMortality: 480,
  mortalityRate: 4.8,
  survivalRate: 95.2,
  retentionRate: 99.1,
  cullCount: 20,
  fcr: { target: 1.2, actual: 1.35, theoretical: 1.1, variance: 12.5, status: 'average' },
  sgr: 1.4,
  daysInProduction: 210,
  avgDailyGrowthG: 1.47,
  targetDailyGrowthG: 1.6,
  growthVariancePercent: -8.1,
  totalFeedConsumedKg: 3900,
  totalFeedCost: 15600,
  avgDailyFeedKg: 18.6,
  purchaseCost: 5000,
  totalCost: 21000,
  costPerKg: 6.2,
  costPerFish: 2.2,
  projectedHarvestDate: new Date('2026-11-01T00:00:00.000Z'),
  projectedHarvestWeightG: 420,
  daysToHarvest: 44,
  performanceIndex: 82,
  performanceStatus: 'good',
};

const GROWTH_ANALYSIS = {
  batchId: BATCH,
  batchNumber: 'B-2026-001',
  speciesName: 'Seabass',
  measurementCount: 12,
  daysInProduction: 210,
  stockedDate: new Date('2026-02-01T00:00:00.000Z'),
  initialAvgWeightG: 50,
  currentAvgWeightG: 358,
  targetAvgWeightG: 400,
  totalWeightGainG: 308,
  weightGainPercent: 616,
  avgDailyGrowthG: 1.47,
  targetDailyGrowthG: 1.6,
  dailyGrowthVariancePercent: -8.1,
  specificGrowthRate: 1.4,
  initialBiomassKg: 500,
  currentBiomassKg: 3400,
  biomassGainKg: 2900,
  biomassGainPercent: 580,
  cumulativeFCR: 1.35,
  targetFCR: 1.2,
  fcrVariancePercent: 12.5,
  fcrTrend: 'stable',
  avgWeightCV: 11.2,
  cvTrend: 'improving',
  needsGrading: false,
  overallPerformance: 'good',
  performanceIndex: 82,
  growthTrend: Array.from({ length: 60 }, (_, i) => ({
    date: '2026-03-01',
    avgWeightG: 100 + i,
    theoreticalWeightG: 105 + i,
    cv: 12,
    sgr: 1.5,
  })),
  projectedHarvestDate: new Date('2026-11-01T00:00:00.000Z'),
  projectedHarvestWeightG: 420,
  daysToHarvest: 44,
  recommendations: [
    { priority: 'medium', type: 'growth', description: 'Consider feed adjustment' },
  ],
};

function measurement(
  overrides: Partial<GrowthMeasurement> = {},
): GrowthMeasurement {
  return {
    id: 'gm1',
    tenantId: TENANT,
    batchId: BATCH,
    tankId: null,
    measurementDate: new Date('2026-09-01T00:00:00.000Z'),
    measurementType: 'sample' as GrowthMeasurement['measurementType'],
    measurementMethod: 'manual' as GrowthMeasurement['measurementMethod'],
    sampleSize: 50,
    populationSize: 9500,
    samplePercent: 0.53,
    individualMeasurements: [],
    statistics: {} as GrowthMeasurement['statistics'],
    averageWeight: 358,
    averageLength: 32,
    weightCV: 11.2,
    conditionFactor: 1.1,
    performance: 'good' as GrowthMeasurement['performance'],
    measuredBy: 'operator-user-id', // PII — must never cross the wire
    notes: 'operator note',
    verifiedBy: 'verifier-user-id',
    ...overrides,
  } as GrowthMeasurement;
}

const PAGINATED = (rows: GrowthMeasurement[], total: number) => ({
  data: rows,
  pagination: {
    page: 1,
    limit: rows.length,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(rows.length, 1))),
    hasNextPage: false,
    hasPreviousPage: false,
  },
});

describe('BatchAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: BatchAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new BatchAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ------------------------------------------------------- BATCH_PERFORMANCE
  it('BATCH_PERFORMANCE: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      null,
      { tenantId: TENANT },
      { tenantId: TENANT, batchId: 'batch-1' },
      { tenantId: 'nope', batchId: BATCH },
    ]) {
      expect(await responder.performance(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('BATCH_PERFORMANCE: happy path executes the tenant-scoped query and replies ok', async () => {
    execute.mockResolvedValue(PERFORMANCE);

    const reply = await responder.performance({ tenantId: TENANT, batchId: BATCH });

    expect(execute).toHaveBeenCalledWith(expect.any(GetBatchPerformanceQuery));
    const query = execute.mock.calls[0][0] as GetBatchPerformanceQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.batchId).toBe(BATCH);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.performanceIndex).toBe(82);
      expect(reply.data.projectedHarvestDate).toBe('2026-11-01T00:00:00.000Z');
      expect(JSON.stringify(reply.data)).not.toContain('operator-user-id');
    }
  });

  it('BATCH_PERFORMANCE: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('connection reset'));
    expect(await responder.performance({ tenantId: TENANT, batchId: BATCH })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // --------------------------------------------------------- GROWTH_ANALYSIS
  it('GROWTH_ANALYSIS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.growthAnalysis({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('GROWTH_ANALYSIS: happy path caps the trend list at 50 and projects ISO dates', async () => {
    execute.mockResolvedValue(GROWTH_ANALYSIS);

    const reply = await responder.growthAnalysis({ tenantId: TENANT, batchId: BATCH });

    expect(execute).toHaveBeenCalledWith(expect.any(GetGrowthAnalysisQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.growthTrend).toHaveLength(50);
      expect(reply.data.growthTrendTruncated).toBe(true);
      expect(reply.data.stockedDate).toBe('2026-02-01T00:00:00.000Z');
      expect(reply.data.needsGrading).toBe(false);
    }
  });

  it('GROWTH_ANALYSIS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.growthAnalysis({ tenantId: TENANT, batchId: BATCH })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ----------------------------------------------------- GROWTH_MEASUREMENTS
  it('GROWTH_MEASUREMENTS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT },
      { tenantId: TENANT, batchId: BATCH, limit: 51 },
    ]) {
      expect(await responder.growthMeasurements(bad)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('GROWTH_MEASUREMENTS: happy path bounds the list and strips measurer PII', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => measurement({ id: `gm${i}` }));
    execute.mockResolvedValue(PAGINATED(rows, 120));

    const reply = await responder.growthMeasurements({
      tenantId: TENANT,
      batchId: BATCH,
      limit: 50,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetGrowthMeasurementsQuery));
    const query = execute.mock.calls[0][0] as GetGrowthMeasurementsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.filter?.batchId).toBe(BATCH);
    expect(query.limit).toBe(50);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.total).toBe(120);
      expect(reply.data.items[0]?.measurementDate).toBe('2026-09-01T00:00:00.000Z');
      expect(JSON.stringify(reply.data)).not.toContain('measuredBy');
      expect(JSON.stringify(reply.data)).not.toContain('verifiedBy');
      expect(JSON.stringify(reply.data)).not.toContain('operator note');
    }
  });

  it('GROWTH_MEASUREMENTS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.growthMeasurements({ tenantId: TENANT, batchId: BATCH }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // --------------------------------------------------- BATCH_MORTALITY_BY_CAUSE
  it('BATCH_MORTALITY_BY_CAUSE: invalid payload (bad range) → INVALID_REQUEST', async () => {
    for (const bad of [
      { tenantId: TENANT, siteId: SITE, fromDate: '2025-01-01', toDate: '2026-05-01' },
      { tenantId: TENANT, siteId: SITE, fromDate: '01-01-2026', toDate: '2026-05-01' },
      { tenantId: TENANT, siteId: 'site', fromDate: '2026-01-01', toDate: '2026-05-01' },
    ]) {
      expect(await responder.mortalityByCause(bad)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('BATCH_MORTALITY_BY_CAUSE: happy path executes the query and caps details', async () => {
    execute.mockResolvedValue({
      totalCount: 500,
      byCause: [{ cause: 'predation', count: 500 }],
      details: Array.from({ length: 80 }, (_, i) => ({
        date: '2026-03-01',
        cause: 'predation',
        speciesCode: 'SEABASS',
        count: 6,
        biomassLossKg: 2.2,
        index: i,
      })),
      recordCount: 80,
    });

    const reply = await responder.mortalityByCause({
      tenantId: TENANT,
      siteId: SITE,
      fromDate: '2026-01-01',
      toDate: '2026-05-01',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetMortalityByCauseQuery));
    const query = execute.mock.calls[0][0] as GetMortalityByCauseQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.siteId).toBe(SITE);
    expect(query.fromDate).toBe('2026-01-01');

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.totalCount).toBe(500);
      expect(reply.data.details).toHaveLength(50);
      expect(reply.data.detailsTruncated).toBe(true);
    }
  });

  it('BATCH_MORTALITY_BY_CAUSE: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.mortalityByCause({
        tenantId: TENANT,
        siteId: SITE,
        fromDate: '2026-01-01',
        toDate: '2026-05-01',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // -------------------------------------------------- BATCH_TRANSFERS_SUMMARY
  it('BATCH_TRANSFERS_SUMMARY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(
      await responder.transfersSummary({ tenantId: TENANT, siteId: SITE, fromDate: '2026-01-01' }),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('BATCH_TRANSFERS_SUMMARY: happy path executes the query and caps records', async () => {
    execute.mockResolvedValue({
      records: Array.from({ length: 70 }, () => ({
        date: '2026-03-01',
        direction: 'OUT',
        speciesCode: 'SEABASS',
        fishCount: 1000,
        biomassKg: 350,
        counterparty: 'Site B',
      })),
      recordCount: 70,
    });

    const reply = await responder.transfersSummary({
      tenantId: TENANT,
      siteId: SITE,
      fromDate: '2026-01-01',
      toDate: '2026-05-01',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetTransfersSummaryQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.records).toHaveLength(50);
      expect(reply.data.recordsTruncated).toBe(true);
      expect(reply.data.records[0]?.direction).toBe('OUT');
    }
  });

  it('BATCH_TRANSFERS_SUMMARY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.transfersSummary({
        tenantId: TENANT,
        siteId: SITE,
        fromDate: '2026-01-01',
        toDate: '2026-05-01',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
