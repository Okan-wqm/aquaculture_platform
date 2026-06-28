import { createMockDataSource } from '@aquaculture/testing';

import { ListSpeciesQuery } from '../../queries/list-species.query';
import { ListSpeciesHandler } from '../list-species.handler';

describe('ListSpeciesHandler', () => {
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

  it('returns paginated, non-deleted species read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'sp1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSpeciesHandler(mockDataSource);
    const result = await handler.execute(new ListSpeciesQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith({ tenantId, isDeleted: false });
    expect(qb.orderBy).toHaveBeenCalledWith('species.commonName', 'ASC');
  });

  it('applies the search filter and a safe sort field/order', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSpeciesHandler(mockDataSource);
    await handler.execute(
      new ListSpeciesQuery(tenantId, {
        search: 'salmon',
        sortBy: 'scientificName',
        sortOrder: 'DESC',
        offset: 0,
        limit: 20,
      }),
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(species.scientificName ILIKE :search OR species.commonName ILIKE :search OR species.localName ILIKE :search OR species.code ILIKE :search)',
      { search: '%salmon%' },
    );
    expect(qb.orderBy).toHaveBeenCalledWith('species.scientificName', 'DESC');
  });

  it('falls back to commonName ASC for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSpeciesHandler(mockDataSource);
    await handler.execute(
      new ListSpeciesQuery(tenantId, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('species.commonName', 'ASC');
  });
});
