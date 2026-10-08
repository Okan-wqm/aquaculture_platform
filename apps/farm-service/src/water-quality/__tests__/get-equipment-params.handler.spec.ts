import { createMockDataSource } from '@aquaculture/testing';
import { IsNull } from 'typeorm';

import { GetEquipmentParamsQuery } from '../queries/get-equipment-params.query';
import { GetEquipmentParamsHandler } from '../query-handlers/get-equipment-params.handler';

describe('GetEquipmentParamsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const equipmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the live manual plan at the unit, as a tank or an equipment point', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'pe-1' }]);

    const handler = new GetEquipmentParamsHandler(mockDataSource);
    const result = await handler.execute(new GetEquipmentParamsQuery(tenantId, equipmentId));

    expect(result).toEqual([{ id: 'pe-1' }]);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: [
        {
          tenantId,
          tankId: equipmentId,
          isActive: true,
          channelKey: IsNull(),
          unboundAt: IsNull(),
        },
        { tenantId, equipmentId, isActive: true, channelKey: IsNull(), unboundAt: IsNull() },
      ],
      relations: ['parameterConfig'],
      order: { createdAt: 'ASC' },
    });
  });
});
