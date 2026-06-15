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
