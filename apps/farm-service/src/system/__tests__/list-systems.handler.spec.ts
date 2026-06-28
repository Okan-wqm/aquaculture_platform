import { createMockDataSource } from '@aquaculture/testing';

import { ListSystemsQuery } from '../queries/list-systems.query';
import { ListSystemsHandler } from '../handlers/list-systems.handler';

describe('ListSystemsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated systems read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'sys1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSystemsHandler(mockDataSource);
    const result = await handler.execute(new ListSystemsQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('system.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('system.isDeleted = :isDeleted', {
      isDeleted: false,
    });
  });

  it('applies filters when provided', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSystemsHandler(mockDataSource);
    await handler.execute(
      new ListSystemsQuery(tenantId, {
        siteId: 'site-1',
        rootOnly: true,
        search: 'pump',
      }),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('system.siteId = :siteId', {
      siteId: 'site-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('system.parentSystemId IS NULL');
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(system.name ILIKE :search OR system.code ILIKE :search)',
      { search: '%pump%' },
    );
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSystemsHandler(mockDataSource);
    await handler.execute(
      new ListSystemsQuery(tenantId, undefined, {
        page: 1,
        limit: 20,
        sortBy: 'evil; DROP',
        sortOrder: 'ASC',
      }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('system.createdAt', 'ASC');
  });
});
