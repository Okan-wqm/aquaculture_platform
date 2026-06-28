import { createMockDataSource } from '@aquaculture/testing';

import { ListParamEquipmentQuery } from '../queries/list-param-equipment.query';
import { ListParamEquipmentHandler } from '../query-handlers/list-param-equipment.handler';

describe('ListParamEquipmentHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('lists mappings filtered by tenant through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'pe-1' }, { id: 'pe-2' }]);

    const handler = new ListParamEquipmentHandler(mockDataSource);
    const result = await handler.execute(new ListParamEquipmentQuery(tenantId));

    expect(result).toHaveLength(2);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId },
      relations: ['parameterConfig', 'equipment'],
      order: { createdAt: 'ASC' },
    });
  });

  it('applies equipment and isActive filters', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new ListParamEquipmentHandler(mockDataSource);
    await handler.execute(
      new ListParamEquipmentQuery(tenantId, { equipmentId: 'eq-1', isActive: false }),
    );

    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, equipmentId: 'eq-1', isActive: false },
      relations: ['parameterConfig', 'equipment'],
      order: { createdAt: 'ASC' },
    });
  });
});
