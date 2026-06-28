import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetFeedingSummaryQuery } from '../queries/get-feeding-summary.query';
import { GetFeedingSummaryHandler } from '../query-handlers/get-feeding-summary.handler';

describe('GetFeedingSummaryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const batchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const makeQb = (rows: unknown[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('aggregates feeding records read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ batchNumber: 'B-001' });
    const qb = makeQb([
      {
        feedId: 'feed-1',
        feedingDate: new Date('2026-06-01T00:00:00Z'),
        plannedAmount: 10,
        actualAmount: 8,
        wasteAmount: 1,
        feedCost: 4,
        feedingDurationMinutes: 30,
        fishBehavior: { appetite: 'good' },
      },
    ]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'feed-1', name: 'Starter' }]);

    const handler = new GetFeedingSummaryHandler(mockDataSource);
    const result = await handler.execute(new GetFeedingSummaryQuery(tenantId, 'batch', batchId));

    expect(result.entityName).toBe('B-001');
    expect(result.totalFeedingsCount).toBe(1);
    expect(result.totalPlannedKg).toBe(10);
    expect(result.totalActualKg).toBe(8);
    expect(result.feedTypeDistribution[0]?.feedName).toBe('Starter');
    expect(qb.where).toHaveBeenCalledWith('fr.tenantId = :tenantId', { tenantId });
  });

  it('throws NotFoundException when the batch entity does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetFeedingSummaryHandler(mockDataSource);

    await expect(
      handler.execute(new GetFeedingSummaryQuery(tenantId, 'batch', batchId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
