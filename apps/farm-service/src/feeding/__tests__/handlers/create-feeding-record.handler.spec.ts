/**
 * CreateFeedingRecordHandler — canonical feed-stock write-path correctness
 *
 * Pins the three properties the Phase-A fix introduces:
 *
 *   1. assertFeedable gate: a feeding against an empty (currentQuantity ≤ 0)
 *      or non-feedable (HARVESTED / CLOSED / …) batch is REJECTED inside the
 *      tx, before any feeding record is written.
 *   2. Fail-closed storage deduction: when the storage ledger has no usable
 *      lot (resolveFeedDeductionLocation → null) the feeding is REJECTED and
 *      the transaction rolls back (replacing the old swallowed async failure).
 *   3. When the storage deduction itself throws (e.g. insufficient stock),
 *      the feeding transaction rolls back — feeding + both ledgers commit or
 *      roll back together; there is no silent divergence.
 *
 * The handler runs everything inside a queryRunner transaction; the doubles
 * model that boundary and assert commit vs rollback. Real BatchDomainService
 * is used (stateless pure domain logic) so the assertFeedable behaviour is
 * the production one, not a stub. Doubles are built through a typed mock
 * factory so no banned casts are needed.
 */
import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, ObjectLiteral, QueryRunner, Repository } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { CreateFeedingRecordHandler } from '../../handlers/create-feeding-record.handler';
import { CreateFeedingRecordCommand } from '../../commands/create-feeding-record.command';
import { FeedingRecord } from '../../entities/feeding-record.entity';
import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../../batch/services/batch-lifecycle-policy.service';
import { StockMovementService } from '../../../storage/services/stock-movement.service';
import { StockMovement } from '../../../storage/entities/stock-movement.entity';
import { RecordMovementResult } from '../../../storage/services/stock-movement.service';
import { BackdatePolicyService } from '../../../common/services/backdate-policy.service';
import { FinanceSettingsService } from '../../../finance/services/finance-settings.service';
import { FeedingLedgerService } from '../../services/feeding-ledger.service';
import {
  BiomassGrowthApplierService,
  LockedUnit,
} from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { FeedingDayPlan } from '../../../feeding-protocol/entities/feeding-day-plan.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const FEED = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const LOCATION = '55555555-5555-4555-8555-555555555555';
const TANK = '77777777-7777-4777-8777-777777777777';
const SITE = '88888888-8888-4888-8888-888888888888';

/**
 * Build a fully-typed partial double for an interface T. Every accessed
 * member is supplied; the single `as T` keeps the double assignable.
 */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  batch?: Batch | null;
  /** resolveFeedDeductionLocation result. */
  resolveLocation?: { storageLocationId: string; lotNumber?: string } | null;
  /** Make the storage recordMovement throw (insufficient stock). */
  recordMovementThrows?: Error;
  /** D-7: aktif gün planı (payload tankId taşıyorsa sorgulanır). */
  dayPlan?: Partial<FeedingDayPlan> | null;
}

function makeFeedableBatch(over: Partial<Batch> = {}): Batch {
  return mock<Batch>({
    id: BATCH,
    tenantId: TENANT,
    isActive: true,
    status: BatchStatus.ACTIVE,
    currentQuantity: 1000,
    totalFeedConsumed: 0,
    totalFeedCost: 0,
    ...over,
  });
}

