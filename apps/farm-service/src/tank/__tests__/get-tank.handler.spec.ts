import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetTankQuery } from '../queries/get-tank.query';
import { GetTankHandler } from '../handlers/get-tank.handler';

describe('GetTankHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the tank read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id, name: 'Tank A' });

    const handler = new GetTankHandler(mockDataSource);
    const result = await handler.execute(new GetTankQuery(tenantId, id));

    expect(result).toEqual({ id, name: 'Tank A' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id, tenantId },
      relations: ['department'],
    });
  });

  it('throws NotFoundException when the tank does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetTankHandler(mockDataSource);

    await expect(handler.execute(new GetTankQuery(tenantId, id))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
