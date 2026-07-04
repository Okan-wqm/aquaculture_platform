/**
 * DailyFeedingExecutionService.recordActualFeeding — feed dual-SSoT write-path
 * correctness (Phase A)
 *
 * This is the SECOND in-transaction feeding write path (the first is
 * CreateFeedingRecordHandler). It must enforce the SAME invariants:
 *
 *   1. assertFeedable gate: recording feed against an empty
 *      (currentQuantity ≤ 0) or non-feedable (HARVESTED / CLOSED / …) LOCKED
 *      batch is REJECTED inside the tx, before any state is mutated → rollback.
 *   2. Fail-CLOSED for a STORAGE-TRACKED feed: when the feed has storage
 *      presence but its located lot is short (recordMovement throws) the whole
 *      recording rolls back — feeding + both ledgers commit or roll back
 *      together; no silent divergence.
 *   3. Fail-OPEN SKIP for a NON-storage-tracked feed: when the feed has ZERO
 *      storage rows (a tenant that never adopted the warehouse module) the
 *      storage OUT is SKIPPED (no throw, no recordMovement) and the recording
 *      proceeds to commit on the feed_inventory-only path — this is the cliff
 *      removal that distinguishes "not tracked" from "out of stock".
 *
 * The service runs everything inside a queryRunner transaction; the doubles
 * model that boundary and assert commit vs rollback. Real BatchDomainService
 * is used (stateless pure domain logic) so assertFeedable is the production
 * behaviour, not a stub. Doubles are built through a typed mock factory so no
 * banned casts are needed (a single `as T` per double, matching the sibling
 * create-feeding-record.handler.spec.ts).
 */
import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, ObjectLiteral, QueryRunner, Repository } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Role } from '@aquaculture/backend-common/decorators';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import {
  SiteAuthorizationService,
  type SiteScopeCaller,
} from '@aquaculture/backend-common/security';

import { DailyFeedingExecutionService } from '../daily-feeding-execution.service';
import {
  DailyFeedingExecution,
  ExecutionStatus,
  ExecutionCalculation,
} from '../../entities/daily-feeding-execution.entity';
import { FeedInventory } from '../../entities/feed-inventory.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../../batch/services/batch-lifecycle-policy.service';
import { BilinearInterpolationService } from '../bilinear-interpolation.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { StockMovementService } from '../../../storage/services/stock-movement.service';
import { StockMovement } from '../../../storage/entities/stock-movement.entity';
import { RecordMovementResult } from '../../../storage/services/stock-movement.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EXECUTION = '66666666-6666-4666-8666-666666666666';
const TANK = '77777777-7777-4777-8777-777777777777';
const BATCH = '22222222-2222-4222-8222-222222222222';
const FEED = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const LOCATION = '55555555-5555-4555-8555-555555555555';

// SEC-HIGH-051: the site-scope caller threaded into recordActualFeeding. A
// MODULE_MANAGER bypasses the object-level site check via the canonical role
// hierarchy, so these stock-focused tests keep their original behaviour — they
// assert the dual-SSoT write path, not the site gate (covered by its own spec).
const MANAGER_CALLER: SiteScopeCaller = {
  sub: USER,
  roles: [Role.MODULE_MANAGER],
  assignedSiteIds: [],
};

/**
 * Build a fully-typed partial double for an interface T. Every accessed member
 * is supplied; the single `as T` keeps the double assignable.
 */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

function makeCalculations(over: Partial<ExecutionCalculation> = {}): ExecutionCalculation {
  return mock<ExecutionCalculation>({
    avgWeightG: 100,
    fishCount: 1000,
    biomassKg: 100,
    waterTempC: 15,
    usingDefaultTemperature: false,
    activeFeedId: FEED,
    activeFeedCode: 'GR-4',
    activeFeedName: 'Grower 4mm',
    feedingRatePercent: 2,
    plannedFeedKg: 2,
    mealsPerDay: 4,
    perMealKg: 0.5,
    expectedFCR: 1.1,
    fcrSource: undefined,
    ...over,
  });
}

/**
 * A double for the loaded execution. `recordActualFeeding` is a no-op spy (the
 * entity's growth math is exercised by its own entity spec); the service reads
 * `calculations` directly for the biomass update, so those are real values.
 */
