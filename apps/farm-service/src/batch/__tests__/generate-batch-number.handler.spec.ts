import { createMockDataSource } from '@aquaculture/testing';

import { GenerateBatchNumberQuery } from '../queries/generate-batch-number.query';
import { GenerateBatchNumberHandler } from '../query-handlers/generate-batch-number.handler';

describe('GenerateBatchNumberHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const year = new Date().getFullYear();

  const makeQb = (one: unknown) => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(one),
  });

  it('starts at 00001 when no batch exists for the year', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(makeQb(null)) as typeof mockManager.createQueryBuilder;

    const handler = new GenerateBatchNumberHandler(mockDataSource);
    const result = await handler.execute(new GenerateBatchNumberQuery(tenantId));

    expect(result).toBe(`B-${year}-00001`);
  });

  it('increments from the highest existing batch number', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(makeQb({ batchNumber: `B-${year}-00012` })) as typeof mockManager.createQueryBuilder;

    const handler = new GenerateBatchNumberHandler(mockDataSource);
    const result = await handler.execute(new GenerateBatchNumberQuery(tenantId));

    expect(result).toBe(`B-${year}-00013`);
  });
});
