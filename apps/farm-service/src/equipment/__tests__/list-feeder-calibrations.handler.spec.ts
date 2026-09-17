import { createMockDataSource } from '@aquaculture/testing';

import { FeederCalibration } from '../entities/feeder-calibration.entity';
import { FeederCapability, FeederDosingMode } from '../entities/feeder-capability.entity';
import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { ListFeederCalibrationsHandler } from '../handlers/list-feeder-calibrations.handler';

describe('ListFeederCalibrationsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const equipmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the machine and its calibrations together, read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const capability = { equipmentId, dosingMode: FeederDosingMode.CONTINUOUS } as FeederCapability;
    (mockManager.getRepository as jest.Mock).mockImplementation(() => ({
      findOne: jest.fn().mockResolvedValue(capability),
    }));
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'cal-1' }]);

    const handler = new ListFeederCalibrationsHandler(mockDataSource);
    const result = await handler.execute(new ListFeederCalibrationsQuery(equipmentId, tenantId));

    expect(result).toEqual({ capability, calibrations: [{ id: 'cal-1' }] });
    expect(mockManager.find).toHaveBeenCalledWith(FeederCalibration, {
      where: { tenantId, equipmentId },
      order: { feedId: 'ASC' },
    });
  });

  it('reports a null capability for equipment never commissioned as a feeder', async () => {
    // "Never commissioned" and "commissioned but uncalibrated" are different
    // states, and only the first explains why a dose plan would be refused, so
    // the read path must not collapse them into an empty list.
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.getRepository as jest.Mock).mockImplementation(() => ({
      findOne: jest.fn().mockResolvedValue(null),
    }));

    const handler = new ListFeederCalibrationsHandler(mockDataSource);
    const result = await handler.execute(new ListFeederCalibrationsQuery(equipmentId, tenantId));

    expect(result).toEqual({ capability: null, calibrations: [] });
  });
});
