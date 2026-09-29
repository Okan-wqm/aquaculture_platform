import { createMockDataSource } from '@aquaculture/testing';

import { ListFeedingProtocolsQuery } from '../queries/list-feeding-protocols.query';
import { ListFeedingProtocolsHandler } from '../handlers/list-feeding-protocols.handler';
import { inTenantScope } from '../../__tests__/helpers/farm-tenant-scope.helper';

describe('ListFeedingProtocolsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated feeding protocols read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'fp1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListFeedingProtocolsHandler();
    const result = await inTenantScope(tenantId, (scope) => handler.execute(new ListFeedingProtocolsQuery(scope)), mockDataSource);

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('protocol.tenantId = :tenantId', { tenantId });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListFeedingProtocolsHandler();
    await inTenantScope(tenantId, (scope) => handler.execute(new ListFeedingProtocolsQuery(scope, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' })), mockDataSource);

    expect(qb.orderBy).toHaveBeenCalledWith('protocol.createdAt', 'ASC');
  });
});
