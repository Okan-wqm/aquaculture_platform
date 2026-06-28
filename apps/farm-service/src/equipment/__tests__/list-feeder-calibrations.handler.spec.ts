import { createMockDataSource } from '@aquaculture/testing';

import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { ListFeederCalibrationsHandler } from '../handlers/list-feeder-calibrations.handler';

describe('ListFeederCalibrationsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const equipmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns calibrations for the equipment read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'cal-1' }]);

    const handler = new ListFeederCalibrationsHandler(mockDataSource);
    const result = await handler.execute(
      new ListFeederCalibrationsQuery(equipmentId, tenantId),
    );

    expect(result).toEqual([{ id: 'cal-1' }]);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, equipmentId },
      order: { feedSizeMm: 'ASC' },
    });
  });
});
