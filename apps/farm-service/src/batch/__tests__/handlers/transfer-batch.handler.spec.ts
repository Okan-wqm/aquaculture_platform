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

  // Outbox + capacity-service mocks. The capacity service is
  // hard-enforcing on the transfer target (phase 1.1) so a
  // resolved mock is the default; individual tests that want to
  // assert a capacity-block path can override the mock.
  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const mockTankCapacityService = {
    enforce: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Handler constructor order (phase-D + phase-1.1 final):
    //   dataSource, batchRepo, allocationRepo, operationRepo,
    //   tankBatchRepo, equipmentRepo, tankRepo, equipmentTypeRepo,
    //   outboxPublisher, tankCapacityService
    handler = new TransferBatchHandler(
      mockDataSource as any,
      createMockRepository() as any, // batchRepository
      createMockRepository() as any, // allocationRepository
      createMockRepository() as any, // operationRepository
      createMockRepository() as any, // tankBatchRepository
      createMockRepository() as any, // equipmentRepository
      createMockRepository() as any, // tankRepository
      createMockRepository() as any, // equipmentTypeRepository
      mockOutboxPublisher as any,
      mockTankCapacityService as any,
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

    // Equipment-shaped mocks. Handler routes through
    // `findTankOrEquipmentWithManager` which checks Equipment
    // first and wraps the match in `{ equipment, isFromTanksTable: false }`.
    const sourceTank = {
      id: 'tank-1',
      tenantId: TENANT,
      code: 'TANK-1',
      isActive: true,
      isDeleted: false,
    };
    const destTank = {
      id: 'tank-2',
      tenantId: TENANT,
      code: 'TANK-2',
      isActive: true,
      isDeleted: false,
      maxBiomass: 10000,
      volume: 100,
      currentBiomass: 0,
      currentCount: 0,
    };
    // TankBatch shape (phase-1 multi-batch refactor): handler
    // derives `availableQuantity` from
    //   primaryBatchId === batchId ? totalQuantity
    //                              : batchDetails[...].quantity
    const sourceTankBatch = {
      batchId: 'batch-1',
      tankId: 'tank-1',
      primaryBatchId: 'batch-1',
      totalQuantity: 500,
      batchDetails: [],
      avgWeightG: 50,
    };

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
