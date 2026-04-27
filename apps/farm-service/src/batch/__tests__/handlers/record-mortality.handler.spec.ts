/**
 * RecordMortalityHandler Unit Tests
 *
 * Tests business logic of mortality recording: quantity validation,
 * batch/tank metrics update, and domain event publishing via DomainEventPublisher.
 *
 * Architecture: direct instantiation (no TestingModule) — handler uses DataSource
 * for pessimistic-lock transactions so we mock DataSource + queryRunner following
 * the pattern established in race-conditions.spec.ts.
 *
 * @module Batch/Tests
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource, Repository, EntityManager } from 'typeorm';
// Spec lives at src/batch/__tests__/handlers/ — one level deeper
// than when these imports were first written. All relative paths
// walk up one extra `../` to reach the batch module root.
import { RecordMortalityHandler } from '../../handlers/record-mortality.handler';
import { RecordMortalityCommand, MortalityReason } from '../../commands/record-mortality.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { MortalityRecord } from '../../entities/mortality-record.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { EquipmentType } from '../../../equipment/entities/equipment-type.entity';
// Handler migrated from DomainEventPublisher → OutboxPublisher
// (phase D — transactional outbox, at-least-once delivery).
import { OutboxPublisher } from '@platform/outbox';
// Phase 1.5 backdating policy — mortality events backdated
// beyond the context-specific window are rejected. A default
// mock passes everything through; tests that want to exercise
// the gate inject a rejecting stub.
import { BackdatePolicyService } from '../../../common/services/backdate-policy.service';

// ============================================================================
// Mock helpers (shared with race-conditions.spec.ts pattern)
// ============================================================================

interface MockManager {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function createMockManager(): MockManager {
  return {
    findOne: jest.fn(),
    create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => data),
    save: jest.fn().mockImplementation((_entity: unknown, data: unknown) => Promise.resolve(data)),
  };
}

function createMockQueryRunner(manager: MockManager) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: manager as unknown as EntityManager,
  };
}

function createMockDataSource(queryRunner: ReturnType<typeof createMockQueryRunner>): DataSource {
  return {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  } as unknown as DataSource;
}

function createMockOutboxPublisher(): OutboxPublisher {
  // Handler's outbox call is `enqueue(event, manager)`; resolve
  // silently for tests that don't assert the emitted event shape.
  return {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as OutboxPublisher;
}

function createMockBackdatePolicy(): BackdatePolicyService {
  // Default stub: validate() returns an allow-decision with zero
  // backdated days. Tests that want to exercise the rejection
  // path pass their own stub.
  return {
    getLimitForContext: jest.fn().mockReturnValue(14),
    validate: jest.fn().mockReturnValue({
      allowed: true,
      backdatedDays: 0,
      limitDays: 14,
      context: 'mortality',
    }),
  } as unknown as BackdatePolicyService;
}

// ============================================================================
// Tests
// ============================================================================

describe('RecordMortalityHandler', () => {
  const tenantId = 'tenant-123';
  const batchId = 'batch-456';
  const tankId = 'tank-789';

  function makeBatch(overrides: Partial<Batch> = {}): Partial<Batch> {
    return {
      id: batchId,
      tenantId,
      isActive: true,
      currentQuantity: 10_000,
      totalMortality: 0,
      status: BatchStatus.ACTIVE,
      // Handler writes into `batch.mortalitySummary` JSONB fields
      // after decrementing currentQuantity. Initialise so the
      // property assignments land.
      mortalitySummary: {
        totalMortality: 0,
        mortalityRate: 0,
        lastMortalityAt: undefined,
        mainCause: undefined,
      },
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
  }> = {}) {
    return new RecordMortalityCommand(tenantId, batchId, {
      tankId,
      quantity,
      reason: overrides.reason ?? MortalityReason.DISEASE,
      observedAt: overrides.observedAt ?? new Date(),
      avgWeightG: overrides.avgWeightG,
    }, 'user-001');
  }

  function buildHandler(
    managerOverride?: Partial<MockManager>,
    outboxPublisherOverride?: OutboxPublisher,
  ) {
    const manager = { ...createMockManager(), ...managerOverride };
    const queryRunner = createMockQueryRunner(manager);
    const dataSource = createMockDataSource(queryRunner);
    const outboxPublisher = outboxPublisherOverride ?? createMockOutboxPublisher();

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
      createMockBackdatePolicy(),
    );

    return { handler, manager, queryRunner, outboxPublisher };
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
        return Promise.resolve(null);
      });
      manager.save.mockRejectedValueOnce(new Error('DB write failed'));

      await expect(handler.execute(makeCommand())).rejects.toThrow('DB write failed');
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('transactional outbox publishing', () => {
    it('enqueues MortalityRecorded event via the outbox inside the tx', async () => {
      const mockOutboxPublisher = createMockOutboxPublisher();
      const { handler, manager } = buildHandler({}, mockOutboxPublisher);
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await handler.execute(makeCommand(50));

      // OutboxPublisher signature is `enqueue(event, manager)` —
      // the manager argument is the tx-scoped EntityManager so the
      // outbox row commits atomically with the domain write.
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'MortalityRecorded',
          tenantId,
          batchId,
          quantity: 50,
        }),
        expect.anything(),
      );
    });

    it('propagates publish errors — outbox enqueue is inside the tx so rollback is correct', async () => {
      // Unlike the removed DomainEventPublisher which swallowed
      // publish errors on a best-effort basis, the OutboxPublisher
      // writes to a local DB row and runs inside the transaction.
      // If the enqueue throws, the handler's tx must roll back so
      // the domain write and the outbox row stay consistent.
      const failingPublisher = {
        enqueue: jest.fn().mockRejectedValue(new Error('outbox write failed')),
      } as unknown as OutboxPublisher;

      const { handler, manager, queryRunner } = buildHandler(
        {},
        failingPublisher,
      );
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Batch) return Promise.resolve(makeBatch());
        if (entity === Equipment) return Promise.resolve(makeEquipment());
        if (entity === TankBatch) return Promise.resolve(makeTankBatch());
        return Promise.resolve(null);
      });

      await expect(handler.execute(makeCommand())).rejects.toThrow(
        'outbox write failed',
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });
  });
});
