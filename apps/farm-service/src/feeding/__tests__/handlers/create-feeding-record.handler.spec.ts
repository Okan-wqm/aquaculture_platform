/**
 * CreateFeedingRecordHandler — feed dual-SSoT write-path correctness (Phase A)
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
import { FeedInventory } from '../../entities/feed-inventory.entity';
import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../../batch/services/batch-lifecycle-policy.service';
import { StockMovementService } from '../../../storage/services/stock-movement.service';
import { StockMovement } from '../../../storage/entities/stock-movement.entity';
import { RecordMovementResult } from '../../../storage/services/stock-movement.service';
import { BackdatePolicyService } from '../../../common/services/backdate-policy.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const FEED = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const LOCATION = '55555555-5555-4555-8555-555555555555';

/**
 * Build a fully-typed partial double for an interface T. Every accessed
 * member is supplied; the single `as T` keeps the double assignable.
 */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  batch?: Batch | null;
  /**
   * feedHasStoragePresence result. Defaults to true (the feed IS
   * storage-tracked) so the fail-closed paths exercise a real shortage; set
   * false to exercise the fail-OPEN skip for a feed the tenant does not track
   * in storage.
   */
  hasStoragePresence?: boolean;
  /** resolveFeedDeductionLocation result. */
  resolveLocation?: { storageLocationId: string; lotNumber?: string } | null;
  /** Make the storage recordMovement throw (insufficient stock). */
  recordMovementThrows?: Error;
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
  feedHasStoragePresence: jest.Mock;
  resolveFeedDeductionLocation: jest.Mock;
  recordMovement: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const batch = opts.batch === undefined ? makeFeedableBatch() : opts.batch;
  const feed = mock<Feed>({ id: FEED, name: 'Grower', unit: 'kg', pricePerKg: 2 });
  const feedInventory = mock<FeedInventory>({
    id: 'finv-1',
    tenantId: TENANT,
    feedId: FEED,
    quantityKg: 500,
    minStockKg: 100,
    updateStatus: jest.fn(),
  });

  // EntityManager.findOne / save / create are heavily overloaded. The doubles
  // are left UN-annotated (jest.fn() → Mock<any>) so they remain structurally
  // assignable to the overloaded EntityManager members with no cast at all;
  // their behaviour is supplied via mockImplementation.
  const managerFindOne = jest.fn();
  // manager.findOne dispatches by entity class.
  managerFindOne.mockImplementation(async (entity: unknown): Promise<unknown> => {
    if (entity === Batch) return batch;
    if (entity === Feed) return feed;
    if (entity === FeedInventory) return feedInventory;
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

  const manager = mock<EntityManager>({
    findOne: managerFindOne,
    save: managerSave,
    create: managerCreate,
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

  const outboxPublisher = mock<OutboxPublisher>({ enqueue: jest.fn().mockResolvedValue(undefined) });
  const backdatePolicy = mock<BackdatePolicyService>({ validate: jest.fn() });

  // Real domain service — production assertFeedable behaviour.
  const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());

  const feedHasStoragePresence = jest
    .fn()
    .mockResolvedValue(opts.hasStoragePresence === undefined ? true : opts.hasStoragePresence);
  const resolveFeedDeductionLocation = jest.fn().mockResolvedValue(
    opts.resolveLocation === undefined ? { storageLocationId: LOCATION, lotNumber: 'LOT-A' } : opts.resolveLocation,
  );
  const recordMovement = jest.fn(async (): Promise<RecordMovementResult> => {
    if (opts.recordMovementThrows) throw opts.recordMovementThrows;
    return {
      saved: mock<StockMovement>({ id: 'mv-1' }),
      currentTotal: 0,
      idempotentHit: false,
      warnings: [],
    };
  });
  const stockMovementService = mock<StockMovementService>({
    feedHasStoragePresence,
    resolveFeedDeductionLocation,
    recordMovement,
  });

  const repo = <T extends ObjectLiteral>(): Repository<T> => mock<Repository<T>>({});

  const handler = new CreateFeedingRecordHandler(
    repo<FeedingRecord>(),
    repo<Batch>(),
    repo<Feed>(),
    repo<FeedInventory>(),
    dataSource,
    outboxPublisher,
    backdatePolicy,
    batchDomainService,
    stockMovementService,
  );

  return { handler, feedHasStoragePresence, resolveFeedDeductionLocation, recordMovement, commit, rollback };
}

function makeCommand(actualAmount = 50): CreateFeedingRecordCommand {
  return new CreateFeedingRecordCommand(
    TENANT,
    {
      batchId: BATCH,
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

  it('fail-closed: STORAGE-TRACKED feed with no usable lot → reject + rollback (no silent swallow)', async () => {
    const { handler, rollback, commit, recordMovement } = makeHarness({
      hasStoragePresence: true,
      resolveLocation: null,
    });

    await expect(handler.execute(makeCommand())).rejects.toBeInstanceOf(BadRequestException);

    expect(recordMovement).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('fail-OPEN: feed NOT tracked in storage → skip deduction, proceed, COMMIT (no cliff)', async () => {
    const { handler, feedHasStoragePresence, resolveFeedDeductionLocation, recordMovement, commit, rollback } =
      makeHarness({ hasStoragePresence: false });

    const result = await handler.execute(makeCommand(50));

    expect(feedHasStoragePresence).toHaveBeenCalledTimes(1);
    // Not storage-tracked → no resolve, no movement, NO throw: the
    // feed_inventory-only path is correct for this tenant.
    expect(resolveFeedDeductionLocation).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(result.id).toBe('rec-1');
  });

  it('fail-closed: storage deduction throws (insufficient stock) → rollback', async () => {
    const { handler, rollback, commit } = makeHarness({
      recordMovementThrows: new BadRequestException('Insufficient stock. Available: 5 kg, Requested: 50 kg'),
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow('Insufficient stock');

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('happy path: deducts storage IN-TX (OUT) and commits', async () => {
    const { handler, recordMovement, resolveFeedDeductionLocation, commit, rollback } = makeHarness();

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
