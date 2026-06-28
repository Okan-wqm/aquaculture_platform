import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetFarmQuery } from '../queries/get-farm.query';
import { GetFarmQueryHandler } from '../query-handlers/get-farm.handler';

describe('GetFarmQueryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const farmId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('reads tenant-scoped through the tenant boundary when a tenantId is present', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: farmId, tenantId });

    const handler = new GetFarmQueryHandler(mockDataSource);
    const result = await handler.execute(new GetFarmQuery(farmId, tenantId));

    expect(result).toEqual({ id: farmId, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: { id: farmId, tenantId } }),
    );
  });

  it('reads cross-tenant via the source-read path for a federation lookup (no tenantId)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: farmId });

    const handler = new GetFarmQueryHandler(mockDataSource);
    // An empty tenantId is how the federation __resolveReference path arrives.
    const result = await handler.execute(new GetFarmQuery(farmId, ''));

    expect(result).toEqual({ id: farmId });
    expect(mockManager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: { id: farmId } }),
    );
  });

  it('throws NotFoundException when the farm does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetFarmQueryHandler(mockDataSource);

    await expect(
      handler.execute(new GetFarmQuery(farmId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
