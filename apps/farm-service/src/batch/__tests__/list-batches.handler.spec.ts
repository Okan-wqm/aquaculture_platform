import { createMockDataSource } from '@aquaculture/testing';

import { ListBatchesQuery } from '../queries/list-batches.query';
import { ListBatchesHandler } from '../query-handlers/list-batches.handler';

describe('ListBatchesHandler', () => {
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

  it('returns paginated batches read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const rows = [
      { id: 'b1', tenantId },
      { id: 'b2', tenantId },
    ];
    const qb = makeQb(rows, 2);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListBatchesHandler(mockDataSource);
    const result = await handler.execute(
      new ListBatchesQuery(tenantId, undefined, 1, 20, 'stockedAt', 'DESC'),
    );

    expect(result.data).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
    expect(qb.where).toHaveBeenCalledWith('batch.tenantId = :tenantId', { tenantId });
  });

  it('falls back to a safe sort field for an unknown sortBy (SQL-injection guard)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListBatchesHandler(mockDataSource);
    await handler.execute(
      new ListBatchesQuery(tenantId, undefined, 1, 20, 'evil; DROP TABLE', 'ASC'),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('batch.stockedAt', 'ASC');
  });
});
