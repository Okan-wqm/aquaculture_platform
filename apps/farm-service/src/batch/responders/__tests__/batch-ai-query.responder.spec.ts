import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { GetBatchPerformanceQuery } from '../../queries/get-batch-performance.query';
import { GetMortalityByCauseQuery } from '../../queries/get-mortality-by-cause.query';
import { GetTransfersSummaryQuery } from '../../queries/get-transfers-summary.query';
import { BatchAiQueryResponder } from '../batch-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';

describe('BatchAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: BatchAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new BatchAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe(FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE, () => {
    it('rejects a non-uuid batch id without touching the bus', async () => {
      const reply = await responder.getPerformance({ tenantId: TENANT, batchId: 'B-1' });
      expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('projects the performance result with pct suffixes and ISO projections', async () => {
      execute.mockResolvedValue({
        batchId: BATCH,
        batchNumber: 'B-2026-01',
        speciesName: 'Seabass',
        initialQuantity: 10000,
        currentQuantity: 9500,
        initialBiomassKg: 100,
        currentBiomassKg: 950,
        initialAvgWeightG: 10,
        currentAvgWeightG: 100,
        weightGainG: 90,
        weightGainPercent: 900,
        totalMortality: 500,
        mortalityRate: 5,
        survivalRate: 95,
        retentionRate: 95,
        cullCount: 0,
        fcr: { target: 1.1, actual: 1.2, theoretical: 1.15, variance: 4.3, status: 'good' },
        sgr: 1.9,
        daysInProduction: 120,
        avgDailyGrowthG: 0.75,
        targetDailyGrowthG: 0.8,
        growthVariancePercent: -6,
        totalFeedConsumedKg: 1020,
        totalFeedCost: 2040,
        avgDailyFeedKg: 8.5,
        purchaseCost: 500,
        totalCost: 2540,
        costPerKg: 2.67,
        costPerFish: 0.27,
        projectedHarvestDate: new Date('2027-03-01T00:00:00Z'),
        projectedHarvestWeightG: 400,
        daysToHarvest: 164,
        performanceIndex: 78,
        performanceStatus: 'good',
      });

      const reply = await responder.getPerformance({ tenantId: TENANT, batchId: BATCH });

      expect(execute).toHaveBeenCalledWith(expect.any(GetBatchPerformanceQuery));
      expect(reply).toMatchObject({
        ok: true,
        data: {
          batchId: BATCH,
          weightGainPct: 900,
          mortalityRatePct: 5,
          fcr: { actual: 1.2, status: 'good' },
          projectedHarvestDate: '2027-03-01T00:00:00.000Z',
          performanceIndex: 78,
        },
      });
    });

    it('maps a rejected query to INTERNAL_ERROR', async () => {
      execute.mockRejectedValue(new Error('boom'));
      const reply = await responder.getPerformance({ tenantId: TENANT, batchId: BATCH });
      expect(reply).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE, () => {
    it('rejects a window over the contract cap', async () => {
      const reply = await responder.getMortalityByCause({
        tenantId: TENANT,
        siteId: BATCH,
        fromDate: '2024-01-01',
        toDate: '2026-09-18',
      });
      expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    });

    it('derives percentages per cause and drops per-record details', async () => {
      execute.mockResolvedValue({
        totalCount: 40,
        byCause: [
          { cause: 'disease', count: 30 },
          { cause: 'handling', count: 10 },
        ],
        details: [{ date: '2026-09-01', cause: 'disease', speciesCode: 'SB', count: 30 }],
        recordCount: 2,
      });

      const reply = await responder.getMortalityByCause({
        tenantId: TENANT,
        siteId: BATCH,
        fromDate: '2026-09-01',
        toDate: '2026-09-18',
      });

      expect(execute).toHaveBeenCalledWith(expect.any(GetMortalityByCauseQuery));
      expect(reply).toEqual({
        ok: true,
        data: {
          siteId: BATCH,
          fromDate: '2026-09-01',
          toDate: '2026-09-18',
          totalCount: 40,
          recordCount: 2,
          byCause: [
            { cause: 'disease', count: 30, pct: 75 },
            { cause: 'handling', count: 10, pct: 25 },
          ],
        },
      });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY, () => {
    it('totals inbound and outbound and bounds the record list', async () => {
      execute.mockResolvedValue({
        records: [
          {
            date: '2026-09-01',
            direction: 'IN',
            speciesCode: 'SB',
            fishCount: 100,
            biomassKg: '10.5',
            counterparty: 'Farm X',
          },
          { date: '2026-09-02', direction: 'OUT', speciesCode: 'SB', fishCount: 40, biomassKg: 8 },
        ],
        recordCount: 2,
      });

      const reply = await responder.getTransfersSummary({
        tenantId: TENANT,
        siteId: BATCH,
        fromDate: '2026-09-01',
        toDate: '2026-09-18',
      });

      expect(execute).toHaveBeenCalledWith(expect.any(GetTransfersSummaryQuery));
      expect(reply).toMatchObject({
        ok: true,
        data: {
          totalInCount: 100,
          totalInBiomassKg: 10.5,
          totalOutCount: 40,
          totalOutBiomassKg: 8,
          truncated: false,
        },
      });
      expect(JSON.stringify(reply)).not.toContain('Farm X');
    });
  });
});
