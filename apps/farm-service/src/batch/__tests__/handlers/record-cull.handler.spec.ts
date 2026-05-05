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
  const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new RecordCullHandler(
      mockDataSource as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      mockOutboxPublisher as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';
  const CULLED_AT = new Date('2026-04-29T10:00:00.000Z');

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
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
      getCurrentAvgWeight: () => 50,
      getRetentionRate: () => 95,
    } as unknown as Batch;

    const tank = {
      id: 'tank-1',
      tenantId: TENANT,
      volume: 100,
      currentBiomass: 50,
      currentCount: 1000,
    };
    const tankBatch = {
      id: 'tank-batch-1',
      tenantId: TENANT,
      tankId: 'tank-1',
      primaryBatchId: 'batch-1',
      primaryBatchNumber: 'B-001',
      totalQuantity: 500,
      avgWeightG: 50,
      totalBiomassKg: 25,
      currentQuantity: 500,
      currentBiomassKg: 25,
      densityKgM3: 0.25,
      isMixedBatch: false,
      cleanerFishBiomassKg: 0,
      cleanerFishQuantity: 0,
      isOverCapacity: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      calculateDensity: jest.fn(),
      isEmpty: jest.fn(),
      canAddBatch: jest.fn(),
      hasCleanerFish: jest.fn(),
      getTotalBiomassIncludingCleanerFish: jest.fn(),
      getCleanerFishRatio: jest.fn(),
    } satisfies TankBatch;

    // findOne calls: batch, tank, tankBatch
    mockManager.findOne
      .mockResolvedValueOnce(batch)    // batch
      .mockResolvedValueOnce(tank)     // equipment (tank)
      .mockResolvedValueOnce(tankBatch); // tankBatch

    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    const result = await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
    }, USER));

    expect(result.currentQuantity).toBe(950);
    expect(result.cullCount).toBe(50);
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CullRecorded',
        tenantId: TENANT,
        batchId: 'batch-1',
        tankId: 'tank-1',
        quantity: 50,
      }),
      mockManager,
    );
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.SMALL_SIZE, culledAt: CULLED_AT,
      }, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
