import { createMockDataSource } from '@aquaculture/testing';

import { ListSitesHandler } from '../handlers/list-sites.handler';
import { ListSitesQuery } from '../queries/list-sites.query';

describe('ListSitesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (result: [unknown[], number]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue(result),
  });

  it('returns paginated sites read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const sites = [
      { id: 'site-1', tenantId },
      { id: 'site-2', tenantId },
    ];
    const qb = makeQb([sites, 2]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource);
    const result = await handler.execute(
      new ListSitesQuery(tenantId, undefined, { page: 1, limit: 20 }),
    );

    expect(result.data).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
    expect(qb.where).toHaveBeenCalledWith('site.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('site.isDeleted = :isDeleted', {
      isDeleted: false,
    });
  });

  it('falls back to a safe sort column for an unknown sortBy (SQL-injection guard)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([[], 0]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource);
    await handler.execute(
      new ListSitesQuery(tenantId, undefined, { sortBy: 'evil; DROP TABLE', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('site.createdAt', 'ASC');
  });
});
