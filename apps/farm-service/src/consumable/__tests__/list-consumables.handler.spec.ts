import { createMockDataSource } from '@aquaculture/testing';

import { ListConsumablesQuery } from '../queries/list-consumables.query';
import { ListConsumablesHandler } from '../handlers/list-consumables.handler';

describe('ListConsumablesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated consumables read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'c1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListConsumablesHandler(mockDataSource);
    const result = await handler.execute(new ListConsumablesQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('consumable.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('consumable.isDeleted = :isDeleted', {
      isDeleted: false,
    });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListConsumablesHandler(mockDataSource);
    await handler.execute(
      new ListConsumablesQuery(tenantId, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('consumable.createdAt', 'ASC');
  });

  it('applies category and search filters when provided', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListConsumablesHandler(mockDataSource);
    await handler.execute(
      new ListConsumablesQuery(tenantId, { search: 'rope' }),
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(consumable.name ILIKE :search OR consumable.code ILIKE :search OR consumable.brand ILIKE :search)',
      { search: '%rope%' },
    );
  });
});