function makeExecution(over: Partial<DailyFeedingExecution> = {}): DailyFeedingExecution {
  return mock<DailyFeedingExecution>({
    id: EXECUTION,
    tenantId: TENANT,
    equipmentId: TANK,
    executionDate: new Date('2026-06-10T00:00:00Z'),
    status: ExecutionStatus.PLANNED,
    calculations: makeCalculations(),
    // No feedingProgram → the transition branch is skipped.
    feedingProgram: undefined,
    canRecordFeeding: () => true,
    recordActualFeeding: jest.fn(),
    markFeedTransition: jest.fn(),
    ...over,
  });
}

function makeFeedableBatch(over: Partial<Batch> = {}): Batch {
  return mock<Batch>({
    id: BATCH,
    tenantId: TENANT,
    isActive: true,
    status: BatchStatus.ACTIVE,
    currentQuantity: 1000,
    ...over,
  });
}

interface HarnessOpts {
  execution?: DailyFeedingExecution;
  /** TankBatch returned for the feedability guard + biomass update. */
  tankBatch?: TankBatch | null;
  /** Batch returned under the pessimistic lock for assertFeedable. */
  lockedBatch?: Batch | null;
  /** feedHasStoragePresence result. */
  hasStoragePresence?: boolean;
  /** resolveFeedDeductionLocation result. */
  resolveLocation?: { storageLocationId: string; lotNumber?: string } | null;
  /** Make recordMovement throw (insufficient stock for a tracked feed). */
  recordMovementThrows?: Error;
}

interface Harness {
  service: DailyFeedingExecutionService;
  feedHasStoragePresence: jest.Mock;
  resolveFeedDeductionLocation: jest.Mock;
  recordMovement: jest.Mock;
  enqueue: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const execution = opts.execution ?? makeExecution();
  const tankBatch =
    opts.tankBatch === undefined
      ? mock<TankBatch>({ tankId: TANK, tenantId: TENANT, primaryBatchId: BATCH })
      : opts.tankBatch;
  const lockedBatch = opts.lockedBatch === undefined ? makeFeedableBatch() : opts.lockedBatch;
  const tank = mock({ id: TANK, currentBiomass: 0 });
  const feedInventory = mock<FeedInventory>({
    id: 'finv-1',
    tenantId: TENANT,
    feedId: FEED,
    quantityKg: 500,
    minStockKg: 100,
    updateStatus: jest.fn(),
  });

  // manager.findOne dispatches by entity class. TankBatch / Batch are loaded by
  // BOTH the feedability guard and the biomass-update step (the lock option is
  // ignored by the double). Tank is the default fall-through for the biomass
  // update's Tank lookup.
  const managerFindOne = jest.fn();
  managerFindOne.mockImplementation(async (entity: unknown): Promise<unknown> => {
    if (entity === DailyFeedingExecution) return execution;
    if (entity === TankBatch) return tankBatch;
    if (entity === Batch) return lockedBatch;
    if (entity === FeedInventory) return feedInventory;
    return tank;
  });

  const managerSave = jest.fn().mockImplementation(async (entity: unknown) => entity);

  // The outbox publisher requires a manager bound to an active transaction; the
  // double exposes a queryRunner with isTransactionActive=true so enqueue (if
  // reached) does not reject. enqueue itself is mocked, so the assertion never
  // touches the real publisher's transaction guard, but we keep the shape
  // honest.
  const manager = mock<EntityManager>({
    findOne: managerFindOne,
    save: managerSave,
  });

  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);

  const queryRunner = mock<QueryRunner>({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release,
    manager,
  });

  const dataSource = mock<DataSource>({
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  });

  const enqueue = jest.fn().mockResolvedValue(undefined);
  const outboxPublisher = mock<OutboxPublisher>({ enqueue });

  // Real domain service — production assertFeedable behaviour.
  const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());

  const feedHasStoragePresence = jest
    .fn()
    .mockResolvedValue(opts.hasStoragePresence === undefined ? true : opts.hasStoragePresence);
  const resolveFeedDeductionLocation = jest
    .fn()
    .mockResolvedValue(
      opts.resolveLocation === undefined
        ? { storageLocationId: LOCATION, lotNumber: 'LOT-A' }
        : opts.resolveLocation,
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

  const bilinearService = mock<BilinearInterpolationService>({});

  const repo = <T extends ObjectLiteral>(): Repository<T> => mock<Repository<T>>({});

  // No mobile-command envelope is passed by these dual-SSoT write-path tests, so
  // begin() runs in legacy mode (one-shot, no idempotency replay) and complete()
  // is a no-op. Both are stubbed so the recording proceeds straight to the
  // storage write path under test.
  const mobileCommandReceipts = mock<MobileCommandReceiptService>({
    begin: jest.fn().mockResolvedValue({ mode: 'legacy' }),
    complete: jest.fn().mockResolvedValue(undefined),
  });

  const service = new DailyFeedingExecutionService(
    repo<DailyFeedingExecution>(),
    repo(),
    repo(),
    repo<TankBatch>(),
    repo<Batch>(),
    repo(),
    repo(),
    bilinearService,
    {} as WaterTemperatureService,
    dataSource,
    batchDomainService,
    stockMovementService,
    outboxPublisher,
    mobileCommandReceipts,
    new SiteAuthorizationService(),
  );

  return {
    service,
    feedHasStoragePresence,
    resolveFeedDeductionLocation,
    recordMovement,
    enqueue,
    commit,
    rollback,
  };
}

