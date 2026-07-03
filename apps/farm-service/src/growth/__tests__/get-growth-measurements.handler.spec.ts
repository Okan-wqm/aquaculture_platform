import { createMockDataSource } from '@aquaculture/testing';

import { GetGrowthMeasurementsQuery } from '../queries/get-growth-measurements.query';
import { GetGrowthMeasurementsHandler } from '../query-handlers/get-growth-measurements.handler';

describe('GetGrowthMeasurementsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

  it('returns paginated measurements read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'gm1' }, { id: 'gm2' }], 2);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetGrowthMeasurementsHandler(mockDataSource);
    const result = await handler.execute(new GetGrowthMeasurementsQuery(tenantId));

    expect(result.data).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
    expect(qb.where).toHaveBeenCalledWith('gm.tenantId = :tenantId', { tenantId });
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetGrowthMeasurementsHandler(mockDataSource);
    await handler.execute(
      new GetGrowthMeasurementsQuery(tenantId, undefined, 1, 20, 'evil; DROP', 'ASC'),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('gm.measurementDate', 'ASC');
  });

  it('applies batch and verification filters', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetGrowthMeasurementsHandler(mockDataSource);
    await handler.execute(
      new GetGrowthMeasurementsQuery(tenantId, { batchId: 'batch-1', isVerified: true }),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('gm.batchId = :batchId', { batchId: 'batch-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('gm.isVerified = :isVerified', { isVerified: true });
  });
});
