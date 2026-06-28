import { createMockDataSource } from '@aquaculture/testing';

import { GetSystemQuery } from '../queries/get-system.query';
import { GetSystemHandler } from '../handlers/get-system.handler';

describe('GetSystemHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const systemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const makeQb = (one: unknown) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(one),
  });

  it('returns the system read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb({ id: systemId });
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetSystemHandler(mockDataSource);
    const result = await handler.execute(new GetSystemQuery(systemId, tenantId));

    expect(result).toEqual({ id: systemId });
    expect(qb.where).toHaveBeenCalledWith('system.id = :systemId', { systemId });
    expect(qb.andWhere).toHaveBeenCalledWith('system.tenantId = :tenantId', { tenantId });
    expect(qb.leftJoinAndSelect).not.toHaveBeenCalled();
  });

  it('joins related entities when includeRelations is true', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb({ id: systemId });
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetSystemHandler(mockDataSource);
    await handler.execute(new GetSystemQuery(systemId, tenantId, true));

    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('system.site', 'site');
    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('system.department', 'department');
    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('system.parentSystem', 'parentSystem');
  });

  it('returns null when no system matches', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb(null);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetSystemHandler(mockDataSource);
    const result = await handler.execute(new GetSystemQuery(systemId, tenantId));

    expect(result).toBeNull();
  });
});
