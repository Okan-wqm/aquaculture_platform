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
  // CapacityCalculation factory — keeps the mock realistic so the
  // handler can dereference `tankVolumeM3` / `projectedDensityKgM3` /
  // `isOverCapacity` / `utilizationPercent` etc. without NPE.
  const okCapacity = (
    overrides: Partial<{ isOverCapacity: boolean; primaryBlockReason: 'status' | 'biomass' | 'density' | null }> = {},
  ) => ({
    tankVolumeM3: 100,
    maxBiomassKg: 10_000,
    maxDensityKgM3: 30,
    currentBiomassKg: 0,
    projectedBiomassKg: 5,
    projectedDensityKgM3: 0.05,
    utilizationPercent: 0.17,
    isOverDensity: false,
    isOverBiomass: false,
    isStatusBlocked: false,
    isOverCapacity: false,
    primaryBlockReason: null,
    ...overrides,
  });
  const mockTankCapacityService = {
    enforce: jest.fn().mockReturnValue(okCapacity()),
    calculate: jest.fn().mockReturnValue(okCapacity()),
  };
  // Phase 1.1 final consolidation: when admin override allows an
  // over-capacity allocation, the handler writes a CAPACITY_BLOCKED
  // row through this service inside the same transaction.
  const mockAuditLogService = {
    logWithManager: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Handler constructor order (phase-D + phase-1.1 final):
    //   batchRepo, allocationRepo, tankBatchRepo, equipmentRepo,
    //   dataSource, outboxPublisher, tankCapacityService, auditLogService
    handler = new AllocateToTankHandler(
      createMockRepository() as any, // batchRepository
      createMockRepository() as any, // allocationRepository
      createMockRepository() as any, // tankBatchRepository
      createMockRepository() as any, // equipmentRepository
      mockDataSource as any,
      mockOutboxPublisher as any,
      mockTankCapacityService as any,
      mockAuditLogService as any,
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

  it('should write a CAPACITY_BLOCKED audit row when admin override allows over-capacity', async () => {
    // Phase 1.1 final consolidation: an admin allocation that the
    // service flagged isOverCapacity=true (i.e. enforce() did NOT throw
    // because callerRoles included SUPER_ADMIN) MUST persist an audit
    // row through the same transactional manager that wrote the
    // TankBatch — atomicity matters because a rollback that leaves the
    // audit row behind would record an event that didn't actually
    // happen.
    const batch = {
      id: 'batch-2', tenantId: TENANT, status: BatchStatus.ACTIVE,
      currentQuantity: 1000, isActive: true,
      isOperational: () => true,
    } as unknown as Batch;

    const tank = {
      id: 'tank-2', code: 'T-002', tenantId: TENANT, status: 'ACTIVE',
      maxBiomass: 5000, volume: 100, currentBiomass: 4900,
    };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(tank)
      .mockResolvedValueOnce(null) // existingTankBatch lookup #1
      .mockResolvedValueOnce(null); // tankBatch pessimistic lookup #2
    mockManager.save.mockImplementation((cls: any, data: any) =>
      Promise.resolve({ ...data, id: data?.id ?? 'tank-batch-1' }),
    );
    mockManager.create.mockImplementation((_cls: any, data: any) => data);
    mockQueryRunner.query.mockResolvedValue([{ total_quantity: 0, total_biomass: 0 }]);

    // Service permitted the allocation under admin override but flagged
    // it. The handler is expected to emit a CAPACITY_BLOCKED row with
    // the snapshot.
    mockTankCapacityService.enforce.mockReturnValueOnce(
      okCapacity({ isOverCapacity: true, primaryBlockReason: 'biomass' }),
    );

    await handler.execute(new AllocateToTankCommand(TENANT, 'batch-2', {
      tankId: 'tank-2', quantity: 100, avgWeightG: 50,
      allocationType: AllocationType.INITIAL_STOCKING,
    }, USER));

    expect(mockAuditLogService.logWithManager).toHaveBeenCalledTimes(1);
    const [calledManager, params] = mockAuditLogService.logWithManager.mock.calls[0];
    expect(calledManager).toBe(mockManager);
    expect(params.action).toBe('CAPACITY_BLOCKED');
    expect(params.entityType).toBe('TankBatch');
    expect(params.userId).toBe(USER);
    expect(params.changes?.after).toMatchObject({
      tankId: 'tank-2',
      batchId: 'batch-2',
      primaryBlockReason: 'biomass',
      isOverBiomass: false, // mock overrides only what we passed
    });
  });

  it('should NOT write a CAPACITY_BLOCKED audit row when capacity is OK', async () => {
    const batch = {
      id: 'batch-3', tenantId: TENANT, status: BatchStatus.ACTIVE,
      currentQuantity: 1000, isActive: true,
      isOperational: () => true,
    } as unknown as Batch;
    const tank = { id: 'tank-3', code: 'T-003', tenantId: TENANT, status: 'ACTIVE', maxBiomass: 10000, volume: 100 };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(tank)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));
    mockManager.create.mockImplementation((_cls: any, data: any) => data);

    await handler.execute(new AllocateToTankCommand(TENANT, 'batch-3', {
      tankId: 'tank-3', quantity: 100, avgWeightG: 50,
      allocationType: AllocationType.INITIAL_STOCKING,
    }, USER));

    expect(mockAuditLogService.logWithManager).not.toHaveBeenCalled();
  });
});
