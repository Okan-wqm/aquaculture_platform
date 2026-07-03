import { createMockDataSource } from '@aquaculture/testing';

import { ListSubEquipmentQuery } from '../queries/list-sub-equipment.query';
import { ListSubEquipmentHandler } from '../handlers/list-sub-equipment.handler';

describe('ListSubEquipmentHandler', () => {
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

  it('returns paginated sub-equipment read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'se-1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSubEquipmentHandler(mockDataSource);
    const result = await handler.execute(new ListSubEquipmentQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('subEquipment.tenantId = :tenantId', { tenantId });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSubEquipmentHandler(mockDataSource);
    await handler.execute(
      new ListSubEquipmentQuery(tenantId, undefined, {
        page: 1,
        limit: 20,
        sortBy: 'evil; DROP',
        sortOrder: 'ASC',
      }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('subEquipment.createdAt', 'ASC');
  });

  it('applies filters when provided', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSubEquipmentHandler(mockDataSource);
    await handler.execute(
      new ListSubEquipmentQuery(tenantId, { parentEquipmentId: 'parent-1', search: 'pump' }),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('subEquipment.parentEquipmentId = :parentEquipmentId', {
      parentEquipmentId: 'parent-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(subEquipment.name ILIKE :search OR subEquipment.code ILIKE :search OR subEquipment.serialNumber ILIKE :search)',
      { search: '%pump%' },
    );
  });
});
