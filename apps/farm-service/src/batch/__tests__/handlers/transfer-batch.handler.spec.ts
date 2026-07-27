/**
 * TransferBatchHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — batch transfer between tanks.
 */
import { NotFoundException } from '@nestjs/common';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { TransferBatchHandler } from '../../handlers/transfer-batch.handler';
import { RemovalQuantityPolicyService } from '../../services/removal-quantity-policy.service';
import { TransferBatchCommand } from '../../commands/transfer-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Equipment, EquipmentStatus } from '../../../equipment/entities/equipment.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

// FARM-HIGH-052: transfer is stock-mutating, so every command must carry the
// idempotency envelope or the handler rejects it as legacy.
const TRANSFER_ENVELOPE = { clientCommandId: 'cmd-t', payloadHash: 'hash-t' };

describe('TransferBatchHandler', () => {
  let handler: TransferBatchHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const mockTankCapacityService = {
    enforce: jest.fn().mockReturnValue({
      tankVolumeM3: 100,
      projectedDensityKgM3: 1,
      utilizationPercent: 10,
      isOverCapacity: false,
    }),
    calculate: jest.fn().mockReturnValue({
      tankVolumeM3: 100,
      maxBiomassKg: 10000,
      maxDensityKgM3: 30,
      currentBiomassKg: 0,
      projectedBiomassKg: 5,
      projectedDensityKgM3: 0.05,
      utilizationPercent: 1,
      isOverDensity: false,
      isOverBiomass: false,
      isStatusBlocked: false,
      isOverCapacity: false,
      primaryBlockReason: null,
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // The shared mock EntityManager lacks query() wired — MobileCommandReceiptService
    // needs it for begin()/complete(). EntityManager.query exists on the type.
    mockManager.query = jest.fn().mockResolvedValue([{ id: 'receipt-t' }]);
    handler = new TransferBatchHandler(
      mockDataSource as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      createMockRepository() as any,
      mockOutboxPublisher as any,
      // P-31 recalc — mocked (day-plan-recalc.service.spec kapsıyor).
      // Çoklu ünite recalc'ı unitId-SIRALI olarak servis tarafından yürütülür
      // (FARM-MEDIUM-275) — handler artık tek çağrı yapar.
      {
        recalcForUnit: jest.fn().mockResolvedValue(null),
        recalcForUnits: jest.fn().mockResolvedValue([]),
      } as never,
      // D-3 miktar çözümü — GERÇEK stateless politika (üretim davranışı).
      new RemovalQuantityPolicyService(),
      mockTankCapacityService as any,
      // SEC-HIGH-051: the real fail-closed SSoT; commands below pass
      // MODULE_MANAGER so site authz bypasses for these domain-logic tests.
      new SiteAuthorizationService(),
      // TankBatchService SSoT writer — mocked (covered by tank-batch.service.spec).
      {
        applyBatchDelta: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ totalBiomassKg: 0, cleanerFishBiomassKg: 0 }),
          ),
      } as never,
      {
        refreshContainers: jest.fn().mockResolvedValue(undefined),
      } as Partial<FarmStockProjectionService> as FarmStockProjectionService,
      new MobileCommandReceiptService(),
    );
  });

  const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER = 'user-1';

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(
        new TransferBatchCommand(
          TENANT,
          'batch-1',
          {
            sourceTankId: 'tank-1',
            destinationTankId: 'tank-2',
            quantity: 100,
          },
          USER,
          [Role.MODULE_MANAGER],
          [],
          TRANSFER_ENVELOPE,
        ),
      ),
    ).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should transfer batch between tanks', async () => {
    const batch = {
      id: 'batch-1',
      tenantId: TENANT,
      status: BatchStatus.GROWING,
      batchNumber: 'B-001',
      currentQuantity: 5000,
      isActive: true,
      isOperational: () => true,
      getCurrentAvgWeight: () => 50,
    } as unknown as Batch;

    const sourceTank = {
      id: 'tank-1',
      tenantId: TENANT,
      code: 'T-001',
      name: 'Source Tank',
      status: EquipmentStatus.ACTIVE,
      volume: 100,
      currentBiomass: 25,
      currentCount: 500,
      hasCapacityFor: jest.fn().mockReturnValue(true),
    } as unknown as Equipment;
    const destTank = {
      id: 'tank-2',
      tenantId: TENANT,
      code: 'T-002',
      name: 'Destination Tank',
      status: EquipmentStatus.ACTIVE,
      volume: 100,
      currentBiomass: 0,
      currentCount: 0,
      hasCapacityFor: jest.fn().mockReturnValue(true),
      specifications: { maxDensity: 30 },
    } as unknown as Equipment;
    const sourceTankBatch = {
      id: 'source-tank-batch',
      tenantId: TENANT,
      tankId: 'tank-1',
      primaryBatchId: 'batch-1',
      primaryBatchNumber: 'B-001',
      totalQuantity: 500,
      totalBiomassKg: 25,
      currentBiomassKg: 25,
      avgWeightG: 50,
      densityKgM3: 0.25,
      isMixedBatch: false,
      cleanerFishBiomassKg: 0,
      cleanerFishQuantity: 0,
      isOverCapacity: false,
    } as TankBatch;
    const destTankBatch = null;

    mockManager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: { id?: string; tankId?: string } } | undefined)?.where;
      if (entity === Batch) return Promise.resolve(batch);
      if (entity === Equipment && where?.id === 'tank-1') return Promise.resolve(sourceTank);
      if (entity === Equipment && where?.id === 'tank-2') return Promise.resolve(destTank);
      if (entity === TankBatch && where?.tankId === 'tank-1')
        return Promise.resolve(sourceTankBatch);
      if (entity === TankBatch && where?.tankId === 'tank-2') return Promise.resolve(destTankBatch);
      return Promise.resolve(null);
    });
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    await handler.execute(
      new TransferBatchCommand(
        TENANT,
        'batch-1',
        {
          sourceTankId: 'tank-1',
          destinationTankId: 'tank-2',
          quantity: 100,
        },
        USER,
        [Role.MODULE_MANAGER],
        [],
        TRANSFER_ENVELOPE,
      ),
    );

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BatchTransferred',
        tenantId: TENANT,
        batchId: 'batch-1',
        sourceTankId: 'tank-1',
        destinationTankId: 'tank-2',
        quantity: 100,
      }),
      mockManager,
    );
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('refuses an over-capacity transfer with no way for the caller to opt out', async () => {
    // FARM-HIGH-302: the enforce() call used to sit behind a caller-supplied
    // `skipCapacityCheck` Boolean on the public mutation input — no role floor,
    // no reason, no audit row, reachable by any MODULE_USER. That the field can
    // no longer be sent is proven by the schema diff and by compilation; what
    // this case pins is the other half — the check itself is unconditional, so
    // a full destination tank fails the transfer and rolls it back.
    //
    // MODULE_MANAGER, not MODULE_USER: SiteAuthorizationService refuses a
    // MODULE_USER with no assigned sites before the capacity check is reached,
    // which would make this test pass for the wrong reason.
    // Real entity instances rather than a double cast: the banned-construct
    // gate forbids that construct, and assigning onto a real entity keeps the
    // fixture honest about the shape the handler actually receives.
    const batch = Object.assign(new Batch(), {
      id: 'batch-1',
      tenantId: TENANT,
      status: BatchStatus.GROWING,
      batchNumber: 'B-001',
      currentQuantity: 5000,
      isActive: true,
      isOperational: () => true,
      getCurrentAvgWeight: () => 50,
    });
    const tank = (id: string, biomass: number): Equipment =>
      Object.assign(new Equipment(), {
        id,
        tenantId: TENANT,
        code: id,
        name: id,
        status: EquipmentStatus.ACTIVE,
        volume: 100,
        currentBiomass: biomass,
        currentCount: 0,
        hasCapacityFor: jest.fn().mockReturnValue(true),
        specifications: { maxDensity: 30 },
      });

    mockManager.findOne.mockImplementation((entity: unknown, options?: unknown) => {
      const where = (options as { where?: { id?: string; tankId?: string } } | undefined)?.where;
      if (entity === Batch) return Promise.resolve(batch);
      if (entity === Equipment && where?.id === 'tank-1')
        return Promise.resolve(tank('tank-1', 25));
      if (entity === Equipment && where?.id === 'tank-2')
        return Promise.resolve(tank('tank-2', 9999));
      if (entity === TankBatch && where?.tankId === 'tank-1')
        return Promise.resolve(
          Object.assign(new TankBatch(), {
            id: 'source-tank-batch',
            tenantId: TENANT,
            tankId: 'tank-1',
            primaryBatchId: 'batch-1',
            primaryBatchNumber: 'B-001',
            totalQuantity: 500,
            totalBiomassKg: 25,
            currentBiomassKg: 25,
            avgWeightG: 50,
            densityKgM3: 0.25,
            isMixedBatch: false,
            cleanerFishBiomassKg: 0,
            cleanerFishQuantity: 0,
            isOverCapacity: false,
          }),
        );
      return Promise.resolve(null);
    });
    mockManager.save.mockImplementation((_cls: unknown, data: unknown) => Promise.resolve(data));

    const capacityRefusal = new Error('destination tank is over capacity');
    mockTankCapacityService.enforce.mockImplementationOnce(() => {
      throw capacityRefusal;
    });

    await expect(
      handler.execute(
        new TransferBatchCommand(
          TENANT,
          'batch-1',
          { sourceTankId: 'tank-1', destinationTankId: 'tank-2', quantity: 100 },
          USER,
          [Role.MODULE_MANAGER],
          [],
          TRANSFER_ENVELOPE,
        ),
      ),
    ).rejects.toThrow(capacityRefusal);

    expect(mockTankCapacityService.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'hard' }),
    );
    expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('deadlock'));

    await expect(
      handler.execute(
        new TransferBatchCommand(
          TENANT,
          'batch-1',
          {
            sourceTankId: 'tank-1',
            destinationTankId: 'tank-2',
            quantity: 100,
          },
          USER,
          [Role.MODULE_MANAGER],
          [],
          TRANSFER_ENVELOPE,
        ),
      ),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
