/**
 * RecordCullHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — cull recording with quantity validation.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RecordCullHandler } from '../../handlers/record-cull.handler';
import { RecordCullCommand, CullReason } from '../../commands/record-cull.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

describe('RecordCullHandler', () => {
  let handler: RecordCullHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new RecordCullHandler(
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
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMITY,
      }, USER)),
    ).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should record cull and decrease currentQuantity', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING,
      currentQuantity: 1000, cullCount: 0, isActive: true,
      isOperational: () => true,
    } as unknown as Batch;

    const tank = { id: 'tank-1', tenantId: TENANT };
    const tankBatch = { batchId: 'batch-1', tankId: 'tank-1', currentQuantity: 500 };

    // findOne calls: batch, tank, tankBatch
    mockManager.findOne
      .mockResolvedValueOnce(batch)    // batch
      .mockResolvedValueOnce(tank)     // equipment (tank)
      .mockResolvedValueOnce(tankBatch); // tankBatch

    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    const result = await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMITY,
    }, USER));

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.RUNTS,
      }, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
