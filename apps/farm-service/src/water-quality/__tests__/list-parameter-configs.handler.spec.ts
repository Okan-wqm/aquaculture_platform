import { createMockDataSource } from '@aquaculture/testing';

import { ListParameterConfigsQuery } from '../queries/list-parameter-configs.query';
import { ListParameterConfigsHandler } from '../query-handlers/list-parameter-configs.handler';

describe('ListParameterConfigsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('lists parameter configs for the tenant through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'cfg-1' }]);

    const handler = new ListParameterConfigsHandler(mockDataSource);
    const result = await handler.execute(new ListParameterConfigsQuery(tenantId));

    expect(result).toEqual([{ id: 'cfg-1' }]);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId },
      order: { displayOrder: 'ASC' },
    });
  });

  it('applies group and visibility filters', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new ListParameterConfigsHandler(mockDataSource);
    await handler.execute(
      new ListParameterConfigsQuery(tenantId, { isActive: true, isVisible: true }),
    );

    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, isActive: true, isVisible: true },
      order: { displayOrder: 'ASC' },
    });
  });
});
