import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetInventoryCountQuery } from '../queries/get-inventory-count.query';
import { GetInventoryCountHandler } from '../handlers/get-inventory-count.handler';

describe('GetInventoryCountHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const countId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the inventory count read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: countId, items: [] });

    const handler = new GetInventoryCountHandler(mockDataSource);
    const result = await handler.execute(new GetInventoryCountQuery(countId, tenantId));

    expect(result).toEqual({ id: countId, items: [] });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: countId, tenantId },
      relations: ['items'],
    });
  });

  it('throws NotFoundException when the count does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetInventoryCountHandler(mockDataSource);

    await expect(
      handler.execute(new GetInventoryCountQuery(countId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
