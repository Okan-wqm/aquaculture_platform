/**
 * RecordMortalityHandler Unit Tests
 *
 * Tests business logic of mortality recording: quantity validation,
 * batch/tank metrics update, and transactional outbox enqueue.
 *
 * Architecture: direct instantiation (no TestingModule) — handler uses DataSource
 * for pessimistic-lock transactions so we mock DataSource + queryRunner following
 * the pattern established in race-conditions.spec.ts.
 *
 * @module Batch/Tests
 */
import { NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { DataSource, Repository, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { AuditLogService } from '../../../database/services/audit-log.service';
import { MortalityCullPolicyService } from '../../services/mortality-cull-policy.service';
import { RemovalQuantityPolicyService } from '../../services/removal-quantity-policy.service';
import { RecordMortalityHandler } from '../../handlers/record-mortality.handler';
import { RecordMortalityCommand, MortalityReason } from '../../commands/record-mortality.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { MortalityRecord } from '../../entities/mortality-record.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
import { Department } from '../../../department/entities/department.entity';

const ENVELOPE = { clientCommandId: 'cmd-1', payloadHash: 'hash-1' };

// ============================================================================
// Mock helpers (shared with race-conditions.spec.ts pattern)
// ============================================================================

interface MockManager {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  query: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function createMockManager(): MockManager {
  return {
    findOne: jest.fn(),
    create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => data),
    save: jest.fn().mockImplementation((_entity: unknown, data: unknown) => Promise.resolve(data)),
    // MobileCommandReceiptService.begin: with an envelope the INSERT returns a
    // receipt id (started mode). complete() UPDATE returns nothing.
    query: jest.fn().mockResolvedValue([{ id: 'receipt-1' }]),
    // biomass-only column write: `.createQueryBuilder().update().set().where().execute()`.
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
      qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
      return qb;
    }),
  };
}

function createMockQueryRunner(manager: MockManager) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    // runInTenantTransaction pins search_path + asserts the RLS GUC via
    // queryRunner.query (distinct from the receipt service's manager.query).
    // Returning [] makes the boundary readback assertion skip (no live DB).
    query: jest.fn().mockResolvedValue([]),
    manager: manager as unknown as EntityManager,
  };
}

function createMockDataSource(queryRunner: ReturnType<typeof createMockQueryRunner>): DataSource {
  return {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  } as unknown as DataSource;
}

