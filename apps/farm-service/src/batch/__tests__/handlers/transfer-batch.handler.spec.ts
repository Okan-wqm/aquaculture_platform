/**
 * TransferBatchHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — batch transfer between tanks.
 */
import { NotFoundException } from '@nestjs/common';
import { TransferBatchHandler } from '../../handlers/transfer-batch.handler';
import { TransferBatchCommand } from '../../commands/transfer-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

describe('TransferBatchHandler', () => {
  let handler: TransferBatchHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new TransferBatchHandler(
      mockDataSource as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new TransferBatchCommand(TENANT, 'batch-1', {
        sourceTankId: 'tank-1', destinationTankId: 'tank-2',
        quantity: 100,
      }, USER)),
    ).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should transfer batch between tanks', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING,
      currentQuantity: 5000, isActive: true,
      isOperational: () => true,
    } as unknown as Batch;

    const sourceTank = { id: 'tank-1', tenantId: TENANT };
    const destTank = { id: 'tank-2', tenantId: TENANT, maxBiomass: 10000, volume: 100 };
    const sourceTankBatch = { batchId: 'batch-1', tankId: 'tank-1', currentQuantity: 500 };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(sourceTank)
      .mockResolvedValueOnce(destTank)
      .mockResolvedValueOnce(sourceTankBatch);
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));
    mockQueryRunner.query.mockResolvedValue([{ total_quantity: 0, total_biomass: 0 }]);

    await handler.execute(new TransferBatchCommand(TENANT, 'batch-1', {
      sourceTankId: 'tank-1', destinationTankId: 'tank-2',
      quantity: 100,
    }, USER));

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('deadlock'));

    await expect(
      handler.execute(new TransferBatchCommand(TENANT, 'batch-1', {
        sourceTankId: 'tank-1', destinationTankId: 'tank-2',
        quantity: 100,
      }, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
