import { createMockDataSource } from '@aquaculture/testing';

import { GetFeedingRecordsQuery } from '../queries/get-feeding-records.query';
import { GetFeedingRecordsHandler } from '../query-handlers/get-feeding-records.handler';

describe('GetFeedingRecordsHandler', () => {
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

  it('returns paginated feeding records read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'fr1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetFeedingRecordsHandler(mockDataSource);
    const result = await handler.execute(new GetFeedingRecordsQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('fr.tenantId = :tenantId', { tenantId });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetFeedingRecordsHandler(mockDataSource);
    await handler.execute(
      new GetFeedingRecordsQuery(tenantId, undefined, 1, 20, 'evil; DROP', 'ASC'),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('fr.feedingDate', 'ASC');
  });
});
