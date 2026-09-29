import { createMockDataSource } from '@aquaculture/testing';

import { ListParameterConfigsQuery } from '../queries/list-parameter-configs.query';
import { ListParameterConfigsHandler } from '../query-handlers/list-parameter-configs.handler';
import { inTenantScope } from '../../__tests__/helpers/farm-tenant-scope.helper';

describe('ListParameterConfigsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('lists parameter configs for the tenant through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'cfg-1' }]);

    const handler = new ListParameterConfigsHandler();
    const result = await inTenantScope(
      tenantId,
      (scope) => handler.execute(new ListParameterConfigsQuery(scope)),
      mockDataSource,
    );

    expect(result).toEqual([{ id: 'cfg-1' }]);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId },
      order: { displayOrder: 'ASC' },
    });
  });

  it('applies group and visibility filters', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new ListParameterConfigsHandler();
    await inTenantScope(
      tenantId,
      (scope) =>
        handler.execute(new ListParameterConfigsQuery(scope, { isActive: true, isVisible: true })),
      mockDataSource,
    );

    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, isActive: true, isVisible: true },
      order: { displayOrder: 'ASC' },
    });
  });
});
