/**
 * AllocateToTankHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — tank allocation with capacity check.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { AllocateToTankHandler } from '../../handlers/allocate-to-tank.handler';
import { AllocateToTankCommand, AllocationType } from '../../commands/allocate-to-tank.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { EquipmentStatus } from '../../../equipment/entities/equipment.entity';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

import { createStockChangeDouble, type StockChangeDouble } from '../support/stock-change-double';

describe('AllocateToTankHandler', () => {
  let handler: AllocateToTankHandler;
  let stockChange: StockChangeDouble;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const mockAuditLogService = { logWithManager: jest.fn().mockResolvedValue(undefined) };
  const mockTankCapacityService = {
    enforce: jest.fn().mockReturnValue({
      tankVolumeM3: 100,
      projectedDensityKgM3: 1,
      utilizationPercent: 10,
      isOverCapacity: false,
    }),
  };

  const saveEntity = (entityOrClass: any, data?: any, fallbackId = 'saved-allocation') => {
    const entity = data ?? entityOrClass;
    if (entity && typeof entity === 'object') {
      return Promise.resolve({ ...entity, id: entity.id ?? fallbackId });
    }
    return Promise.resolve(entity);
  };

  const okCapacity = (
    overrides: Partial<ReturnType<typeof mockTankCapacityService.enforce>> = {},
  ) => ({
    tankVolumeM3: 100,
    maxBiomassKg: 10000,
    maxDensityKgM3: 30,
    currentBiomassKg: 0,
    projectedBiomassKg: 100,
    projectedDensityKgM3: 1,
    utilizationPercent: 10,
    isOverDensity: false,
    isOverBiomass: false,
    isStatusBlocked: false,
    isOverCapacity: false,
    primaryBlockReason: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stockChange = createStockChangeDouble({
      id: 'tankbatch-1',
      totalQuantity: 10,
      totalBiomassKg: 100,
      batchDetails: [],
    });
    mockManager.create.mockImplementation(((_cls: unknown, data: unknown) => data) as never);
    mockManager.save.mockImplementation(
      ((_cls: unknown, data: { id?: string } | undefined): Promise<{ id: string }> =>
        Promise.resolve({ ...(data ?? {}), id: data?.id ?? 'saved-allocation' })) as never,
    );
    handler = new AllocateToTankHandler(
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      mockDataSource as any,
      mockOutboxPublisher as any,
      mockTankCapacityService as any,
      mockAuditLogService as any,
      // SEC-HIGH-051: the real fail-closed SSoT; the commands below pass
      // MODULE_MANAGER so site authz bypasses for these domain-logic tests.
      new SiteAuthorizationService(),
      // SSoT tank-composition writer, entered through the stock scope; returns
      // the derived TankBatch row so the canonical-container update +
      // capacity-flag write + audit can proceed. Stocking now ALSO reprices the
      // day's remaining meals — that settlement belongs to the scope (proved in
      // tank-batch.service.spec), and this handler cannot write stock outside it.
      stockChange.tankBatchService,
      // Working no-op DI deps (the throwing direct-handler defaults are
      // test-only and would abort begin()/refreshContainers() before assertions).
      ({ refreshContainers: jest.fn().mockResolvedValue(undefined) }) as Partial<FarmStockProjectionService> as FarmStockProjectionService,
      ({
        begin: jest.fn().mockResolvedValue({ mode: 'execute' }),
        complete: jest.fn().mockResolvedValue(undefined),
      }) as Partial<MobileCommandReceiptService> as MobileCommandReceiptService,
    );
  });

  const TENANT = 'tenant-1';
  const USER = 'user-1';

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(
        new AllocateToTankCommand(
          TENANT,
          'batch-1',
          {
            tankId: 'tank-1',
            quantity: 100,
            avgWeightG: 50,
            allocationType: AllocationType.INITIAL_STOCKING,
          },
          USER,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    ).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should allocate batch to tank on success', async () => {
    const batch = {
      id: 'batch-1',
      tenantId: TENANT,
      status: BatchStatus.ACTIVE,
      currentQuantity: 5000,
      isActive: true,
      isOperational: () => true,
    } as unknown as Batch;

    const equipment = {
      id: 'tank-1',
      tenantId: TENANT,
      code: 'T-001',
      name: 'Tank 001',
      status: EquipmentStatus.ACTIVE,
      currentBiomass: 0,
      currentCount: 0,
      volume: 100,
      specifications: { maxBiomass: 10000, maxDensity: 30, volume: 100 },
      hasCapacityFor: jest.fn().mockReturnValue(true),
    };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(equipment)
      .mockResolvedValueOnce(null);
    mockManager.save.mockImplementation(((entityOrClass: any, data?: any) =>
      saveEntity(entityOrClass, data)) as never);
    mockQueryRunner.query.mockResolvedValue([{ total_quantity: 0, total_biomass: 0 }]);

    await handler.execute(
      new AllocateToTankCommand(
        TENANT,
        'batch-1',
        {
          tankId: 'tank-1',
          quantity: 100,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
        },
        USER,
        [Role.MODULE_MANAGER],
        [],
      ),
    );

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      handler.execute(
        new AllocateToTankCommand(
          TENANT,
          'batch-1',
          {
            tankId: 'tank-1',
            quantity: 100,
            avgWeightG: 50,
            allocationType: AllocationType.INITIAL_STOCKING,
          },
          USER,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
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
      id: 'batch-2',
      tenantId: TENANT,
      status: BatchStatus.ACTIVE,
      currentQuantity: 1000,
      isActive: true,
      isOperational: () => true,
    } as unknown as Batch;

    const tank = {
      id: 'tank-2',
      code: 'T-002',
      tenantId: TENANT,
      status: 'ACTIVE',
      maxBiomass: 5000,
      volume: 100,
      currentBiomass: 4900,
    };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(tank)
      // Only the existingTankBatch (capacity) lookup remains; the composition
      // read+write now lives inside the mocked stock scope.
      .mockResolvedValueOnce(null);
    mockManager.save.mockImplementation(((entityOrClass: any, data?: any) =>
      saveEntity(entityOrClass, data, 'tank-batch-1')) as never);
    mockManager.create.mockImplementation((_cls: any, data: any) => data);
    mockQueryRunner.query.mockResolvedValue([{ total_quantity: 0, total_biomass: 0 }]);

    // Service permitted the allocation under admin override but flagged
    // it. The handler is expected to emit a CAPACITY_BLOCKED row with
    // the snapshot.
    mockTankCapacityService.enforce.mockReturnValueOnce(
      okCapacity({ isOverCapacity: true, primaryBlockReason: 'biomass' }),
    );

    await handler.execute(
      new AllocateToTankCommand(
        TENANT,
        'batch-2',
        {
          tankId: 'tank-2',
          quantity: 100,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
        },
        USER,
        [Role.MODULE_MANAGER],
        [],
      ),
    );

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
      id: 'batch-3',
      tenantId: TENANT,
      status: BatchStatus.ACTIVE,
      currentQuantity: 1000,
      isActive: true,
      isOperational: () => true,
    } as unknown as Batch;
    const tank = {
      id: 'tank-3',
      code: 'T-003',
      tenantId: TENANT,
      status: 'ACTIVE',
      maxBiomass: 10000,
      volume: 100,
    };

    mockManager.findOne
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(tank)
      .mockResolvedValueOnce(null);
    mockManager.save.mockImplementation(((entityOrClass: any, data?: any) =>
      saveEntity(entityOrClass, data)) as never);
    mockManager.create.mockImplementation((_cls: any, data: any) => data);

    await handler.execute(
      new AllocateToTankCommand(
        TENANT,
        'batch-3',
        {
          tankId: 'tank-3',
          quantity: 100,
          avgWeightG: 50,
          allocationType: AllocationType.INITIAL_STOCKING,
        },
        USER,
        [Role.MODULE_MANAGER],
        [],
      ),
    );

    expect(mockAuditLogService.logWithManager).not.toHaveBeenCalled();
  });
});