interface Harness {
  handler: CreateFeedingRecordHandler;
  resolveFeedDeductionLocation: jest.Mock;
  recordMovement: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
  lockUnitForGrowth: jest.Mock;
  applyGrowth: jest.Mock;
  recalcForUnit: jest.Mock;
  managerQuery: jest.Mock;
  managerCreate: jest.Mock;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const batch = opts.batch === undefined ? makeFeedableBatch() : opts.batch;
  const feed = mock<Feed>({ id: FEED, name: 'Grower', unit: 'kg', pricePerKg: 2 });
  // EntityManager.findOne / save / create are heavily overloaded. The doubles
  // are left UN-annotated (jest.fn() → Mock<any>) so they remain structurally
  // assignable to the overloaded EntityManager members with no cast at all;
  // their behaviour is supplied via mockImplementation.
  const managerFindOne = jest.fn();
  // manager.findOne dispatches by entity class.
  managerFindOne.mockImplementation(async (entity: unknown): Promise<unknown> => {
    if (entity === Batch) return batch;
    if (entity === Feed) return feed;
    return null;
  });
  // FeedingRecord save assigns a generated id in production; model that.
  const managerSave = jest.fn();
  managerSave.mockImplementation(async (entity: Record<string, unknown>) => {
    if ('feedingDate' in entity) return { ...entity, id: 'rec-1' };
    return entity;
  });
  const managerCreate = jest.fn();
  managerCreate.mockImplementation((_entity: unknown, dto: Record<string, unknown>) => ({
    ...dto,
    calculateVariance: jest.fn(),
  }));

  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);

  // D-7: unplannedActualKg artışı ham UPDATE ile atılır; gün planı sorgusu
  // query-builder üzerinden kilitli okunur.
  const managerQuery = jest.fn().mockResolvedValue([]);
  const dayPlan = opts.dayPlan === undefined ? null : opts.dayPlan;
  const queryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(dayPlan),
  };
  const managerCreateQueryBuilder = jest.fn();
  managerCreateQueryBuilder.mockImplementation(() => queryBuilder);

  const manager = mock<EntityManager>({
    findOne: managerFindOne,
    save: managerSave,
    create: managerCreate,
    query: managerQuery,
    createQueryBuilder: managerCreateQueryBuilder,
  });

  const queryRunner = mock<QueryRunner>({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release,
    // runInTenantTransaction pins search_path + asserts the RLS GUC via
    // queryRunner.query. Returning [] makes the boundary readback assertion
    // skip (no live DB), so the tx boundary is exercised without a real conn.
    query: jest.fn().mockResolvedValue([]),
    manager,
  });

  const dataSource = mock<DataSource>({
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  });

  const outboxPublisher = mock<OutboxPublisher>({
    enqueue: jest.fn().mockResolvedValue(undefined),
  });
  const backdatePolicy = mock<BackdatePolicyService>({ validate: jest.fn() });

  // Real domain service — production assertFeedable behaviour.
  const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());

  const resolveFeedDeductionLocation = jest.fn().mockResolvedValue(
    opts.resolveLocation === undefined ? { storageLocationId: LOCATION, lotNumber: 'LOT-A' } : opts.resolveLocation,
  );
  const recordMovement = jest.fn(async (): Promise<RecordMovementResult> => {
    if (opts.recordMovementThrows) throw opts.recordMovementThrows;
    return {
      saved: mock<StockMovement>({ id: 'mv-1' }),
      currentTotal: 0,
      idempotentHit: false,
      lowStock: null,
      warnings: [],
    };
  });
  const stockMovementService = mock<StockMovementService>({
    resolveFeedDeductionLocation,
    recordMovement,
  });

  const repo = <T extends ObjectLiteral>(): Repository<T> => mock<Repository<T>>({});

  // Currency SSoT double — the handler resolves the tenant default
  // currency through FinanceSettingsService when the payload omits it.
  const financeSettings = mock<FinanceSettingsService>({
    getDefaultCurrencyInTx: jest.fn().mockResolvedValue('NOK'),
  });

  // GERÇEK ledger (P-05 tek yol) — pinlenen davranışlar (fail-closed no-lot,
  // rollback) artık ledger kodunda yaşar ve buradan uçtan uca koşar.
  const feedingLedger = new FeedingLedgerService(
    stockMovementService,
    financeSettings,
    outboxPublisher,
  );

  // D-7 motor yardımcıları — kilit/growth/recalc çağrıları pinlenir.
  const lockUnitForGrowth = jest.fn();
  lockUnitForGrowth.mockImplementation(async (): Promise<LockedUnit | null> => {
    if (!batch) return null;
    return {
      tankBatch: mock<TankBatch>({ tankId: TANK, tenantId: TENANT, primaryBatchId: batch.id }),
      batches: new Map([[batch.id, batch]]),
      details: [],
    };
  });
  const applyGrowth = jest.fn().mockResolvedValue(undefined);
  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const growthApplier = mock<BiomassGrowthApplierService>({ lockUnitForGrowth, applyGrowth });
  const recalcService = mock<DayPlanRecalcService>({ recalcForUnit });

  const handler = new CreateFeedingRecordHandler(
    repo<FeedingRecord>(),
    repo<Batch>(),
    repo<Feed>(),
    dataSource,
    backdatePolicy,
    batchDomainService,
    feedingLedger,
    growthApplier,
    recalcService,
  );

  return {
    handler,
    resolveFeedDeductionLocation,
    recordMovement,
    commit,
    rollback,
    lockUnitForGrowth,
    applyGrowth,
    recalcForUnit,
    managerQuery,
    managerCreate,
  };
}

function makeCommand(actualAmount = 50, tankId?: string): CreateFeedingRecordCommand {
  return new CreateFeedingRecordCommand(
    TENANT,
    {
      batchId: BATCH,
      tankId,
      feedingDate: new Date('2026-06-10T08:00:00Z'),
      feedingTime: '08:00',
      feedId: FEED,
      plannedAmount: 50,
      actualAmount,
      fedBy: USER,
    },
    USER,
  );
}

