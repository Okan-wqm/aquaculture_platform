import { createMockDataSource } from '@aquaculture/testing';
import { NotFoundException } from '@nestjs/common';

import { GetBatchQuery } from '../queries/get-batch.query';
import { GetBatchHandler } from '../query-handlers/get-batch.handler';

describe('GetBatchHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (one: unknown) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(one),
  });

  it('returns the batch read through the tenant boundary (with relations by default)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const batch = { id: 'batch-1', tenantId };
    const qb = makeQb(batch);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetBatchHandler(mockDataSource);
    const result = await handler.execute(new GetBatchQuery(tenantId, 'batch-1'));

    expect(result).toBe(batch);
    expect(qb.andWhere).toHaveBeenCalledWith('batch.tenantId = :tenantId', { tenantId });
    expect(qb.leftJoinAndSelect).toHaveBeenCalled();
  });

  it('throws NotFoundException when the batch does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb(null);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetBatchHandler(mockDataSource);
    await expect(
      handler.execute(new GetBatchQuery(tenantId, 'missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
