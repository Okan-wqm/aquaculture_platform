import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetSubEquipmentQuery } from '../queries/get-sub-equipment.query';
import { GetSubEquipmentHandler } from '../handlers/get-sub-equipment.handler';

describe('GetSubEquipmentHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the sub-equipment read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id, tenantId });

    const handler = new GetSubEquipmentHandler(mockDataSource);
    const result = await handler.execute(new GetSubEquipmentQuery(id, tenantId));

    expect(result).toEqual({ id, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id, tenantId },
      relations: ['subEquipmentType'],
    });
  });

  it('includes deep relations when includeRelations is true', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id, tenantId });

    const handler = new GetSubEquipmentHandler(mockDataSource);
    await handler.execute(new GetSubEquipmentQuery(id, tenantId, true));

    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id, tenantId },
      relations: ['subEquipmentType', 'parentEquipment', 'parentEquipment.equipmentType'],
    });
  });

  it('throws NotFoundException when the sub-equipment does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSubEquipmentHandler(mockDataSource);

    await expect(
      handler.execute(new GetSubEquipmentQuery(id, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
