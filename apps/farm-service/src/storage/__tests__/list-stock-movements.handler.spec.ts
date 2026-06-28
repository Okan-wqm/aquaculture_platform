import { createMockDataSource } from '@aquaculture/testing';

import { ListStockMovementsQuery } from '../queries/list-stock-movements.query';
import { ListStockMovementsHandler } from '../handlers/list-stock-movements.handler';

describe('ListStockMovementsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated stock movements read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'mov1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListStockMovementsHandler(mockDataSource);
    const result = await handler.execute(
      new ListStockMovementsQuery(tenantId, { movementType: 'INBOUND' }),
    );

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('mov.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('mov.movementType = :movementType', {
      movementType: 'INBOUND',
    });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListStockMovementsHandler(mockDataSource);
    await handler.execute(
      new ListStockMovementsQuery(tenantId, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('mov.performedAt', 'ASC');
  });
});
