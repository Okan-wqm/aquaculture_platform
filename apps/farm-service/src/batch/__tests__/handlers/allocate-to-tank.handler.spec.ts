/**
 * AllocateToTankHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — tank allocation with capacity check.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AllocateToTankHandler } from '../../handlers/allocate-to-tank.handler';
import { AllocateToTankCommand, AllocationType } from '../../commands/allocate-to-tank.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

describe('AllocateToTankHandler', () => {
  let handler: AllocateToTankHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  // Mocks for the two services the handler depends on. The
  // outbox publisher is invoked inside the cascade's transaction;
  // the capacity service guards the tank-allocation invariant
  // (density + biomass) that phase 1.1 made hard-enforcing.
  const mockOutboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const mockTankCapacityService = {
    enforce: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Handler constructor order (phase-D + phase-1.1 final):
    //   batchRepo, allocationRepo, tankBatchRepo, equipmentRepo,
    //   dataSource, outboxPublisher, tankCapacityService
    handler = new AllocateToTankHandler(
      createMockRepository() as any, // batchRepository
      createMockRepository() as any, // allocationRepository
      createMockRepository() as any, // tankBatchRepository
      createMockRepository() as any, // equipmentRepository
      mockDataSource as any,
      mockOutboxPublisher as any,
      mockTankCapacityService as any,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new AllocateToTankCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 100, avgWeightG: 50,
        allocationType: AllocationType.INITIAL_STOCKING,
      }, USER)),
    ).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should allocate batch to tank on success', async () => {
    const batch = {
      id: 'batch-1', tenantId: TENANT, status: BatchStatus.ACTIVE,
      currentQuantity: 5000, isActive: true,
      isOperational: () => true,
    } as unknown as Batch;

    const tank = {
      id: 'tank-1', tenantId: TENANT, status: 'ACTIVE',
      maxBiomass: 10000, volume: 100,
    };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(tank);
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));
    mockQueryRunner.query.mockResolvedValue([{ total_quantity: 0, total_biomass: 0 }]);

    await handler.execute(new AllocateToTankCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 100, avgWeightG: 50,
      allocationType: AllocationType.INITIAL_STOCKING,
    }, USER));

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      handler.execute(new AllocateToTankCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 100, avgWeightG: 50,
        allocationType: AllocationType.INITIAL_STOCKING,
      }, USER)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
