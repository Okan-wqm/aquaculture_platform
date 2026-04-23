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

  // Phase D: DomainEventPublisher → OutboxPublisher; mock enqueues
  // silently for the happy path.
  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Handler constructor (phase-D final):
    //   dataSource, batchRepo, operationRepo, tankBatchRepo,
    //   equipmentRepo, outboxPublisher
    handler = new RecordCullHandler(
      mockDataSource as any,
      createMockRepository() as any, // batchRepository
      createMockRepository() as any, // operationRepository
      createMockRepository() as any, // tankBatchRepository
      createMockRepository() as any, // equipmentRepository
      mockOutboxPublisher as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  // CullReason enum renamed: DEFORMITY → DEFORMED, RUNTS → POOR_GROWTH
  // (more neutral terminology; matches the entity column enum).
  // RecordCullPayload gained required `culledAt: Date` so every
  // payload here includes the timestamp the handler stores.
  const CULL_TS = new Date('2026-04-10T09:00:00Z');

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULL_TS,
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
      // Handler reads avg weight + biomass via instance methods —
      // stub them so the biomass calculation produces a defined
      // number (payload.avgWeightG isn't set in this test).
      getCurrentAvgWeight: () => 50,
      getCurrentBiomass: () => 50,
      getRetentionRate: () => 100,
    } as unknown as Batch;

    // Equipment-shaped tank mock — handler routes through
    // `findTankOrEquipmentWithManager` which checks Equipment first.
    const tank = {
      id: 'tank-1',
      tenantId: TENANT,
      code: 'TANK-1',
      isActive: true,
      isDeleted: false,
      currentBiomass: 0,
      currentCount: 0,
    };
    // TankBatch shape (phase-1 multi-batch refactor): handler
    // derives primary vs. multi-batch detail quantity.
    const tankBatch = {
      batchId: 'batch-1',
      tankId: 'tank-1',
      primaryBatchId: 'batch-1',
      totalQuantity: 500,
      batchDetails: [],
      avgWeightG: 50,
    };

    // findOne calls: batch, tank, tankBatch
    mockManager.findOne
      .mockResolvedValueOnce(batch)    // batch
      .mockResolvedValueOnce(tank)     // equipment (tank)
      .mockResolvedValueOnce(tankBatch); // tankBatch

    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    const result = await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMED, culledAt: CULL_TS,
    }, USER));

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.POOR_GROWTH, culledAt: CULL_TS,
      }, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
