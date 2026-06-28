import { createMockDataSource } from '@aquaculture/testing';

import { GetFeedInventoryQuery } from '../queries/get-feed-inventory.query';
import { GetFeedInventoryHandler } from '../query-handlers/get-feed-inventory.handler';

describe('GetFeedInventoryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('returns paginated feed inventory read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'inv1' }, { id: 'inv2' }], 2);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetFeedInventoryHandler(mockDataSource);
    const result = await handler.execute(new GetFeedInventoryQuery(tenantId));

    expect(result.data).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
    expect(qb.where).toHaveBeenCalledWith('inv.tenantId = :tenantId', { tenantId });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetFeedInventoryHandler(mockDataSource);
    await handler.execute(new GetFeedInventoryQuery(tenantId, undefined, 1, 20, 'evil; DROP', 'DESC'));

    expect(qb.orderBy).toHaveBeenCalledWith('inv.quantityKg', 'DESC');
  });
});
