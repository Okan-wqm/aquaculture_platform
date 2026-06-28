import { createMockDataSource } from '@aquaculture/testing';

import { ListHarvestsQuery } from '../../queries/list-harvests.query';
import { ListHarvestsHandler } from '../../handlers/list-harvests.handler';

describe('ListHarvestsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('returns paginated harvest records read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'hr1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListHarvestsHandler(mockDataSource);
    const result = await handler.execute(new ListHarvestsQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('harvest.tenantId = :tenantId', { tenantId });
    expect(qb.orderBy).toHaveBeenCalledWith('harvest.harvestDate', 'DESC');
  });

  it('applies filters and falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListHarvestsHandler(mockDataSource);
    await handler.execute(
      new ListHarvestsQuery(
        tenantId,
        { batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        { page: 1, limit: 20, sortBy: 'evil; DROP', sortOrder: 'ASC' },
      ),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('harvest.batchId = :batchId', {
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(qb.orderBy).toHaveBeenCalledWith('harvest.harvestDate', 'ASC');
  });
});
