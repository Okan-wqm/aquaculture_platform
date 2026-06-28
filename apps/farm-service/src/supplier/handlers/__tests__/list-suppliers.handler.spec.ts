import { createMockDataSource } from '@aquaculture/testing';

import { ListSuppliersQuery } from '../../queries/list-suppliers.query';
import { ListSuppliersHandler } from '../list-suppliers.handler';

describe('ListSuppliersHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated, non-deleted suppliers read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'sup1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSuppliersHandler(mockDataSource);
    const result = await handler.execute(new ListSuppliersQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('supplier.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('supplier.isDeleted = :isDeleted', {
      isDeleted: false,
    });
    expect(qb.orderBy).toHaveBeenCalledWith('supplier.createdAt', 'DESC');
  });

  it('applies the search filter and a safe sort field', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSuppliersHandler(mockDataSource);
    await handler.execute(
      new ListSuppliersQuery(
        tenantId,
        { search: 'acme' },
        { sortBy: 'evil; DROP', sortOrder: 'ASC' },
      ),
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(supplier.name ILIKE :search OR supplier.code ILIKE :search OR supplier.email ILIKE :search)',
      { search: '%acme%' },
    );
    expect(qb.orderBy).toHaveBeenCalledWith('supplier.createdAt', 'ASC');
  });
});