describe('CreateFeedingRecordHandler — feed dual-SSoT write path', () => {
  it('rejects feeding an empty batch (assertFeedable) and rolls back', async () => {
    const { handler, rollback, commit, recordMovement } = makeHarness({
      batch: makeFeedableBatch({ currentQuantity: 0 }),
    });

    await expect(handler.execute(makeCommand())).rejects.toBeInstanceOf(BadRequestException);

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    // Never reached the storage deduction.
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('rejects feeding a non-feedable (HARVESTED) batch (assertFeedable) and rolls back', async () => {
    const { handler, rollback, commit } = makeHarness({
      batch: makeFeedableBatch({ status: BatchStatus.HARVESTED }),
    });

    await expect(handler.execute(makeCommand())).rejects.toBeInstanceOf(BadRequestException);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('fail-closed: depleted feed with no projection row rejects and rolls back', async () => {
    const { handler, rollback, commit, recordMovement } = makeHarness({
      resolveLocation: null,
    });

    await expect(handler.execute(makeCommand())).rejects.toBeInstanceOf(BadRequestException);

    expect(recordMovement).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('fail-closed: storage deduction throws (insufficient stock) → rollback', async () => {
    const { handler, rollback, commit } = makeHarness({
      recordMovementThrows: new BadRequestException(
        'Insufficient stock. Available: 5 kg, Requested: 50 kg',
      ),
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow('Insufficient stock');

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('happy path: deducts storage IN-TX (OUT) and commits', async () => {
    const { handler, recordMovement, resolveFeedDeductionLocation, commit, rollback } =
      makeHarness();

    const result = await handler.execute(makeCommand(50));

    expect(resolveFeedDeductionLocation).toHaveBeenCalledTimes(1);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    // The deduction is issued on the SAME manager as the feeding write
    // (in-tx) with an OUT movement keyed by the feeding record id.
    const movementInput = recordMovement.mock.calls[0]![1] as {
      movementType: string;
      itemId: string;
      quantity: number;
      fromLocationId: string;
      idempotencyKey: string;
    };
    expect(movementInput.movementType).toBe('out');
    expect(movementInput.itemId).toBe(FEED);
    expect(movementInput.quantity).toBe(50);
    expect(movementInput.fromLocationId).toBe(LOCATION);
    expect(movementInput.idempotencyKey).toBe('feeding-deduct-rec-1');

    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(result.id).toBe('rec-1');
  });
});

describe('CreateFeedingRecordHandler — D-7 plan-dışı yem bağlama', () => {
  const DAY_PLAN = mock<FeedingDayPlan>({
    id: 'dp-1',
    siteId: SITE,
    snapshot: mock<FeedingDayPlan['snapshot']>({ expectedFcr: 1.25 }),
  });

  it('aktif gün planına bağlar: kayıt dayPlanId taşır, unplannedActualKg artar, growth + recalc AYNI tx', async () => {
    const {
      handler,
      lockUnitForGrowth,
      applyGrowth,
      recalcForUnit,
      managerQuery,
      managerCreate,
      recordMovement,
      commit,
    } = makeHarness({ dayPlan: DAY_PLAN });

    await handler.execute(makeCommand(50, TANK));

    // Kanonik kilit sırası: ünite kilidi (Batch asc + TankBatch) alındı.
    expect(lockUnitForGrowth).toHaveBeenCalledWith(expect.anything(), TENANT, TANK);

    // (1) Plan-dışı toplam atomik arttı.
    const updateCall = managerQuery.mock.calls.find((call) =>
      String(call[0]).includes('unplannedActualKg'),
    );
    expect(updateCall).toBeDefined();
    // tenantId predikatı ZORUNLU (FARM-MEDIUM-292): plan id'si tenant
    // sorgusundan gelse de yazım search_path'e güvenemez.
    expect(String(updateCall![0])).toContain('"tenantId" = $2');
    expect(updateCall![1]).toEqual([50, TENANT, 'dp-1']);

    // (2) Büyüme snapshot FCR'ıyla uygulandı: 50kg / 1.25 = 40kg.
    expect(applyGrowth).toHaveBeenCalledTimes(1);
    expect(applyGrowth.mock.calls[0]![3]).toBe(40);
    expect(applyGrowth.mock.calls[0]![4]).toBe(1.25);

    // (3) Kalan öğünler 'unplanned_feed' gerekçesiyle yeniden fiyatlandı.
    expect(recalcForUnit).toHaveBeenCalledWith(expect.anything(), TENANT, TANK, 'unplanned_feed');

    // Kayıt plana bağlandı (mealId YOK) + site kapsamı plan denormundan (D-9).
    const record = managerCreate.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)['feedingDate'] !== undefined,
    )![1] as Record<string, unknown>;
    expect(record['dayPlanId']).toBe('dp-1');
    expect(record['mealId']).toBeUndefined();
    // Storage düşümü akışın SON yazımı olarak yine koştu.
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('aktif planı olmayan ünitede yalnız-ledger davranışı sürer (growth/recalc yok)', async () => {
    const { handler, applyGrowth, recalcForUnit, managerQuery, managerCreate, commit } =
      makeHarness({ dayPlan: null });

    await handler.execute(makeCommand(50, TANK));

    expect(applyGrowth).not.toHaveBeenCalled();
    expect(recalcForUnit).not.toHaveBeenCalled();
    expect(
      managerQuery.mock.calls.some((call) => String(call[0]).includes('unplannedActualKg')),
    ).toBe(false);
    const record = managerCreate.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)['feedingDate'] !== undefined,
    )![1] as Record<string, unknown>;
    expect(record['dayPlanId']).toBeUndefined();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('tankId taşımayan kayıt ünite kilidini hiç almaz (mevcut davranış korunur)', async () => {
    const { handler, lockUnitForGrowth, commit } = makeHarness();

    await handler.execute(makeCommand(50));

    expect(lockUnitForGrowth).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
