import { createMockDataSource } from '@aquaculture/testing';

import { ListDepartmentsHandler } from '../handlers/list-departments.handler';
import { ListDepartmentsQuery } from '../queries/list-departments.query';

describe('ListDepartmentsHandler', () => {
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

  it('returns paginated departments read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListDepartmentsHandler(mockDataSource);
    const result = await handler.execute(new ListDepartmentsQuery(tenantId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('department.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('department.isDeleted = :isDeleted', {
      isDeleted: false,
    });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListDepartmentsHandler(mockDataSource);
    await handler.execute(
      new ListDepartmentsQuery(tenantId, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('department.createdAt', 'ASC');
  });

  it('applies the search filter when provided', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListDepartmentsHandler(mockDataSource);
    await handler.execute(new ListDepartmentsQuery(tenantId, { search: 'hatch' }));

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(department.name ILIKE :search OR department.code ILIKE :search OR department.description ILIKE :search)',
      { search: '%hatch%' },
    );
  });
});
