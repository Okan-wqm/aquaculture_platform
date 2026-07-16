/**
 * RecordCullHandler Unit Tests
 *
 * IP-3: CQRS handler test coverage — cull recording with quantity validation.
 * AquaMobil Phase 4: terminal-batch reject, idempotency (legacy reject + replay),
 * batch<->tank membership, QUALITY persistence, aggregate ceiling, pessimistic
 * lock parity, and the transactional audit row.
 */
import { NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { OutboxPublisher } from '@platform/outbox';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

import { AuditLogService } from '../../../database/services/audit-log.service';
import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { RecordCullCommand, CullReason } from '../../commands/record-cull.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { RecordCullHandler } from '../../handlers/record-cull.handler';
import { MortalityCullPolicyService } from '../../services/mortality-cull-policy.service';
import { RemovalQuantityPolicyService } from '../../services/removal-quantity-policy.service';

const ENVELOPE = { clientCommandId: 'cmd-1', payloadHash: 'hash-1' };

// Typed mock builders — a single `Partial<X> as X` narrowing keeps the casts
// gate-clean (no banned widening) while only stubbing the methods exercised.
const mockOutbox = (): OutboxPublisher =>
  ({ enqueue: jest.fn().mockResolvedValue(undefined) }) as Partial<OutboxPublisher> as OutboxPublisher;
const mockAudit = (): AuditLogService =>
  ({ logWithManager: jest.fn().mockResolvedValue({}) }) as Partial<AuditLogService> as AuditLogService;
const mockProjection = (): FarmStockProjectionService =>
  ({ refreshContainers: jest.fn().mockResolvedValue(undefined) }) as Partial<FarmStockProjectionService> as FarmStockProjectionService;

describe('RecordCullHandler', () => {
  let handler: RecordCullHandler;
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const mockOutboxPublisher = mockOutbox();
  const mockAuditLogService = mockAudit();

  beforeEach(() => {
    jest.clearAllMocks();
    // The shared mock EntityManager has no query() wired —
    // MobileCommandReceiptService calls manager.query for begin()/complete().
    // EntityManager.query exists on the type; default it to the "started"
    // receipt (INSERT returns an id) so a record proceeds.
    mockManager.query = jest.fn().mockResolvedValue([{ id: 'receipt-1' }]);
    handler = new RecordCullHandler(
      mockDataSource,
      createMockRepository(),
      createMockRepository(),
      createMockRepository(),
      createMockRepository(),
      mockOutboxPublisher,
      // P-31 recalc — mocked (day-plan-recalc.service.spec kapsıyor).
      { recalcForUnit: jest.fn().mockResolvedValue(null) } as never,
      // D-3 miktar çözümü — GERÇEK stateless politika (üretim davranışı).
      new RemovalQuantityPolicyService(),
      mockAuditLogService,
      // SEC-HIGH-051: the real fail-closed SSoT; commands below default to
      // MODULE_MANAGER so site authz bypasses for these domain-logic tests.
      new SiteAuthorizationService(),
      // TankBatchService SSoT writer — mocked (covered by tank-batch.service.spec).
      { applyBatchDelta: jest.fn().mockResolvedValue({}) } as never,
      new MortalityCullPolicyService(),
      mockProjection(),
      new MobileCommandReceiptService(),
    );
  });

  const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER = 'user-1';
  const CULLED_AT = new Date('2026-04-29T10:00:00.000Z');

  function operationalBatch(overrides: Partial<Batch> = {}): Batch {
    return {
      id: 'batch-1', tenantId: TENANT, status: BatchStatus.GROWING,
      batchNumber: 'B-001',
      initialQuantity: 10_000,
      currentQuantity: 1000, cullCount: 0, totalMortality: 0, isActive: true,
      isOperational: () => true,
      isStockMutable: () => true,
      getCurrentAvgWeight: () => 50,
      getRetentionRate: () => 95,
      ...overrides,
    } as Partial<Batch> as Batch;
  }

  function tankWith(): Record<string, unknown> {
    return { id: 'tank-1', tenantId: TENANT, volume: 100, currentBiomass: 50, currentCount: 1000 };
  }

  function tankBatchHolding(batchId = 'batch-1'): TankBatch {
    // Only the data fields the handler reads are stubbed (no entity methods).
    return {
      id: 'tank-batch-1', tenantId: TENANT, tankId: 'tank-1',
      primaryBatchId: batchId, primaryBatchNumber: 'B-001',
      totalQuantity: 500, avgWeightG: 50, totalBiomassKg: 25,
      currentQuantity: 500, currentBiomassKg: 25, densityKgM3: 0.25,
      isMixedBatch: false, cleanerFishBiomassKg: 0, cleanerFishQuantity: 0,
      isOverCapacity: false, createdAt: new Date(), updatedAt: new Date(),
    } as Partial<TankBatch> as TankBatch;
  }

  it('should throw NotFoundException when batch not found', async () => {
    mockManager.findOne.mockResolvedValueOnce(null);

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_MANAGER], [], ENVELOPE)),
    ).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('FARM-HIGH-052: rejects legacy mode (no idempotency envelope)', async () => {
    (mockManager.query as jest.Mock).mockResolvedValue([]); // begin returns legacy when no envelope
    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_MANAGER], [])),
    ).rejects.toThrow(BadRequestException);
    // No batch ever loaded — rejected before any read/write
    expect(mockManager.findOne).not.toHaveBeenCalled();
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('FARM-HIGH-052: replays a completed receipt as an idempotent no-op', async () => {
    // begin: insert conflicts (no id) → SELECT returns a COMPLETED row → replay
    (mockManager.query as jest.Mock)
      .mockResolvedValueOnce([]) // INSERT ... DO NOTHING returns no id
      .mockResolvedValueOnce([{ payloadHash: 'hash-1', status: 'COMPLETED', responseType: 'Batch', responseId: 'batch-1', responsePayload: { id: 'batch-1' } }]);
    mockManager.findOne.mockResolvedValueOnce(operationalBatch()); // replay batch reload

    const result = await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
    }, USER, [Role.MODULE_MANAGER], [], ENVELOPE));

    expect(result.id).toBe('batch-1');
    // No decrement happened — only the replay batch reload
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('FARM-CRITICAL-050: rejects cull on a terminal (non-operational) batch even if isActive', async () => {
    const terminal = operationalBatch({ status: BatchStatus.HARVESTED, isActive: true, isOperational: () => false, isStockMutable: () => false } as Partial<Batch>);
    mockManager.findOne
      .mockResolvedValueOnce(terminal)   // batch
      .mockResolvedValueOnce(tankWith()); // equipment

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_MANAGER], [], ENVELOPE)),
    ).rejects.toThrow(ConflictException);
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('FARM-HIGH-053: rejects cull when the batch is not held in the tank (no TankBatch)', async () => {
    mockManager.findOne
      .mockResolvedValueOnce(operationalBatch()) // batch
      .mockResolvedValueOnce(tankWith())         // equipment
      .mockResolvedValueOnce(null);              // tankBatch → empty tank
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_MANAGER], [], ENVELOPE)),
    ).rejects.toThrow(NotFoundException);
    expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('FARM-LOW-050: rejects cull that breaches the cumulative-initial ceiling', async () => {
    const batch = operationalBatch({ initialQuantity: 100, totalMortality: 60, cullCount: 30, currentQuantity: 1000 } as Partial<Batch>);
    mockManager.findOne
      .mockResolvedValueOnce(batch)      // batch
      .mockResolvedValueOnce(tankWith()); // equipment
    // 60 + 30 + 0 + 20 = 110 > 100 → reject (currentQuantity alone would permit)
    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 20, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_MANAGER], [], ENVELOPE)),
    ).rejects.toThrow(BadRequestException);
  });

  it('FARM-HIGH-054: persists a QUALITY cull (cullReason="quality") and decrements', async () => {
    const batch = operationalBatch();
    mockManager.findOne
      .mockResolvedValueOnce(batch)              // batch
      .mockResolvedValueOnce(tankWith())         // equipment
      .mockResolvedValueOnce(tankBatchHolding()); // tankBatch
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    const result = await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.QUALITY, culledAt: CULLED_AT,
    }, USER, [Role.MODULE_MANAGER], [], ENVELOPE));

    expect(result.currentQuantity).toBe(950);
    expect(result.cullCount).toBe(50);

    const savedOp = (mockManager.create as jest.Mock).mock.calls
      .map((c) => c[1])
      .find((d) => d?.cullReason !== undefined);
    expect(savedOp.cullReason).toBe('quality');

    expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'CullRecorded', tenantId: TENANT, batchId: 'batch-1', quantity: 50 }),
      mockManager,
    );
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('FARM-MEDIUM-055: loads TankBatch with a pessimistic_write lock', async () => {
    mockManager.findOne
      .mockResolvedValueOnce(operationalBatch())
      .mockResolvedValueOnce(tankWith())
      .mockResolvedValueOnce(tankBatchHolding());
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
    }, USER, [Role.MODULE_MANAGER], [], ENVELOPE));

    const tankBatchCall = (mockManager.findOne as jest.Mock).mock.calls
      .find(([entity, opts]) => entity === TankBatch && opts?.where?.tankId === 'tank-1');
    expect(tankBatchCall?.[1]?.lock).toEqual({ mode: 'pessimistic_write' });
  });

  it('FARM-MEDIUM-054: writes a CULL_RECORDED audit row via the txn manager', async () => {
    mockManager.findOne
      .mockResolvedValueOnce(operationalBatch())
      .mockResolvedValueOnce(tankWith())
      .mockResolvedValueOnce(tankBatchHolding());
    mockManager.save.mockImplementation((_cls: any, data: any) => Promise.resolve(data));

    await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
      tankId: 'tank-1', quantity: 50, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
    }, USER, [Role.MODULE_MANAGER], [], ENVELOPE));

    expect(mockAuditLogService.logWithManager).toHaveBeenCalledWith(
      mockManager,
      expect.objectContaining({ action: 'CULL_RECORDED', entityId: 'batch-1', tenantId: TENANT }),
    );
  });

  it('should always release queryRunner on error', async () => {
    mockManager.findOne.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.SMALL_SIZE, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_MANAGER], [], ENVELOPE)),
    ).rejects.toThrow();

    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  describe('SEC-HIGH-051 object-level site authorization', () => {
    const SITE_A = 'site-a';
    const SITE_B = 'site-b';
    const DEPT = 'dept-1';

    it('rejects a MODULE_USER not assigned to the tank site (cross-site, no write)', async () => {
      mockManager.findOne.mockImplementation((entity: unknown) => {
        if ((entity as { name?: string })?.name === 'Department') {
          return Promise.resolve({ id: DEPT, siteId: SITE_A });
        }
        // batch / equipment / tankBatch
        if (typeof entity === 'function' && entity.name === 'Batch') return Promise.resolve(operationalBatch());
        if (typeof entity === 'function' && entity.name === 'TankBatch') return Promise.resolve(tankBatchHolding());
        // Equipment carries departmentId so resolveSiteIdFromDepartment runs.
        return Promise.resolve({ ...tankWith(), departmentId: DEPT });
      });

      await expect(
        handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
          tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
        }, USER, [Role.MODULE_USER], [SITE_B], ENVELOPE)),
      ).rejects.toThrow(ForbiddenException);
      expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it('allows a MODULE_USER assigned to the tank site', async () => {
      mockManager.findOne.mockImplementation((entity: unknown) => {
        if (typeof entity === 'function' && entity.name === 'Batch') return Promise.resolve(operationalBatch());
        if (typeof entity === 'function' && entity.name === 'TankBatch') return Promise.resolve(tankBatchHolding());
        if (typeof entity === 'function' && entity.name === 'Department') return Promise.resolve({ id: DEPT, siteId: SITE_A });
        return Promise.resolve({ ...tankWith(), departmentId: DEPT });
      });
      mockManager.save.mockImplementation((_cls: unknown, data: unknown) => Promise.resolve(data));

      await handler.execute(new RecordCullCommand(TENANT, 'batch-1', {
        tankId: 'tank-1', quantity: 10, reason: CullReason.DEFORMED, culledAt: CULLED_AT,
      }, USER, [Role.MODULE_USER], [SITE_A], ENVELOPE));

      expect(mockOutboxPublisher.enqueue).toHaveBeenCalled();
    });
  });
});
