/**
 * MobileDashboardService Unit Tests
 *
 * FARM-MEDIUM-053: today's removal counts must include culls (cullCount) and
 * keep mortality mortality-only.
 * FARM-HIGH-055: getStockEventsSummary no longer returns the always-zero
 * pendingTransferCount field.
 */
import { createMockRepository } from '@aquaculture/testing';
import { Repository } from 'typeorm';

import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { DailyFeedingExecution } from '../../feeding/entities/daily-feeding-execution.entity';
import { WaterQualityMeasurement } from '../../water-quality/entities/water-quality-measurement.entity';
import { MobileDashboardService } from '../mobile-dashboard.service';

interface QbStub {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  getRawOne: jest.Mock;
  getCount: jest.Mock;
}

function makeQb(rawOne: unknown, count = 0): QbStub {
  const qb: Partial<QbStub> = {};
  qb.select = jest.fn().mockReturnValue(qb);
  qb.addSelect = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.setParameter = jest.fn().mockReturnValue(qb);
  qb.getRawOne = jest.fn().mockResolvedValue(rawOne);
  qb.getCount = jest.fn().mockResolvedValue(count);
  return qb as QbStub;
}

/** A fully-typed mock repository whose createQueryBuilder yields `qb`. */
function repoWithQb<T extends import('typeorm').ObjectLiteral>(qb: QbStub): Repository<T> {
  const repo = createMockRepository<T>();
  // createQueryBuilder is a jest.Mock; mockReturnValue accepts any stub.
  (repo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
  return repo;
}

describe('MobileDashboardService', () => {
  const TENANT = 'tenant-1';

  describe('getTodaysDailyOpsCounts (FARM-MEDIUM-053)', () => {
    it('returns a distinct cullCount summed from CULL operations and keeps mortality mortality-only', async () => {
      const mortalityRepo = repoWithQb<MortalityRecord>(makeQb({ mortalityCount: '12' }));

      const cullQb = makeQb({ cullCount: '7' });
      const tankOperationRepo = repoWithQb<TankOperation>(cullQb);

      const waterQualityRepo = repoWithQb<WaterQualityMeasurement>(makeQb(null, 3));
      const feedingExecutionRepo = repoWithQb<DailyFeedingExecution>(
        makeQb({ feedingTotalCount: '5', feedingCompletedCount: '4' }),
      );

      const service = new MobileDashboardService(
        mortalityRepo,
        waterQualityRepo,
        feedingExecutionRepo,
        tankOperationRepo,
      );

      const result = await service.getTodaysDailyOpsCounts(TENANT);

      expect(result.mortalityCount).toBe(12);
      expect(result.cullCount).toBe(7);
      expect(result.wqReadingsCount).toBe(3);
      expect(result.feedingCompletedCount).toBe(4);
      expect(result.feedingTotalCount).toBe(5);

      // the cull aggregate filtered on operationType = CULL
      const cullParam = cullQb.andWhere.mock.calls.find(
        ([, params]) => params && (params as { cull?: string }).cull === OperationType.CULL,
      );
      expect(cullParam).toBeDefined();
    });
  });

  describe('getTodaysDailyOpsCounts clientDate boundary (FARM-MEDIUM-056)', () => {
    /** Collect the `:today` param value passed to a query builder's andWhere. */
    function todayParamOf(qb: QbStub): string | undefined {
      const call = qb.andWhere.mock.calls.find(
        ([, params]) => params && Object.prototype.hasOwnProperty.call(params, 'today'),
      );
      return call ? (call[1] as { today?: string }).today : undefined;
    }

    it('resolves the day from a valid clientDate (not UTC now) for all sub-queries', async () => {
      const mortalityQb = makeQb({ mortalityCount: '1' });
      const cullQb = makeQb({ cullCount: '0' });
      const wqQb = makeQb(null, 0);
      const feedingQb = makeQb({ feedingTotalCount: '0', feedingCompletedCount: '0' });

      const service = new MobileDashboardService(
        repoWithQb<MortalityRecord>(mortalityQb),
        repoWithQb<WaterQualityMeasurement>(wqQb),
        repoWithQb<DailyFeedingExecution>(feedingQb),
        repoWithQb<TankOperation>(cullQb),
      );

      // A date far from "today" so the assertion cannot pass by coincidence.
      await service.getTodaysDailyOpsCounts(TENANT, '2024-02-29');

      // mortality.recordDate, cull.operationDate and feeding.executionDate all
      // consume the SAME resolved calendar day.
      expect(todayParamOf(mortalityQb)).toBe('2024-02-29');
      expect(todayParamOf(cullQb)).toBe('2024-02-29');
      expect(todayParamOf(feedingQb)).toBe('2024-02-29');

      // The WQ window is [todayStart, tomorrow) derived from the same day.
      const todayStartCall = wqQb.andWhere.mock.calls.find(
        ([, params]) => params && Object.prototype.hasOwnProperty.call(params, 'todayStart'),
      );
      const tomorrowCall = wqQb.andWhere.mock.calls.find(
        ([, params]) => params && Object.prototype.hasOwnProperty.call(params, 'tomorrow'),
      );
      const todayStart = (todayStartCall![1] as { todayStart: Date }).todayStart;
      const tomorrow = (tomorrowCall![1] as { tomorrow: Date }).tomorrow;
      expect(todayStart.toISOString()).toBe('2024-02-29T00:00:00.000Z');
      expect(tomorrow.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    });

    it('falls back to the server day when clientDate is malformed (not trusted blindly)', async () => {
      const mortalityQb = makeQb({ mortalityCount: '0' });
      const service = new MobileDashboardService(
        repoWithQb<MortalityRecord>(mortalityQb),
        repoWithQb<WaterQualityMeasurement>(makeQb(null, 0)),
        repoWithQb<DailyFeedingExecution>(makeQb({ feedingTotalCount: '0', feedingCompletedCount: '0' })),
        repoWithQb<TankOperation>(makeQb({ cullCount: '0' })),
      );

      // '2026-02-30' is shape-valid but not a real day → rejected → UTC fallback.
      await service.getTodaysDailyOpsCounts(TENANT, '2026-02-30');

      const used = todayParamOf(mortalityQb);
      expect(used).not.toBe('2026-02-30');
      // The fallback is today's UTC calendar day (YYYY-MM-DD).
      expect(used).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('getStockEventsSummary (FARM-HIGH-055)', () => {
    it('does not return pendingTransferCount', async () => {
      const tankOperationRepo = createMockRepository<TankOperation>();
      tankOperationRepo.count.mockResolvedValue(4);
      tankOperationRepo.find.mockResolvedValue([]);

      const service = new MobileDashboardService(
        createMockRepository<MortalityRecord>(),
        createMockRepository<WaterQualityMeasurement>(),
        createMockRepository<DailyFeedingExecution>(),
        tankOperationRepo,
      );

      const summary = await service.getStockEventsSummary(TENANT, 7);

      expect(summary.thisWeekEventsCount).toBe(4);
      expect(summary.recentEvents).toEqual([]);
      expect(summary).not.toHaveProperty('pendingTransferCount');
    });
  });
});
