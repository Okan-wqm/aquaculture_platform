/**
 * Mobile-dashboard read query handlers — fail-closed tenant boundary
 * (FARM-HIGH-060). Ported from the former MobileDashboardService unit tests so
 * the FARM-MEDIUM-053 (cullCount), FARM-MEDIUM-056 (clientDate boundary) and
 * FARM-HIGH-055 (no pendingTransferCount) guarantees keep their coverage on the
 * new handlers.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { OperationType } from '../../batch/entities/tank-operation.entity';
import { FeedingDayPlan } from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { FeedingMealStatus } from '../../feeding-protocol/entities/feeding-meal.entity';
import { GetTodaysDailyOpsCountsHandler } from '../handlers/get-todays-daily-ops-counts.handler';
import { GetTodaysDailyOpsCountsQuery } from '../queries/get-todays-daily-ops-counts.query';
import { GetStockEventsSummaryHandler } from '../handlers/get-stock-events-summary.handler';
import { GetStockEventsSummaryQuery } from '../queries/get-stock-events-summary.query';

interface QbStub {
  select: jest.Mock;
  addSelect: jest.Mock;
  innerJoin: jest.Mock;
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
  qb.innerJoin = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.setParameter = jest.fn().mockReturnValue(qb);
  qb.getRawOne = jest.fn().mockResolvedValue(rawOne);
  qb.getCount = jest.fn().mockResolvedValue(count);
  return qb as QbStub;
}

function todayParamOf(qb: QbStub): string | undefined {
  const call = qb.andWhere.mock.calls.find(
    ([, params]) => params && Object.prototype.hasOwnProperty.call(params, 'today'),
  );
  return call ? (call[1] as { today?: string }).today : undefined;
}

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('GetTodaysDailyOpsCountsHandler (fail-closed tenant boundary)', () => {
  // The handler issues the four aggregates in order: mortality, cull, wq, feeding.
  function wire(mortalityQb: QbStub, cullQb: QbStub, wqQb: QbStub, feedingQb: QbStub) {
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.createQueryBuilder = jest.fn();
    (mockManager.createQueryBuilder as jest.Mock)
      .mockReturnValueOnce(mortalityQb)
      .mockReturnValueOnce(cullQb)
      .mockReturnValueOnce(wqQb)
      .mockReturnValueOnce(feedingQb);
    return mockDataSource;
  }

  it('returns a distinct cullCount and keeps mortality mortality-only (FARM-MEDIUM-053)', async () => {
    const cullQb = makeQb({ cullCount: '7' });
    const feedingQb = makeQb({ feedingTotalCount: '5', feedingCompletedCount: '4' });
    const ds = wire(makeQb({ mortalityCount: '12' }), cullQb, makeQb(null, 3), feedingQb);

    const result = await new GetTodaysDailyOpsCountsHandler(ds).execute(
      new GetTodaysDailyOpsCountsQuery(TENANT),
    );

    expect(result.mortalityCount).toBe(12);
    expect(result.cullCount).toBe(7);
    expect(result.wqReadingsCount).toBe(3);
    expect(result.feedingCompletedCount).toBe(4);
    expect(result.feedingTotalCount).toBe(5);

    const cullParam = cullQb.andWhere.mock.calls.find(
      ([, params]) => params && (params as { cull?: string }).cull === OperationType.CULL,
    );
    expect(cullParam).toBeDefined();

    // Faz 6 cutover: yemleme sayacı öğün motorundan gelir — day-plan join'i,
    // CANCELLED dışlaması ve fed|skipped "tamamlandı" kümesi pinlenir.
    expect(feedingQb.innerJoin).toHaveBeenCalledWith(
      FeedingDayPlan,
      'plan',
      'plan.id = meal.dayPlanId',
    );
    const cancelledParam = feedingQb.andWhere.mock.calls.find(
      ([, params]) =>
        params && (params as { cancelled?: string }).cancelled === FeedingMealStatus.CANCELLED,
    );
    expect(cancelledParam).toBeDefined();
    expect(feedingQb.setParameter).toHaveBeenCalledWith('handled', [
      FeedingMealStatus.FED,
      FeedingMealStatus.SKIPPED,
    ]);
  });

  it('resolves the day from a valid clientDate for all sub-queries (FARM-MEDIUM-056)', async () => {
    const mortalityQb = makeQb({ mortalityCount: '1' });
    const cullQb = makeQb({ cullCount: '0' });
    const wqQb = makeQb(null, 0);
    const feedingQb = makeQb({ feedingTotalCount: '0', feedingCompletedCount: '0' });
    const ds = wire(mortalityQb, cullQb, wqQb, feedingQb);

    await new GetTodaysDailyOpsCountsHandler(ds).execute(
      new GetTodaysDailyOpsCountsQuery(TENANT, '2024-02-29'),
    );

    expect(todayParamOf(mortalityQb)).toBe('2024-02-29');
    expect(todayParamOf(cullQb)).toBe('2024-02-29');
    expect(todayParamOf(feedingQb)).toBe('2024-02-29');

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

  it('falls back to the server day when clientDate is malformed (FARM-MEDIUM-056)', async () => {
    const mortalityQb = makeQb({ mortalityCount: '0' });
    const ds = wire(
      mortalityQb,
      makeQb({ cullCount: '0' }),
      makeQb(null, 0),
      makeQb({ feedingTotalCount: '0', feedingCompletedCount: '0' }),
    );

    await new GetTodaysDailyOpsCountsHandler(ds).execute(
      new GetTodaysDailyOpsCountsQuery(TENANT, '2026-02-30'),
    );

    const used = todayParamOf(mortalityQb);
    expect(used).not.toBe('2026-02-30');
    expect(used).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('GetStockEventsSummaryHandler (fail-closed tenant boundary)', () => {
  it('returns the count + recent events and no pendingTransferCount (FARM-HIGH-055)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.count = jest.fn().mockResolvedValue(4);
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const summary = await new GetStockEventsSummaryHandler(mockDataSource).execute(
      new GetStockEventsSummaryQuery(TENANT, 7),
    );

    expect(summary.thisWeekEventsCount).toBe(4);
    expect(summary.recentEvents).toEqual([]);
    expect(summary).not.toHaveProperty('pendingTransferCount');
  });
});
