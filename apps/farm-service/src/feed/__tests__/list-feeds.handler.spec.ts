import { createMockDataSource } from '@aquaculture/testing';

import { ListFeedsQuery } from '../queries/list-feeds.query';
import { ListFeedsHandler } from '../handlers/list-feeds.handler';

describe('ListFeedsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated non-deleted feeds read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'feed1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListFeedsHandler(mockDataSource);
    const result = await handler.execute(new ListFeedsQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('feed.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('feed.isDeleted = :isDeleted', { isDeleted: false });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListFeedsHandler(mockDataSource);
    await handler.execute(
      new ListFeedsQuery(tenantId, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('feed.createdAt', 'ASC');
  });
});
