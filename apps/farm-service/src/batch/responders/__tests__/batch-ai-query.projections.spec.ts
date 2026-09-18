/**
 * Projection spec for the batch/growth farm-AI responder (PR-4): PII deep
 * ban, ISO dates, cap/truncated.
 */
import {
  BatchPerformanceResult,
} from '../../queries/get-batch-performance.query';
import { GrowthAnalysisResult } from '../../../growth/queries/get-growth-analysis.query';
import { MortalityByCauseResult } from '../../queries/get-mortality-by-cause.query';
import { TransfersSummaryResult } from '../../queries/get-transfers-summary.query';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';
import {
  projectBatchPerformance,
  projectGrowthAnalysis,
  projectGrowthMeasurement,
  projectMortalityByCause,
  projectTransfersSummary,
} from '../projections';

const TENANT = '33333333-3333-4333-8333-333333333333';
const BATCH = '11111111-1111-4111-8111-111111111111';

/** The PII ban list — none of these keys may appear anywhere in a reply. */
const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'vet',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'measuredBy',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const PERFORMANCE: BatchPerformanceResult = {
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
  performanceIndex: 82,
  performanceStatus: 'good',
};

const GROWTH: GrowthAnalysisResult = {
  batchId: BATCH,
  batchNumber: 'B-2026-001',
  speciesName: 'Seabass',
  measurementCount: 12,
  daysInProduction: 210,
  stockedDate: new Date('2026-02-01T00:00:00.000Z'),
  initialAvgWeightG: 50,
  currentAvgWeightG: 358,
  totalWeightGainG: 308,
  weightGainPercent: 616,
  avgDailyGrowthG: 1.47,
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
  recommendations: [
    { priority: 'medium', type: 'growth', description: 'Adjust feed rate' },
  ],
};

const MEASUREMENT: GrowthMeasurement = {
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
  individualMeasurements: [{ weightG: 350 } as never],
  statistics: { mean: 358 } as unknown as GrowthMeasurement['statistics'],
  averageWeight: 358,
  averageLength: 32,
  weightCV: 11.2,
  conditionFactor: 1.1,
  performance: 'good' as GrowthMeasurement['performance'],
  measuredBy: 'operator-user-id',
  verifiedBy: 'verifier-user-id',
  notes: 'operator note',
  attachments: ['s3://bucket/secret.csv'],
} as unknown as GrowthMeasurement;

const MORTALITY: MortalityByCauseResult = {
  totalCount: 500,
  byCause: [{ cause: 'predation', count: 500 }],
  details: [
    {
      date: '2026-03-01',
      cause: 'predation',
      speciesCode: 'SEABASS',
      count: 6,
      biomassLossKg: 2.2,
    },
  ],
  recordCount: 1,
};

const TRANSFERS: TransfersSummaryResult = {
  records: [
    {
      date: '2026-03-01',
      direction: 'OUT',
      speciesCode: 'SEABASS',
      fishCount: 1000,
      biomassKg: 350,
      counterparty: 'Site B',
    },
  ],
  recordCount: 1,
};

describe('batch/growth farm-AI projections (PR-4 read-only namespace)', () => {
  it('strips PII and entity metadata — deep key scan', () => {
    const projections = [
      projectBatchPerformance(PERFORMANCE),
      projectGrowthAnalysis(GROWTH),
      projectGrowthMeasurement(MEASUREMENT),
      projectMortalityByCause(MORTALITY),
      projectTransfersSummary(TRANSFERS),
    ];
    for (const projection of projections) {
      const keys = collectKeys(projection);
      for (const banned of BANNED_KEYS) {
        expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
      }
    }
  });

  it('serializes every date as an ISO string (or null)', () => {
    const performance = projectBatchPerformance(PERFORMANCE);
    expect(performance.projectedHarvestDate).toBe('2026-11-01T00:00:00.000Z');

    const growth = projectGrowthAnalysis(GROWTH);
    expect(growth.stockedDate).toBe('2026-02-01T00:00:00.000Z');
    expect(growth.projectedHarvestDate).toBeNull(); // absent → null

    const measurement = projectGrowthMeasurement(MEASUREMENT);
    expect(measurement.measurementDate).toBe('2026-09-01T00:00:00.000Z');

    const mortality = projectMortalityByCause(MORTALITY);
    expect(mortality.details[0]?.date).toBe('2026-03-01');
  });

  it('caps embedded lists at 50 and flags truncation', () => {
    const growth = projectGrowthAnalysis(GROWTH);
    expect(growth.growthTrend).toHaveLength(50);
    expect(growth.growthTrendTruncated).toBe(true);

    const many = Array.from({ length: 80 }, (_, i) => ({
      date: '2026-03-01',
      cause: 'predation',
      speciesCode: 'SEABASS',
      count: i,
    }));
    const mortality = projectMortalityByCause({ ...MORTALITY, details: many });
    expect(mortality.details).toHaveLength(50);
    expect(mortality.detailsTruncated).toBe(true);

    const transfers = projectTransfersSummary({
      records: many.map((d) => ({
        date: d.date,
        direction: 'IN' as const,
        speciesCode: d.speciesCode,
        fishCount: d.count,
        biomassKg: 1,
      })),
      recordCount: 80,
    });
    expect(transfers.records).toHaveLength(50);
    expect(transfers.recordsTruncated).toBe(true);
  });

  it('keeps enum-like strings as plain strings', () => {
    const performance = projectBatchPerformance(PERFORMANCE);
    expect(performance.performanceStatus).toBe('good');
    expect(performance.fcr.status).toBe('average');

    const growth = projectGrowthAnalysis(GROWTH);
    expect(growth.overallPerformance).toBe('good');
    expect(growth.fcrTrend).toBe('stable');

    const measurement = projectGrowthMeasurement(MEASUREMENT);
    expect(measurement.performance).toBe('good');
  });
});
