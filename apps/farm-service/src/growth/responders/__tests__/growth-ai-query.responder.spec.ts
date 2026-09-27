import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { GetGrowthAnalysisQuery } from '../../queries/get-growth-analysis.query';
import { GetGrowthMeasurementsQuery } from '../../queries/get-growth-measurements.query';
import { GrowthAiQueryResponder } from '../growth-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';

describe('GrowthAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: GrowthAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new GrowthAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('analysis: keeps the last 30 trend points and 10 recommendations, ISO dates', async () => {
    execute.mockResolvedValue({
      batchId: BATCH,
      batchNumber: 'B-1',
      speciesName: 'Seabass',
      measurementCount: 12,
      daysInProduction: 90,
      stockedDate: new Date('2026-06-20T00:00:00Z'),
      initialAvgWeightG: 10,
      currentAvgWeightG: 90,
      targetAvgWeightG: 95,
      totalWeightGainG: 80,
      weightGainPercent: 800,
      avgDailyGrowthG: 0.9,
      targetDailyGrowthG: 0.95,
      dailyGrowthVariancePercent: -5,
      specificGrowthRate: 2.4,
      initialBiomassKg: 100,
      currentBiomassKg: 850,
      biomassGainKg: 750,
      biomassGainPercent: 750,
      cumulativeFCR: 1.15,
      targetFCR: 1.1,
      fcrVariancePercent: 4.5,
      fcrTrend: 'stable',
      avgWeightCV: 12,
      cvTrend: 'improving',
      needsGrading: false,
      overallPerformance: 'good',
      performanceIndex: 79,
      growthTrend: Array.from({ length: 45 }, (_, i) => ({
        date: `d${i}`,
        avgWeightG: i,
        theoreticalWeightG: i,
        cv: 10,
        sgr: 2,
      })),
      projectedHarvestDate: undefined,
      projectedHarvestWeightG: undefined,
      daysToHarvest: undefined,
      recommendations: Array.from({ length: 12 }, (_, i) => ({
        priority: 'low',
        type: 't',
        description: `r${i}`,
      })),
    });

    const reply = await responder.getAnalysis({ tenantId: TENANT, batchId: BATCH });

    expect(execute).toHaveBeenCalledWith(expect.any(GetGrowthAnalysisQuery));
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.stockedDate).toBe('2026-06-20T00:00:00.000Z');
    expect(reply.data.sgr).toBe(2.4);
    expect(reply.data.cumulativeFcr).toBe(1.15);
    expect(reply.data.growthTrend).toHaveLength(30);
    expect(reply.data.growthTrend[0]?.date).toBe('d15');
    expect(reply.data.growthTrendTruncated).toBe(true);
    expect(reply.data.recommendations).toHaveLength(10);
    expect(reply.data.projectedHarvestDate).toBeNull();
  });

  it('measurements: pages newest-first by the requested limit and strips measurer / notes', async () => {
    execute.mockResolvedValue({
      data: [
        {
          id: BATCH,
          measurementDate: new Date('2026-09-15T00:00:00Z'),
          measurementType: 'routine',
          sampleSize: '50',
          populationSize: 9500,
          averageWeight: '92.5',
          averageLength: undefined,
          weightCV: 11,
          conditionFactor: 1.2,
          estimatedBiomass: 878.75,
          biomassGain: 20,
          performance: 'good',
          isVerified: true,
          measuredBy: 'user-3',
          notes: 'n',
        },
      ],
      pagination: {
        page: 1,
        limit: 5,
        total: 12,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: false,
      },
    });

    const reply = await responder.listMeasurements({ tenantId: TENANT, batchId: BATCH, limit: 5 });

    expect(execute).toHaveBeenCalledWith(expect.any(GetGrowthMeasurementsQuery));
    const query = execute.mock.calls[0][0] as GetGrowthMeasurementsQuery;
    expect(query).toMatchObject({
      tenantId: TENANT,
      filter: { batchId: BATCH },
      page: 1,
      limit: 5,
      sortBy: 'measurementDate',
      sortOrder: 'DESC',
    });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        total: 12,
        truncated: true,
        items: [{ avgWeightG: 92.5, sampleSize: 50, avgLengthCm: null, isVerified: true }],
      },
    });
    expect(JSON.stringify(reply)).not.toContain('user-3');
  });
});
