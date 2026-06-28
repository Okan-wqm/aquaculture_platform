import { createMockDataSource } from '@aquaculture/testing';

import { GetEquipmentParamsQuery } from '../queries/get-equipment-params.query';
import { GetEquipmentParamsHandler } from '../query-handlers/get-equipment-params.handler';

describe('GetEquipmentParamsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const equipmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns active param mappings for the equipment through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'pe-1' }]);

    const handler = new GetEquipmentParamsHandler(mockDataSource);
    const result = await handler.execute(new GetEquipmentParamsQuery(tenantId, equipmentId));

    expect(result).toEqual([{ id: 'pe-1' }]);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, equipmentId, isActive: true },
      relations: ['parameterConfig'],
      order: { createdAt: 'ASC' },
    });
  });
});
