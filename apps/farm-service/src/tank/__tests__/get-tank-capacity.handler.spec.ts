import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetTankCapacityQuery } from '../queries/get-tank-capacity.query';
import { GetTankCapacityHandler } from '../handlers/get-tank-capacity.handler';

describe('GetTankCapacityHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tankId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns capacity metrics read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock)
      .mockResolvedValueOnce({
        id: tankId,
        code: 'T-1',
        name: 'Tank 1',
        volume: 100,
        maxDensity: 25,
        maxBiomass: 2500,
      })
      .mockResolvedValueOnce({
        currentQuantity: 1000,
        currentBiomassKg: 1250,
        avgWeightG: 1.25,
        batchDetails: [],
        primaryBatchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      });

    const handler = new GetTankCapacityHandler(mockDataSource);
    const result = await handler.execute(new GetTankCapacityQuery(tenantId, tankId));

    expect(result.tankId).toBe(tankId);
    expect(result.currentBiomassKg).toBe(1250);
    expect(result.maxCapacityKg).toBe(2500);
    expect(result.capacityUsedPercent).toBe(50);
    expect(mockManager.findOne).toHaveBeenNthCalledWith(1, expect.anything(), {
      where: { id: tankId, tenantId, isActive: true },
    });
    expect(mockManager.findOne).toHaveBeenNthCalledWith(2, expect.anything(), {
      where: { tenantId, tankId },
    });
  });

  it('throws NotFoundException when the tank does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const handler = new GetTankCapacityHandler(mockDataSource);

    await expect(
      handler.execute(new GetTankCapacityQuery(tenantId, tankId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
