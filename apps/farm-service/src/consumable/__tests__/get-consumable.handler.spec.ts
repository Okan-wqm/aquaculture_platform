import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetConsumableQuery } from '../queries/get-consumable.query';
import { GetConsumableHandler } from '../handlers/get-consumable.handler';

describe('GetConsumableHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const consumableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the consumable read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: consumableId, tenantId });

    const handler = new GetConsumableHandler(mockDataSource);
    const result = await handler.execute(new GetConsumableQuery(consumableId, tenantId));

    expect(result).toEqual({ id: consumableId, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: consumableId, tenantId },
    });
  });

  it('throws NotFoundException when the consumable does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetConsumableHandler(mockDataSource);

    await expect(
      handler.execute(new GetConsumableQuery(consumableId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