function createMockOutboxPublisher(): OutboxPublisher {
  return { enqueue: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxPublisher;
}

// ============================================================================
// Tests
// ============================================================================

describe('RecordMortalityHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const batchId = 'batch-456';
  const tankId = 'tank-789';

  function makeBatch(overrides: Partial<Batch> = {}): Partial<Batch> {
    return {
      id: batchId,
      tenantId,
      batchNumber: 'B-001',
      isActive: true,
      initialQuantity: 100_000,
      currentQuantity: 10_000,
      totalMortality: 0,
      cullCount: 0,
      status: BatchStatus.ACTIVE,
      mortalitySummary: {
        totalMortality: 0,
        mortalityRate: 0,
      },
      isOperational: jest.fn().mockReturnValue(true),
      isStockMutable: jest.fn().mockReturnValue(true),
      getCurrentAvgWeight: jest.fn().mockReturnValue(200),
      getMortalityRate: jest.fn().mockReturnValue(0),
      getRetentionRate: jest.fn().mockReturnValue(100),
      ...overrides,
    };
  }

  function makeTankBatch(overrides: Partial<TankBatch> = {}): Partial<TankBatch> {
    return {
      tenantId,
      tankId,
      // assertBatchInTank requires the batch to be held in this tank
      primaryBatchId: batchId,
      totalQuantity: 10_000,
      totalBiomassKg: 2_000,
      densityKgM3: 2,
      ...overrides,
    };
  }

  function makeEquipment(overrides: Partial<Equipment> = {}): Partial<Equipment> {
    return {
      id: tankId,
      tenantId,
      isActive: true,
      volume: 1_000,
      currentBiomass: 2_000,
      currentCount: 10_000,
      ...overrides,
    };
  }

  function makeCommand(quantity = 50, overrides: Partial<{
    reason: MortalityReason;
    observedAt: Date;
    avgWeightG: number;
    envelope: { clientCommandId: string; payloadHash: string } | undefined;
    // SEC-HIGH-051: domain-logic tests default to a MODULE_MANAGER so site authz
    // bypasses via the canonical hierarchy; the dedicated site-authz suite below
    // exercises the MODULE_USER deny/allow paths explicitly.
    userRoles: Role[];
    callerAssignedSiteIds: string[];
  }> = {}) {
    return new RecordMortalityCommand(
      tenantId,
      batchId,
      {
        tankId,
        quantity,
        reason: overrides.reason ?? MortalityReason.DISEASE,
        observedAt: overrides.observedAt ?? new Date(),
        avgWeightG: overrides.avgWeightG,
      },
      'user-001',
      overrides.userRoles ?? [Role.MODULE_MANAGER],
      overrides.callerAssignedSiteIds ?? [],
      'envelope' in overrides ? overrides.envelope : ENVELOPE,
    );
  }

  function buildHandler(
    managerOverride?: Partial<MockManager>,
    outboxPublisherOverride?: OutboxPublisher,
  ) {
    const manager = { ...createMockManager(), ...managerOverride };
    const queryRunner = createMockQueryRunner(manager);
    const dataSource = createMockDataSource(queryRunner);
    const outboxPublisher = outboxPublisherOverride ?? createMockOutboxPublisher();
    const backdatePolicy = {
      validate: jest.fn().mockReturnValue({
        backdatedDays: 0,
        limitDays: 14,
        isBackdated: false,
      }),
    };
    const auditLogService = {
      logWithManager: jest.fn().mockResolvedValue({}),
    } as Partial<AuditLogService> as AuditLogService;
    // Real receipt service drives begin()/complete() against manager.query;
    // a no-op projection avoids the throwing direct-handler default.
    const mobileCommandReceipts = new MobileCommandReceiptService();
    const farmStockProjection = {
      refreshContainers: jest.fn().mockResolvedValue(undefined),
    } as Partial<FarmStockProjectionService> as FarmStockProjectionService;

    const handler = new RecordMortalityHandler(
      dataSource,
      {} as Repository<Batch>,
      {} as Repository<MortalityRecord>,
      {} as Repository<TankOperation>,
      {} as Repository<TankBatch>,
      {} as Repository<Equipment>,
      {} as Repository<Tank>,
      {} as Repository<EquipmentType>,
      outboxPublisher,
      // P-31 recalc — mocked (day-plan-recalc.service.spec kapsıyor).
      { recalcForUnit: jest.fn().mockResolvedValue(null) } as never,
      // D-3 miktar çözümü — GERÇEK stateless politika (üretim davranışı).
      new RemovalQuantityPolicyService(),
      backdatePolicy as any,
      auditLogService,
      // SEC-HIGH-051: the real SSoT — fail-closed object-level site authz.
      new SiteAuthorizationService(),
      // TankBatchService SSoT writer — mocked here (its derivation is covered by
      // tank-batch.service.spec); the handler does not consume its return.
      { applyBatchDelta: jest.fn().mockResolvedValue({}) } as never,
      new MortalityCullPolicyService(),
      farmStockProjection,
      mobileCommandReceipts,
    );

    return { handler, manager, queryRunner, outboxPublisher, auditLogService };
  }

  describe('validation', () => {
    it('throws NotFoundException when batch does not exist', async () => {
      const { handler, manager } = buildHandler();
      manager.findOne.mockResolvedValue(null);

      await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when quantity exceeds current batch count', async () => {
      const { handler, manager } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch({ currentQuantity: 30 }));
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        return Promise.resolve(null);
      });

      await expect(handler.execute(makeCommand(50))).rejects.toThrow(BadRequestException);
    });
  });

  describe('batch metrics update', () => {
    it('decrements currentQuantity and increments totalMortality', async () => {
      const { handler, manager } = buildHandler();
      const batch = makeBatch({ currentQuantity: 10_000, totalMortality: 100 });
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(batch);
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand(50));

      const savedBatch = manager.save.mock.calls
        .find(([entity]: [unknown]) => entity === Batch)?.[1] as Partial<Batch> | undefined;
      expect(savedBatch?.currentQuantity).toBe(9_950);
      expect(savedBatch?.totalMortality).toBe(150);
    });

    it('uses Math.max guard — currentQuantity never goes below zero', async () => {
      const { handler, manager } = buildHandler();
      const batch = makeBatch({ currentQuantity: 30 });
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(batch);
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch({ totalQuantity: 30 }));
        return Promise.resolve(null);
      });

      // Quantity 30 === currentQuantity: exactly at boundary — should succeed
      await handler.execute(makeCommand(30));
      const savedBatch = manager.save.mock.calls
        .find(([entity]: [unknown]) => entity === Batch)?.[1] as Partial<Batch> | undefined;
      expect(savedBatch?.currentQuantity).toBeGreaterThanOrEqual(0);
    });
  });

  describe('transaction safety', () => {
    it('wraps all writes in a single transaction', async () => {
      const { handler, manager, queryRunner } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand());

      expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back and re-throws on write failure', async () => {
      const { handler, manager, queryRunner } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });
      manager.save.mockRejectedValueOnce(new Error('DB write failed'));

      await expect(handler.execute(makeCommand())).rejects.toThrow('DB write failed');
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('transactional outbox', () => {
    it('enqueues MortalityRecorded event before commit', async () => {
      const mockOutboxPublisher = createMockOutboxPublisher();
      const { handler, manager } = buildHandler({}, mockOutboxPublisher);
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand(50));

      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'MortalityRecorded',
          tenantId,
          batchId,
          quantity: 50,
        }),
        manager,
      );
    });

    it('rolls back if outbox enqueue fails', async () => {
      const failingPublisher = {
        enqueue: jest.fn().mockRejectedValue(new Error('outbox write failed')),
      } as unknown as OutboxPublisher;

      const { handler, manager, queryRunner } = buildHandler({}, failingPublisher);
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await expect(handler.execute(makeCommand())).rejects.toThrow('outbox write failed');
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('AquaMobil Phase 4 domain correctness', () => {
    it('FARM-CRITICAL-050: rejects mortality on a terminal batch even when isActive', async () => {
      const { handler, manager, outboxPublisher } = buildHandler();
      const terminal = makeBatch({
        status: BatchStatus.HARVESTED,
        isActive: true,
        isOperational: jest.fn().mockReturnValue(false),
        isStockMutable: jest.fn().mockReturnValue(false),
      });
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(terminal);
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        return Promise.resolve(null);
      });

      await expect(handler.execute(makeCommand(50))).rejects.toThrow(ConflictException);
      expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it('FARM-HIGH-052: rejects legacy mode (no idempotency envelope)', async () => {
      // No envelope → begin() returns legacy
      const { handler, manager } = buildHandler({ query: jest.fn().mockResolvedValue([]) });
      await expect(
        handler.execute(makeCommand(50, { envelope: undefined })),
      ).rejects.toThrow(BadRequestException);
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('FARM-HIGH-052: same clientCommandId twice replays without double decrement', async () => {
      const queryMock = jest.fn()
        .mockResolvedValueOnce([]) // INSERT DO NOTHING → conflict
        .mockResolvedValueOnce([{ payloadHash: 'hash-1', status: 'COMPLETED', responseType: 'Batch', responseId: batchId, responsePayload: { id: batchId } }]);
      const { handler, manager, outboxPublisher } = buildHandler({ query: queryMock });
      manager.findOne.mockResolvedValueOnce(makeBatch()); // replay reload

      await handler.execute(makeCommand(50));

      expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it('FARM-HIGH-053: rejects when the batch is not held in the supplied tank', async () => {
      const { handler, manager, outboxPublisher } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        // TankBatch holds a DIFFERENT batch
        if (entity === TankBatch) return Promise.resolve(makeTankBatch({ primaryBatchId: 'other-batch' }));
        return Promise.resolve(null);
      });

      await expect(handler.execute(makeCommand(50))).rejects.toThrow(NotFoundException);
      expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it('FARM-MEDIUM-052: PREDATION persists mortalityReason="predation" (not "unknown")', async () => {
      const { handler, manager } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand(50, { reason: MortalityReason.PREDATION }));

      const savedOp = manager.save.mock.calls
        .map((c) => c[1] as { mortalityReason?: string })
        .find((d) => d?.mortalityReason !== undefined);
      expect(savedOp?.mortalityReason).toBe('predation');
    });

    it('FARM-MEDIUM-052: CANNIBALISM persists mortalityReason="cannibalism"', async () => {
      const { handler, manager } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand(50, { reason: MortalityReason.CANNIBALISM }));

      const savedOp = manager.save.mock.calls
        .map((c) => c[1] as { mortalityReason?: string })
        .find((d) => d?.mortalityReason !== undefined);
      expect(savedOp?.mortalityReason).toBe('cannibalism');
    });

    it('FARM-LOW-050: rejects mortality that breaches the cumulative-initial ceiling', async () => {
      const { handler, manager } = buildHandler();
      const batch = makeBatch({ initialQuantity: 100, totalMortality: 90, cullCount: 0, currentQuantity: 10_000 });
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(batch);
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        return Promise.resolve(null);
      });
      // 90 + 0 + 0 + 20 = 110 > 100 → reject
      await expect(handler.execute(makeCommand(20))).rejects.toThrow(BadRequestException);
    });

    it('FARM-MEDIUM-054: writes a MORTALITY_RECORDED audit row via the txn manager', async () => {
      const { handler, manager, auditLogService } = buildHandler();
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand(50));

      expect(auditLogService.logWithManager).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ action: 'MORTALITY_RECORDED', entityId: batchId, tenantId }),
      );
    });
  });

  describe('SEC-HIGH-051 object-level site authorization', () => {
    const SITE_A = 'site-a';
    const SITE_B = 'site-b';
    const DEPT = 'dept-1';

    // Wires the manager so resolveTankSiteId resolves the tank → DEPT → SITE_A.
    function wireSiteResolution(manager: MockManager, departmentSiteId: string | null): void {
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment({ departmentId: DEPT }));
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        if (entity === Department) return Promise.resolve(departmentSiteId ? { id: DEPT, siteId: departmentSiteId } : null);
        return Promise.resolve(null);
      });
    }

    it('rejects a MODULE_USER whose assigned sites do NOT include the tank site (cross-site, no write)', async () => {
      const { handler, manager, outboxPublisher } = buildHandler();
      wireSiteResolution(manager, SITE_A);

      await expect(
        handler.execute(
          makeCommand(50, { userRoles: [Role.MODULE_USER], callerAssignedSiteIds: [SITE_B] }),
        ),
      ).rejects.toThrow(ForbiddenException);
      // No stock write / event must occur on an authz denial.
      expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it('allows a MODULE_USER assigned to the tank site (same-site)', async () => {
      const { handler, manager, outboxPublisher } = buildHandler();
      wireSiteResolution(manager, SITE_A);

      await handler.execute(
        makeCommand(50, { userRoles: [Role.MODULE_USER], callerAssignedSiteIds: [SITE_A] }),
      );
      expect(outboxPublisher.enqueue).toHaveBeenCalled();
    });

    it('allows a MODULE_MANAGER with no assigned sites (canonical hierarchy bypass)', async () => {
      const { handler, manager, outboxPublisher } = buildHandler();
      wireSiteResolution(manager, SITE_A);

      await handler.execute(
        makeCommand(50, { userRoles: [Role.MODULE_MANAGER], callerAssignedSiteIds: [] }),
      );
      expect(outboxPublisher.enqueue).toHaveBeenCalled();
    });

    it('fail-closed: denies a MODULE_USER when the tank site is unresolved (null)', async () => {
      const { handler, manager, outboxPublisher } = buildHandler();
      // Department has no siteId → resolveTankSiteId returns null → deny.
      wireSiteResolution(manager, null);

      await expect(
        handler.execute(
          makeCommand(50, { userRoles: [Role.MODULE_USER], callerAssignedSiteIds: [SITE_A] }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    });
  });
});
