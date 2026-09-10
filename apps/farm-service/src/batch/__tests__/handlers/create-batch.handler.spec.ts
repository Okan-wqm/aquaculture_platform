/**
 * Create Batch Handler Unit Tests
 *
 * Verifies the current production contract: transactional batch creation,
 * tenant-scoped species lookup, generated batchNumber, and outbox enqueue.
 */
import { BadRequestException } from '@nestjs/common';
import { Batch, BatchInputType, BatchStatus } from '../../entities/batch.entity';
import { CreateBatchCommand, CreateBatchPayload } from '../../commands/create-batch.command';
import { CreateBatchHandler } from '../../handlers/create-batch.handler';
import { TankAllocation, AllocationType } from '../../entities/tank-allocation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import { CodeGeneratorService } from '../../../database/services/code-generator.service';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { ForbiddenException } from '@nestjs/common';
import { AuditLogService } from '../../../database/services/audit-log.service';
import { TankCapacityService } from '../../../tank/services/tank-capacity.service';
import { TankStockingService } from '../../services/tank-stocking.service';
import {
  createMockDataSource,
  createMockRepository,
  stub,
  collaborator,
  stubMember,
} from '@aquaculture/testing';
import type { TankBatchService } from '../../services/tank-batch.service';
import type { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import type { FinanceSettingsService } from '../../../finance/services/finance-settings.service';

describe('CreateBatchHandler', () => {
  let handler: CreateBatchHandler;

  /**
   * Stub the container lookup TankStockingService performs UNDER A LOCK, plus the
   * Department row its site resolution reads.
   *
   * FARM-HIGH-323 replaced the handler's unlocked bulk pre-fetch with a locked
   * `findOne` per tank, so a spec that stubs `find` no longer describes this path.
   */
  const stubContainerLookup = (
    equipment: Record<string, unknown>,
    department?: { siteId: string | null },
  ): void => {
    (mockManager.findOne as jest.Mock).mockImplementation((entity: unknown) => {
      const name = typeof entity === 'function' ? entity.name : String(entity);
      if (name === 'Equipment') return Promise.resolve(equipment);
      if (name === 'Department') {
        return Promise.resolve(department ? { id: 'dept-1', siteId: department.siteId } : null);
      }
      // No pre-existing composition on the tank.
      return Promise.resolve(null);
    });
  };

  /** The TankAllocation row the stocking path saved, if it got that far. */
  const savedAllocation = (): Record<string, unknown> | undefined => {
    for (const call of mockManager.save.mock.calls) {
      const candidate = (call.length > 1 ? call[1] : call[0]) as Record<string, unknown> | undefined;
      if (candidate && 'allocationType' in candidate) return candidate;
    }
    return undefined;
  };
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockBatchRepository = createMockRepository<Batch>();
  const mockDocumentRepository = createMockRepository();
  const mockSpeciesRepository = createMockRepository<Species>();
  const mockTankBatchRepository = createMockRepository();
  const mockEquipmentRepository = createMockRepository();
  const mockCodeGenerator = {
    generateCode: jest.fn(),
  } as unknown as jest.Mocked<CodeGeneratorService>;
  const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const mockFinanceSettings = stub<FinanceSettingsService>({
    getDefaultCurrency: jest.fn().mockResolvedValue('NOK'),
  });

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const createdBy = 'user-001';
  const payload: CreateBatchPayload = {
    name: 'Test Batch 2024',
    speciesId: 'species-456',
    inputType: BatchInputType.FRY,
    initialQuantity: 10000,
    initialAvgWeightG: 5,
    stockedAt: new Date('2024-01-15'),
    supplierId: 'supplier-001',
    purchaseCost: 0.5,
    currency: 'TRY',
    notes: 'Test batch',
  };

  const species = {
    id: payload.speciesId,
    tenantId,
    commonName: 'Rainbow Trout',
    growthParameters: { targetFCR: 1.2, avgDailyGrowth: 1.5 },
  } as Species;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeciesRepository.findOne.mockResolvedValue(species);
    mockCodeGenerator.generateCode.mockResolvedValue({
      code: 'B-2024-00042',
      sequence: 42,
      year: 2024,
    });
    const mockTankCapacityService = {
      enforce: jest.fn().mockReturnValue({
        projectedDensityKgM3: 1,
        utilizationPercent: 10,
        isOverCapacity: false,
        // The handler forwards this to applyBatchDelta as volumeM3; a missing
        // value would silently zero the density the service derives.
        tankVolumeM3: 50,
      }),
    };
    // Initial stocking routes tank composition through the single writer
    // (FARM-HIGH-139), so the spec supplies it rather than letting the handler
    // hand-mutate a row. The double returns the shape the handler reads back:
    // the derived totals it copies onto the container row.
    const applyBatchDelta = jest.fn().mockResolvedValue({
      totalQuantity: 1000,
      totalBiomassKg: 50,
    });
    const mockTankBatchService = collaborator<TankBatchService>(
      { applyBatchDelta: stubMember<TankBatchService['applyBatchDelta']>(applyBatchDelta) },
      'TankBatchService',
    );
    const refreshContainers = jest.fn().mockResolvedValue(undefined);
    const mockFarmStockProjection = collaborator<FarmStockProjectionService>(
      {
        refreshContainers:
          stubMember<FarmStockProjectionService['refreshContainers']>(refreshContainers),
      },
      'FarmStockProjectionService',
    );
    mockManager.save.mockImplementation((_entityClass: unknown, data: unknown) =>
      Promise.resolve({ id: 'batch-new-123', ...(data as object) }),
    );
    handler = new CreateBatchHandler(
      mockDataSource as any,
      mockBatchRepository,
      mockDocumentRepository as any,
      mockSpeciesRepository,
      mockTankBatchRepository as any,
      mockEquipmentRepository as any,
      mockCodeGenerator,
      mockOutboxPublisher as any,
      mockTankCapacityService as any,
      mockFinanceSettings,
      mockTankBatchService,
      // SEC-HIGH-167 / FARM-HIGH-323: the REAL stocking service, wired to this
      // spec's own mocks. Stubbing it would stub out the site gate these tests
      // exist to prove, so the assertions below run through the production path.
      new TankStockingService(
        mockTankCapacityService as Partial<TankCapacityService> as TankCapacityService,
        mockTankBatchService,
        new SiteAuthorizationService(),
        collaborator<AuditLogService>(
          { logWithManager: stubMember<AuditLogService['logWithManager']>(() => Promise.resolve()) },
          'AuditLogService',
        ),
      ),
      mockFarmStockProjection,
    );
  });

  it('creates a quarantine batch with generated batchNumber', async () => {
    const result = await handler.execute(
      new CreateBatchCommand(tenantId, payload, createdBy),
    );

    expect(result.id).toBe('batch-new-123');
    expect(result.batchNumber).toBe('B-2024-00042');
    expect(result.status).toBe(BatchStatus.QUARANTINE);
    expect(mockSpeciesRepository.findOne).toHaveBeenCalledWith({
      where: {
        id: payload.speciesId,
        tenantId,
        isActive: true,
        isDeleted: false,
      },
    });
    expect(mockCodeGenerator.generateCode).toHaveBeenCalledWith({
      prefix: 'B',
      tenantId,
      entityType: 'Batch',
    });
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('sets biomass, current quantity, and FCR target from species', async () => {
    await handler.execute(new CreateBatchCommand(tenantId, payload, createdBy));

    expect(mockManager.create).toHaveBeenCalledWith(
      Batch,
      expect.objectContaining({
        initialQuantity: payload.initialQuantity,
        currentQuantity: payload.initialQuantity,
        weight: expect.objectContaining({
          initial: expect.objectContaining({
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: 50,
          }),
          actual: expect.objectContaining({
            avgWeight: payload.initialAvgWeightG,
            totalBiomass: 50,
          }),
        }),
        fcr: expect.objectContaining({
          target: 1.2,
        }),
      }),
    );
  });

  it('enqueues BatchCreated event in the same transaction', async () => {
    await handler.execute(new CreateBatchCommand(tenantId, payload, createdBy));

    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BatchCreated',
        tenantId,
        userId: createdBy,
        batchId: 'batch-new-123',
        quantity: payload.initialQuantity,
      }),
      mockManager,
    );
  });

  it('throws BadRequestException when species is not active for tenant', async () => {
    mockSpeciesRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new CreateBatchCommand(tenantId, payload, createdBy)),
    ).rejects.toThrow(BadRequestException);

    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('validates initialQuantity is positive before database writes', async () => {
    await expect(
      handler.execute(
        new CreateBatchCommand(
          tenantId,
          { ...payload, initialQuantity: 0 },
          createdBy,
        ),
      ),
    ).rejects.toThrow('Initial quantity must be positive');

    expect(mockSpeciesRepository.findOne).not.toHaveBeenCalled();
  });

  it('validates initialAvgWeightG is positive before database writes', async () => {
    await expect(
      handler.execute(
        new CreateBatchCommand(
          tenantId,
          { ...payload, initialAvgWeightG: -5 },
          createdBy,
        ),
      ),
    ).rejects.toThrow('Initial average weight must be positive');

    expect(mockSpeciesRepository.findOne).not.toHaveBeenCalled();
  });

  it('writes an initial_stocking tank_allocations ledger row per initial location (FARM-HIGH-112)', async () => {
    const equipment: Partial<Equipment> = {
      id: 'tank-001',
      tenantId,
      code: 'TNK-2024-00001',
      name: 'Tank 1',
      currentBiomass: 0,
      currentCount: 0,
    };
    // FARM-HIGH-323: the container is now loaded with findOne UNDER A LOCK inside
    // TankStockingService, not by an unlocked bulk find before the loop.
    stubContainerLookup(equipment);

    await handler.execute(
      new CreateBatchCommand(
        tenantId,
        {
          ...payload,
          initialLocations: [
            { locationType: 'tank', tankId: 'tank-001', quantity: 1000, biomass: 50 },
          ],
        },
        createdBy,
        [Role.MODULE_MANAGER],
        [],
      ),
    );

    // The stocking must enter the allocation ledger — the ledger-reconcile
    // recomputes true counts from it, so a createBatch stocking with no
    // allocation row leaves an incomplete (unreconcilable) history.
    expect(savedAllocation()).toMatchObject({
      tenantId,
      tankId: 'tank-001',
      allocationType: AllocationType.INITIAL_STOCKING,
      quantity: 1000, // inflows are stored positive (signed convention)
      biomassKg: 50,
      allocatedBy: createdBy,
      isDeleted: false,
    });
  });

  /**
   * SEC-HIGH-167 — initial stocking is a site-scoped write.
   *
   * `initialLocations` is a required, min-1 field on the GraphQL input, so EVERY
   * createBatch stocks at least one tank. `AllocateToTankHandler` has asserted
   * site assignment since SEC-HIGH-051; this path asserted nothing, so a caller
   * barred from a site could stock its tanks by creating a batch instead of
   * allocating to one. The command carried no `userRoles`/`callerAssignedSiteIds`,
   * so the check could not even be written.
   *
   * The cases mirror `record-mortality.handler.spec.ts`, the established idiom for
   * a site-gated farm write.
   */
  describe('site authorization on initial stocking (SEC-HIGH-167)', () => {
    const SITE_A = 'site-aaaa';
    const SITE_B = 'site-bbbb';

    const stockingCommand = (userRoles: Role[], callerAssignedSiteIds: string[]) =>
      new CreateBatchCommand(
        tenantId,
        {
          ...payload,
          initialLocations: [
            { locationType: 'tank', tankId: 'tank-001', quantity: 1000, biomass: 50 },
          ],
        },
        createdBy,
        userRoles,
        callerAssignedSiteIds,
      );

    beforeEach(() => {
      stubContainerLookup(
        {
          id: 'tank-001',
          tenantId,
          code: 'TNK-2024-00001',
          name: 'Tank 1',
          currentBiomass: 0,
          currentCount: 0,
          departmentId: 'dept-1',
        },
        { siteId: SITE_A },
      );
    });

    it('refuses a MODULE_USER whose assigned sites do not include the tank site', async () => {
      await expect(handler.execute(stockingCommand([Role.MODULE_USER], [SITE_B]))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('writes nothing when the site gate refuses', async () => {
      // The gate runs before any stocking write, so a refused command must not
      // have left a ledger row behind.
      await expect(
        handler.execute(stockingCommand([Role.MODULE_USER], [SITE_B])),
      ).rejects.toThrow(ForbiddenException);

      expect(savedAllocation()).toBeUndefined();
    });

    it('allows a MODULE_USER assigned to the tank site', async () => {
      await expect(
        handler.execute(stockingCommand([Role.MODULE_USER], [SITE_A])),
      ).resolves.toBeDefined();

      expect(savedAllocation()).toMatchObject({ tankId: 'tank-001' });
    });

    it('allows a MODULE_MANAGER with no assigned sites (role hierarchy bypass)', async () => {
      await expect(handler.execute(stockingCommand([Role.MODULE_MANAGER], []))).resolves.toBeDefined();
    });

    it('fail-closes for a MODULE_USER when the tank site cannot be resolved', async () => {
      // A department with no site is never an implicit allow.
      stubContainerLookup(
        {
          id: 'tank-001',
          tenantId,
          code: 'TNK-2024-00001',
          name: 'Tank 1',
          currentBiomass: 0,
          currentCount: 0,
          departmentId: 'dept-1',
        },
        { siteId: null },
      );

      await expect(handler.execute(stockingCommand([Role.MODULE_USER], [SITE_A]))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('denies a MODULE_USER when a caller forgot to thread identity at all', async () => {
      // The command's `[]` defaults are fail-closed by design: a construction site
      // that omits identity must not be treated as an unrestricted caller.
      await expect(
        handler.execute(
          new CreateBatchCommand(tenantId, {
            ...payload,
            initialLocations: [
              { locationType: 'tank', tankId: 'tank-001', quantity: 1000, biomass: 50 },
            ],
          }, createdBy),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