describe('DailyFeedingExecutionService.recordActualFeeding — feed dual-SSoT write path', () => {
  it('(a) rolls back when a STORAGE-TRACKED feed has insufficient stock', async () => {
    const { service, feedHasStoragePresence, recordMovement, commit, rollback } = makeHarness({
      hasStoragePresence: true,
      recordMovementThrows: new BadRequestException(
        'Insufficient stock. Available: 5 kg, Requested: 50 kg',
      ),
    });

    await expect(
      service.recordActualFeeding(EXECUTION, 50, USER, TENANT, MANAGER_CALLER),
    ).rejects.toThrow('Insufficient stock');

    expect(feedHasStoragePresence).toHaveBeenCalledTimes(1);
    // The deduction was attempted (tracked feed) and threw → rollback.
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('(b) fail-OPEN: skips the storage deduction and COMMITS when the feed has NO storage presence', async () => {
    const {
      service,
      feedHasStoragePresence,
      resolveFeedDeductionLocation,
      recordMovement,
      commit,
      rollback,
    } = makeHarness({ hasStoragePresence: false });

    const result = await service.recordActualFeeding(EXECUTION, 50, USER, TENANT, MANAGER_CALLER);

    expect(feedHasStoragePresence).toHaveBeenCalledTimes(1);
    // Not storage-tracked → no resolve, no movement, NO throw.
    expect(resolveFeedDeductionLocation).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    // Proceeds on the feed_inventory-only path and commits.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(result.executionId).toBe(EXECUTION);
  });

  it('(c) assertFeedable rejects an empty LOCKED batch and rolls back before any deduction', async () => {
    const { service, feedHasStoragePresence, recordMovement, commit, rollback } = makeHarness({
      lockedBatch: makeFeedableBatch({ currentQuantity: 0 }),
    });

    await expect(
      service.recordActualFeeding(EXECUTION, 50, USER, TENANT, MANAGER_CALLER),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Rejected at the feedability guard — never reached the storage path.
    expect(feedHasStoragePresence).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('assertFeedable rejects a non-feedable (HARVESTED) LOCKED batch and rolls back', async () => {
    const { service, recordMovement, commit, rollback } = makeHarness({
      lockedBatch: makeFeedableBatch({ status: BatchStatus.HARVESTED }),
    });

    await expect(
      service.recordActualFeeding(EXECUTION, 50, USER, TENANT, MANAGER_CALLER),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(recordMovement).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('fail-CLOSED: storage-tracked feed with no usable lot → reject + rollback', async () => {
    const { service, feedHasStoragePresence, recordMovement, commit, rollback } = makeHarness({
      hasStoragePresence: true,
      resolveLocation: null,
    });

    await expect(
      service.recordActualFeeding(EXECUTION, 50, USER, TENANT, MANAGER_CALLER),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(feedHasStoragePresence).toHaveBeenCalledTimes(1);
    // Presence but no lot → real shortage → no movement issued, rollback.
    expect(recordMovement).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('happy path: storage-tracked feed deducts IN-TX (OUT) and commits', async () => {
    const { service, recordMovement, resolveFeedDeductionLocation, commit, rollback } = makeHarness(
      {
        hasStoragePresence: true,
      },
    );

    const result = await service.recordActualFeeding(EXECUTION, 50, USER, TENANT, MANAGER_CALLER);

    expect(resolveFeedDeductionLocation).toHaveBeenCalledTimes(1);
    expect(recordMovement).toHaveBeenCalledTimes(1);
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
    expect(movementInput.idempotencyKey).toBe(`feeding-exec-deduct-${EXECUTION}`);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(result.executionId).toBe(EXECUTION);
  });
});
