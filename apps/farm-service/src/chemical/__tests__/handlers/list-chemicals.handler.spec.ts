import { createMockDataSource } from '@aquaculture/testing';

import { ListChemicalsQuery } from '../../queries/list-chemicals.query';
import { ListChemicalsHandler } from '../../handlers/list-chemicals.handler';

describe('ListChemicalsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated chemicals read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListChemicalsHandler(mockDataSource);
    const result = await handler.execute(new ListChemicalsQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('chemical.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('chemical.isDeleted = :isDeleted', {
      isDeleted: false,
    });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListChemicalsHandler(mockDataSource);
    await handler.execute(
      new ListChemicalsQuery(tenantId, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('chemical.createdAt', 'ASC');
  });

  it('joins chemical_sites when a siteId filter is supplied', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListChemicalsHandler(mockDataSource);
    await handler.execute(
      new ListChemicalsQuery(tenantId, { siteId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    );

    expect(qb.innerJoin).toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith('chemicalSite.siteId = :siteId', {
      siteId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
  });
});
