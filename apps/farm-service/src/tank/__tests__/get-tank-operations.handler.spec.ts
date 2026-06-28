import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetTankOperationsQuery } from '../queries/get-tank-operations.query';
import { GetTankOperationsHandler } from '../handlers/get-tank-operations.handler';

describe('GetTankOperationsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tankId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const makeQb = (rows: unknown[], count: number) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('returns paginated operations read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: tankId });
    const qb = makeQb([{ id: 'op1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetTankOperationsHandler(mockDataSource);
    const result = await handler.execute(new GetTankOperationsQuery(tenantId, tankId));

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('op.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('op.tankId = :tankId', { tankId });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: tankId });
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetTankOperationsHandler(mockDataSource);
    await handler.execute(
      new GetTankOperationsQuery(tenantId, tankId, undefined, 1, 20, 'evil; DROP', 'ASC'),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('op.operationDate', 'ASC');
  });

  it('throws NotFoundException when the tank does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetTankOperationsHandler(mockDataSource);

    await expect(
      handler.execute(new GetTankOperationsQuery(tenantId, tankId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
