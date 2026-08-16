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
import { TankBatchService } from '../../services/tank-batch.service';
import { TransferBatchCommand } from '../../commands/transfer-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Equipment, EquipmentStatus } from '../../../equipment/entities/equipment.entity';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { OutboxPublisher } from '@platform/outbox';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { TankCapacityService } from '../../../tank/services/tank-capacity.service';
import { TankAllocation } from '../../entities/tank-allocation.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { Tank } from '../../../tank/entities/tank.entity';

// FARM-HIGH-052: transfer is stock-mutating, so every command must carry the
// idempotency envelope or the handler rejects it as legacy.
const TRANSFER_ENVELOPE = { clientCommandId: 'cmd-t', payloadHash: 'hash-t' };

function mock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

describe('TransferBatchHandler', () => {
  let handler: TransferBatchHandler;
  let batchMutations: RecordingBatchAggregateMutationPort;
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
    batchMutations = new RecordingBatchAggregateMutationPort(mockManager);
    handler = new TransferBatchHandler(
      batchMutations,
      mockDataSource,
      createMockRepository<Batch>(),
      createMockRepository<TankAllocation>(),
      createMockRepository<TankOperation>(),
      createMockRepository<TankBatch>(),
      createMockRepository<Equipment>(),
      createMockRepository<Tank>(),
      createMockRepository<EquipmentType>(),
      mock<OutboxPublisher>(mockOutboxPublisher),
      // P-31 recalc — mocked (day-plan-recalc.service.spec kapsıyor).
      mock<DayPlanRecalcService>({ recalcForUnit: jest.fn().mockResolvedValue(null) }),
      // D-3 miktar çözümü — GERÇEK stateless politika (üretim davranışı).
      new RemovalQuantityPolicyService(),
      mock<TankCapacityService>(mockTankCapacityService),
      // SEC-HIGH-051: the real fail-closed SSoT; commands below pass
      // MODULE_MANAGER so site authz bypasses for these domain-logic tests.
      new SiteAuthorizationService(),
      // Use the production multi-unit lock + composition authority. This test
      // must fail if the handler returns to payload-ordered per-leg mutation.
      new TankBatchService(batchMutations),
      mock<FarmStockProjectionService>({
        refreshContainers: jest.fn().mockResolvedValue(undefined),
      }),
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

    const sourceTank = Object.assign(new Equipment(), {
      id: 'tank-1',
      tenantId: TENANT,
      code: 'T-001',
      name: 'Source Tank',
      status: EquipmentStatus.ACTIVE,
      volume: 100,
      currentBiomass: 25,
      currentCount: 500,
      hasCapacityFor: jest.fn().mockReturnValue(true),
    });
    const destTank = Object.assign(new Equipment(), {
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
    });
    const sourceTankBatch = Object.assign(new TankBatch(), {
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
    });
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
    mockManager.find.mockImplementation((entity: unknown) =>
      Promise.resolve(entity === TankBatch ? [sourceTankBatch] : []),
    );
    mockManager.save.mockImplementation((_entity: unknown, data: unknown) =>
      Promise.resolve(data),
    );

    mockTankCapacityService.calculate
      .mockReturnValueOnce({
        tankVolumeM3: 100,
        maxBiomassKg: 10000,
        maxDensityKgM3: 30,
        currentBiomassKg: 20,
        projectedBiomassKg: 20,
        projectedDensityKgM3: 0.2,
        utilizationPercent: 75,
        isOverDensity: false,
        isOverBiomass: false,
        isStatusBlocked: false,
        isOverCapacity: true,
        primaryBlockReason: 'status',
      })
      .mockReturnValueOnce({
        tankVolumeM3: 100,
        maxBiomassKg: 10000,
        maxDensityKgM3: 30,
        currentBiomassKg: 5,
        projectedBiomassKg: 5,
        projectedDensityKgM3: 0.05,
        utilizationPercent: 25,
        isOverDensity: false,
        isOverBiomass: false,
        isStatusBlocked: false,
        isOverCapacity: false,
        primaryBlockReason: null,
      });

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

    expect(mockManager.find).toHaveBeenCalledWith(
      TankBatch,
      expect.objectContaining({
        order: { tankId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(mockManager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tank-batch-mutation/v1:${TENANT}:tank-1`],
    );
    expect(mockManager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tank-batch-mutation/v1:${TENANT}:tank-2`],
    );
    expect(batchMutations.commitTankBatchTransition).toHaveBeenCalledTimes(2);
    expect(batchMutations.commitTankBatchTransition).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        intent: 'stock_transfer',
        aggregate: expect.objectContaining({
          tankId: 'tank-1',
          isOverCapacity: true,
          capacityUsedPercent: 75,
        }),
      }),
    );
    expect(batchMutations.commitTankBatchTransition).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        intent: 'stock_transfer',
        aggregate: expect.objectContaining({
          tankId: 'tank-2',
          isOverCapacity: false,
          capacityUsedPercent: 25,
        }),
      }),
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
