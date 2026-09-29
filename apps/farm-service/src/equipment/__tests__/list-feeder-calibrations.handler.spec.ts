import { createMockDataSource } from '@aquaculture/testing';

import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { ListFeederCalibrationsHandler } from '../handlers/list-feeder-calibrations.handler';
import { inTenantScope } from '../../__tests__/helpers/farm-tenant-scope.helper';

describe('ListFeederCalibrationsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const equipmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns calibrations for the equipment read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'cal-1' }]);

    const handler = new ListFeederCalibrationsHandler();
    const result = await inTenantScope(tenantId, (scope) => handler.execute(new ListFeederCalibrationsQuery(scope, equipmentId)), mockDataSource);

    expect(result).toEqual([{ id: 'cal-1' }]);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, equipmentId },
      order: { feedSizeMm: 'ASC' },
    });
  });
});
