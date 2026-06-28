import { createMockDataSource } from '@aquaculture/testing';

import { ListPurchaseOrdersQuery } from '../queries/list-purchase-orders.query';
import { ListPurchaseOrdersHandler } from '../handlers/list-purchase-orders.handler';

describe('ListPurchaseOrdersHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated purchase orders read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'po1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListPurchaseOrdersHandler(mockDataSource);
    const result = await handler.execute(new ListPurchaseOrdersQuery(tenantId, 'feed', 'ORDERED'));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('po.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('po.category = :category', { category: 'feed' });
    expect(qb.andWhere).toHaveBeenCalledWith('po.status = :status', { status: 'ORDERED' });
  });
});
