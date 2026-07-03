import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetTankBatchesQuery } from '../queries/get-tank-batches.query';
import { GetTankBatchesHandler } from '../handlers/get-tank-batches.handler';

describe('GetTankBatchesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tankId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const batchId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const speciesId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  it('returns tank batches read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    // 1: Tank, 2: TankBatch
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
        primaryBatchId: batchId,
        primaryBatchNumber: 'B-001',
        currentQuantity: 1000,
        totalQuantity: 1000,
        currentBiomassKg: 500,
        totalBiomassKg: 500,
        avgWeightG: 0.5,
        batchDetails: [],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
    // 1: batches, 2: species
    (mockManager.find as jest.Mock)
      .mockResolvedValueOnce([
        { id: batchId, batchNumber: 'B-001', speciesId, isActive: true, status: 'active' },
      ])
      .mockResolvedValueOnce([{ id: speciesId, commonName: 'Salmon' }]);

    const handler = new GetTankBatchesHandler(mockDataSource);
    const result = await handler.execute(new GetTankBatchesQuery(tenantId, tankId));

    expect(result.tankId).toBe(tankId);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.speciesName).toBe('Salmon');
    expect(result.totalQuantity).toBe(1000);
    expect(result.currentBiomassKg).toBe(500);
    expect(mockManager.findOne).toHaveBeenNthCalledWith(1, expect.anything(), {
      where: { id: tankId, tenantId, isActive: true },
    });
  });

  it('throws NotFoundException when the tank does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetTankBatchesHandler(mockDataSource);

    await expect(
      handler.execute(new GetTankBatchesQuery(tenantId, tankId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
