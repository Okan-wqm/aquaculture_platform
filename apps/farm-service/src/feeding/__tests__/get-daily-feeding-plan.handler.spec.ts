import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetDailyFeedingPlanQuery } from '../queries/get-daily-feeding-plan.query';
import { GetDailyFeedingPlanHandler } from '../query-handlers/get-daily-feeding-plan.handler';

describe('GetDailyFeedingPlanHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const siteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const programId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const equipmentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const date = new Date('2026-06-28T00:00:00.000Z');

  const makeQb = (rows: unknown[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('builds the daily feeding plan read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();

    // findOne -> site lookup; find -> active programs.
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: siteId });
    (mockManager.find as jest.Mock).mockResolvedValueOnce([
      { id: programId, status: 'active', feedAssignments: [] },
    ]);

    // First createQueryBuilder call -> program tanks; second -> executions.
    const programTanksQb = makeQb([
      {
        feedingProgramId: programId,
        equipmentId,
        equipmentCode: 'TANK-01',
        currentFeedId: 'feed-1',
        currentFeedCode: 'FEED-1',
      },
    ]);
    const executionsQb = makeQb([
      {
        feedingProgramId: programId,
        equipmentId,
        calculations: { plannedFeedKg: 10 },
        actualResults: { actualFeedGivenKg: 8 },
        isCompleted: (): boolean => true,
      },
    ]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValueOnce(programTanksQb)
      .mockReturnValueOnce(executionsQb) as typeof mockManager.createQueryBuilder;

    const handler = new GetDailyFeedingPlanHandler(mockDataSource);
    const result = await handler.execute(new GetDailyFeedingPlanQuery(tenantId, siteId, date));

    expect(result.siteId).toBe(siteId);
    expect(result.plannedFeedings).toHaveLength(1);
    expect(result.plannedFeedings[0]).toMatchObject({
      tankId: equipmentId,
      tankCode: 'TANK-01',
      feedId: 'feed-1',
      feedName: 'FEED-1',
      plannedAmountKg: 10,
      actualAmountKg: 8,
      mealsPlanned: 1,
      mealsCompleted: 1,
      isComplete: true,
    });
    expect(result.totalPlannedKg).toBe(10);
    expect(result.totalActualKg).toBe(8);
    expect(result.completionPercent).toBe(80);
    expect(programTanksQb.where).toHaveBeenCalledWith('pt.tenantId = :tenantId', { tenantId });
  });

  it('throws NotFoundException when the site does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetDailyFeedingPlanHandler(mockDataSource);

    await expect(
      handler.execute(new GetDailyFeedingPlanQuery(tenantId, siteId, date)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
