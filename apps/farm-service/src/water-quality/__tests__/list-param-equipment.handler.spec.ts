import { createMockDataSource } from '@aquaculture/testing';
import { IsNull } from 'typeorm';

import { ListParamEquipmentQuery } from '../queries/list-param-equipment.query';
import { ListParamEquipmentHandler } from '../query-handlers/list-param-equipment.handler';

describe('ListParamEquipmentHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const live = { channelKey: IsNull(), unboundAt: IsNull() };

  it('lists the live manual sources of the tenant through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'pe-1' }, { id: 'pe-2' }]);

    const handler = new ListParamEquipmentHandler(mockDataSource);
    const result = await handler.execute(new ListParamEquipmentQuery(tenantId));

    expect(result).toHaveLength(2);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: [{ tenantId, ...live }],
      relations: ['parameterConfig', 'equipment'],
      order: { createdAt: 'ASC' },
    });
  });

  it('matches a unit filter as a tank or an equipment point, with the isActive filter', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new ListParamEquipmentHandler(mockDataSource);
    await handler.execute(
      new ListParamEquipmentQuery(tenantId, { equipmentId: 'eq-1', isActive: false }),
    );

    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: [
        { tenantId, ...live, isActive: false, tankId: 'eq-1' },
        { tenantId, ...live, isActive: false, equipmentId: 'eq-1' },
      ],
      relations: ['parameterConfig', 'equipment'],
      order: { createdAt: 'ASC' },
    });
  });
});
