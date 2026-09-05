/**
 * StockMovementService Unit Tests
 *
 * Pins the Phase-A feed dual-SSoT write-path-correctness properties:
 *
 *   - recordMovement(OUT) is FAIL-CLOSED: it THROWS (BadRequestException)
 *     when the located lot has insufficient stock, and when no lot exists
 *     in the source location. Because the caller owns the transaction, that
 *     throw rolls the caller's whole unit of work back — which is what ends
 *     the old silent swallow.
 *   - recordMovement(OUT) decrements the lot and writes the immutable
 *     StockMovement audit row on the happy path.
 *   - recordMovement honours the idempotency key (no double-deduct on
 *     replay).
 *   - resolveFeedDeductionLocation returns the FEFO lot/location, and null
 *     when nothing usable is in stock (so feeding callers can fail-closed).
 *
 * The service consumes its repositories exclusively through
 * `tenantManagerRepo(manager, Entity, tenantId)`, which fetches the per-entity
 * repository off the EntityManager and wraps it in the REAL
 * TenantScopedRepository. The doubles below expose the plain Repository
 * surface (findOne / save / remove / create / createQueryBuilder) and the
 * real tenant wrapper sits on top. Each double is built through a typed
 * mock factory so no banned casts are needed.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Role } from '@aquaculture/backend-common/decorators';
import { OutboxPublisher } from '@platform/outbox';

import { StockMovementService } from '../services/stock-movement.service';
import { StockMutationLockAuthority } from '../services/stock-mutation-lock.authority';
import { FeedAllocationService } from '../services/feed-allocation.service';
import { LotMixService } from '../services/lot-mix.service';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StorageLocation } from '../entities/storage-location.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { stub } from '@aquaculture/testing';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = '33333333-3333-4333-8333-333333333333';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const SITE = '44444444-4444-4444-8444-444444444444';
const USER = '44444444-4444-4444-8444-444444444444';

/**
 * Build a fully-typed partial double for an interface T. Every accessed
 * member is supplied as a jest.fn or value; the single `as T` keeps the
 * double assignable without a double cast.
 */
function tenantRepositoryMetadata<T extends ObjectLiteral>(): Repository<T>['metadata'] {
  const tenantColumn = stub<
    NonNullable<ReturnType<Repository<T>['metadata']['findColumnWithPropertyName']>>
  >({
    databaseName: 'tenantId',
  });

  return stub<Repository<T>['metadata']>({
    findColumnWithPropertyName: jest.fn((propertyName: string) =>
      propertyName === 'tenantId' ? tenantColumn : undefined,
    ),
  });
}

/** A chainable query-builder double whose terminal getters are configurable. */
function makeQueryBuilder(terminal: {
  getOne?: StorageInventory | null;
  getRawOne?: { total: string };
}): SelectQueryBuilder<StorageInventory> {
  const qb = stub<SelectQueryBuilder<StorageInventory>>({});
  const chain = (): SelectQueryBuilder<StorageInventory> => qb;
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.select = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.addOrderBy = jest.fn(chain);
  qb.setLock = jest.fn(chain);
  qb.getOne = jest.fn().mockResolvedValue(terminal.getOne ?? null);
  qb.getRawOne = jest.fn().mockResolvedValue(terminal.getRawOne ?? { total: '0' });
  return qb;
}

interface RepoDoubles {
  inventory: Repository<StorageInventory>;
  inventorySave: jest.Mock;
  movementCreate: jest.Mock;
  movementSave: jest.Mock;
}

interface HarnessOpts {
  /** Lot returned by the lot-specific decrement read (null = no lot found). */
  fromLot?: StorageInventory | null;
  /** Source location lookup result (null = location not found). */
  fromLocation?: StorageLocation | null;
  /** Feed item-details lookup (null = item not found). */
  feed?: Feed | null;
  /** Existing movement for the idempotency key (null = none). */
  existingMovement?: StockMovement | null;
  /** Plan the doubled FEFO allocator returns behind resolveFeedDeductionLocation. */
  allocation?: {
    slices: Array<{ storageLocationId: string; lotNumber?: string; quantityKg: number }>;
    usedSiteFallback: boolean;
    poolTotalKg: number;
  };
  /** Post-decrement aggregate SUM returned for the item (default '250'). */
  aggregateTotal?: string;
}

function inv(over: Partial<StorageInventory>): StorageInventory {
  return stub<StorageInventory>({
    id: 'inv-1',
    tenantId: TENANT,
    storageLocationId: LOCATION,
    itemType: StorageItemType.FEED,
    itemId: FEED,
    quantity: 500,
    unit: 'kg',
    lotNumber: 'LOT-A',
    ...over,
  });
}

function makeHarness(opts: HarnessOpts = {}): {
  service: StockMovementService;
  acquireItemLock: jest.Mock;
  acquireIdempotencyLock: jest.Mock;
  allocateForDeduction: jest.Mock;
  manager: EntityManager;
  repos: RepoDoubles;
  outboxEnqueue: jest.Mock;
} {
  const fromLot = opts.fromLot === undefined ? null : opts.fromLot;
  const feed =
    opts.feed === undefined
      ? stub<Feed>({ id: FEED, name: 'Grower 4mm', unit: 'kg', minStock: 100 })
      : opts.feed;
  const fromLocation =
    opts.fromLocation === undefined
      ? stub<StorageLocation>({ id: LOCATION, tenantId: TENANT, siteId: 'site-1' })
      : opts.fromLocation;

  // Repository.save / remove / create and EntityManager.getRepository are
  // heavily overloaded. The doubles are left UN-annotated (jest.fn() →
  // Mock<any>) so they remain structurally assignable to those members with
  // no cast; behaviour is supplied via mockImplementation / mockResolvedValue.
  const inventorySave = jest.fn();
  inventorySave.mockImplementation(async (row: StorageInventory) => row);
  const inventoryRemove = jest.fn();
  inventoryRemove.mockImplementation(async (row: StorageInventory) => row);
  // The real TenantScopedRepository.save() calls repository.create() then
  // repository.save(); the double's create is a pass-through identity so the
  // wrapper's save reflects the mutated row.
  const inventoryCreate = jest.fn();
  inventoryCreate.mockImplementation((dto: Partial<StorageInventory>) => dto);
  const inventoryRepo = stub<Repository<StorageInventory>>({
    metadata: tenantRepositoryMetadata<StorageInventory>(),
    findOne: jest.fn().mockResolvedValue(fromLot),
    save: inventorySave,
    remove: inventoryRemove,
    create: inventoryCreate,
    // The decrement (lot read) and the post-op aggregate both use the qb. The
    // FEFO resolve no longer reads here at all — it lives behind
    // resolveFeedDeductionLocation in FeedAllocationService, which this harness
    // doubles.
    createQueryBuilder: jest.fn(() =>
      makeQueryBuilder({
        getOne: fromLot,
        getRawOne: { total: opts.aggregateTotal ?? '250' },
      }),
    ),
  });

  const locationRepo = stub<Repository<StorageLocation>>({
    metadata: tenantRepositoryMetadata<StorageLocation>(),
    findOne: jest.fn().mockResolvedValue(fromLocation),
  });

  const movementCreate = jest.fn();
  movementCreate.mockImplementation((dto: Partial<StockMovement>) =>
    stub<StockMovement>({ ...dto }),
  );
  const movementSave = jest.fn();
  movementSave.mockImplementation(async (row: StockMovement) =>
    stub<StockMovement>({ ...row, id: 'mv-1' }),
  );
  const movementRepo = stub<Repository<StockMovement>>({
    metadata: tenantRepositoryMetadata<StockMovement>(),
    findOne: jest.fn().mockResolvedValue(opts.existingMovement ?? null),
    create: movementCreate,
    save: movementSave,
  });

  const feedCreate = jest.fn();
  feedCreate.mockImplementation((dto: Partial<Feed>) => dto);
  const feedSave = jest.fn();
  feedSave.mockImplementation(async (row: Feed) => row);
  const feedRepo = stub<Repository<Feed>>({
    metadata: tenantRepositoryMetadata<Feed>(),
    findOne: jest.fn().mockResolvedValue(feed),
    // updateItemTotalQuantity rolls the aggregate back onto Feed.quantity via
    // the wrapper's save (which calls create then save) — both passthrough.
    create: feedCreate,
    save: feedSave,
  });

  const getRepository = jest.fn();
  getRepository.mockImplementation((entity: unknown): unknown => {
    if (entity === StorageInventory) return inventoryRepo;
    if (entity === StorageLocation) return locationRepo;
    if (entity === StockMovement) return movementRepo;
    if (entity === Feed) return feedRepo;
    throw new Error(`unexpected repository request: ${String(entity)}`);
  });
  const manager = stub<EntityManager>({ getRepository });

  const lotMix = stub<LotMixService>({
    detect: jest.fn().mockResolvedValue({ mixCreated: false, mix: null, effectiveLotNumber: null }),
  });
  const outboxEnqueue = jest.fn();
  outboxEnqueue.mockResolvedValue(undefined);
  const outboxPublisher = stub<OutboxPublisher>({ enqueue: outboxEnqueue });
  // Advisory kilit gerçek bir transaction ister; bu harness sahte bir manager
  // kullandığı için kilit otoritesi double'lanır. Kilidin GERÇEK davranışı
  // `stock-mutation-lock.authority.spec.ts` ve PG lane'inde pinlenir.
  const acquireItemLock = jest.fn();
  acquireItemLock.mockResolvedValue(undefined);
  const acquireIdempotencyLock = jest.fn();
  acquireIdempotencyLock.mockResolvedValue(undefined);
  const mutationLocks = stub<StockMutationLockAuthority>({
    acquire: acquireItemLock,
    acquireIdempotency: acquireIdempotencyLock,
  });
  // Tahsis motoru double'lanır: bu harness sahte bir manager kullanıyor ve
  // motorun GERÇEK davranışı `feed-allocation.service.spec.ts` + PG lane'inde
  // pinli. Buradaki soru "resolveFeedDeductionLocation motora TEK giriş mi"dir.
  const allocateForDeduction = jest.fn();
  allocateForDeduction.mockImplementation(async () =>
    opts.allocation === undefined
      ? { slices: [], usedSiteFallback: false, poolTotalKg: 0 }
      : opts.allocation,
  );
  const feedAllocation = stub<FeedAllocationService>({ allocateForDeduction });
  const service = new StockMovementService(
    lotMix,
    new SiteAuthorizationService(),
    outboxPublisher,
    mutationLocks,
    feedAllocation,
  );

  return {
    service,
    acquireItemLock,
    acquireIdempotencyLock,
    allocateForDeduction,
    manager,
    repos: { inventory: inventoryRepo, inventorySave, movementCreate, movementSave },
    outboxEnqueue,
  };
}

function outInput(quantity: number): Parameters<StockMovementService['recordMovement']>[1] {
  return {
    movementType: MovementType.OUT,
    itemType: StorageItemType.FEED,
    itemId: FEED,
    quantity,
    fromLocationId: LOCATION,
    lotNumber: 'LOT-A',
  };
}

describe('StockMovementService.recordMovement — SEC-HIGH-051 sink site-authz', () => {
  // The sink enforces object-level site authorization ONLY for a direct operator
  // movement (ctx.siteAuthorization present). A MODULE_USER not assigned to the
  // touched location's site is DENIED before any inventory mutation (fail-closed).
  it('denies a MODULE_USER not assigned to the location site (fail-closed)', async () => {
    const { service, manager, repos } = makeHarness({ fromLot: inv({ quantity: 500 }) });

    await expect(
      service.recordMovement(manager, outInput(50), {
        tenantId: TENANT,
        userId: USER,
        siteAuthorization: {
          sub: USER,
          roles: [Role.MODULE_USER],
          assignedSiteIds: ['site-OTHER'],
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Deny precedes the decrement — no write happened.
    expect(repos.inventorySave).not.toHaveBeenCalled();
  });

  it('allows a MODULE_USER assigned to the location site', async () => {
    const { service, manager } = makeHarness({ fromLot: inv({ quantity: 500 }) });

    const result = await service.recordMovement(manager, outInput(50), {
      tenantId: TENANT,
      userId: USER,
      siteAuthorization: { sub: USER, roles: [Role.MODULE_USER], assignedSiteIds: ['site-1'] },
    });
    expect(result.idempotentHit).toBe(false);
  });

  it('does NOT gate a feeding caller that omits siteAuthorization', async () => {
    const { service, manager } = makeHarness({ fromLot: inv({ quantity: 500 }) });

    // Feeding authorizes on the FEEDING site at its own sink, so the internal
    // feed-deduction movement passes no siteAuthorization and is not re-gated.
    const result = await service.recordMovement(manager, outInput(50), {
      tenantId: TENANT,
      userId: USER,
    });
    expect(result.idempotentHit).toBe(false);
  });
});

describe('StockMovementService.recordMovement (OUT, fail-closed)', () => {
  it('throws when the located lot has insufficient stock (rolls back caller tx)', async () => {
    const { service, manager } = makeHarness({ fromLot: inv({ quantity: 5 }) });

    await expect(
      service.recordMovement(manager, outInput(50), { tenantId: TENANT, userId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when no lot exists in the source location (no silent no-op)', async () => {
    const { service, manager } = makeHarness({ fromLot: null });

    await expect(
      service.recordMovement(manager, outInput(50), { tenantId: TENANT, userId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when the feed item does not exist', async () => {
    const { service, manager } = makeHarness({ feed: null });

    await expect(
      service.recordMovement(manager, outInput(50), { tenantId: TENANT, userId: USER }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('decrements the lot and writes the audit row on the happy path', async () => {
    const { service, manager, repos } = makeHarness({ fromLot: inv({ quantity: 500 }) });

    const result = await service.recordMovement(manager, outInput(50), {
      tenantId: TENANT,
      userId: USER,
    });

    // Lot decremented 500 -> 450 and saved (not removed).
    expect(repos.inventorySave).toHaveBeenCalled();
    const savedInv = repos.inventorySave.mock.calls[0]![0] as StorageInventory;
    expect(savedInv.quantity).toBe(450);
    // Immutable audit row created + persisted. (movementCreate is invoked both
    // by the service and again inside the tenant wrapper's save(), so assert it
    // ran rather than an exact count.)
    expect(repos.movementCreate).toHaveBeenCalled();
    expect(repos.movementSave).toHaveBeenCalledTimes(1);
    expect(result.idempotentHit).toBe(false);
    expect(result.saved.id).toBe('mv-1');
  });

  it('is idempotent: a matching key returns the existing movement without re-deducting', async () => {
    const { service, manager, repos } = makeHarness({
      existingMovement: stub<StockMovement>({ id: 'mv-existing' }),
    });

    const result = await service.recordMovement(
      manager,
      { ...outInput(50), idempotencyKey: 'feeding-deduct-rec-1' },
      { tenantId: TENANT, userId: USER },
    );

    expect(result.idempotentHit).toBe(true);
    expect(result.saved.id).toBe('mv-existing');
    // No inventory mutation on an idempotent replay.
    expect(repos.inventorySave).not.toHaveBeenCalled();
    expect(repos.movementSave).not.toHaveBeenCalled();
  });

  it('throws when quantity is not positive', async () => {
    const { service, manager } = makeHarness();
    await expect(
      service.recordMovement(manager, outInput(0), { tenantId: TENANT, userId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StockMovementService.resolveFeedDeductionLocation', () => {
  it('is the single entry point: it delegates to the FEFO allocator, verbatim', async () => {
    const plan = {
      slices: [{ storageLocationId: LOCATION, lotNumber: 'LOT-A', quantityKg: 12 }],
      usedSiteFallback: false,
      poolTotalKg: 40,
    };
    const { service, manager, allocateForDeduction } = makeHarness({ allocation: plan });
    const asOf = new Date('2026-05-05T00:00:00.000Z');

    const result = await service.resolveFeedDeductionLocation(
      manager,
      TENANT,
      FEED,
      12,
      asOf,
      'LOT-A',
      SITE,
    );

    expect(result).toBe(plan);
    expect(allocateForDeduction).toHaveBeenCalledWith(manager, TENANT, {
      feedId: FEED,
      quantityKg: 12,
      asOf,
      lotNumber: 'LOT-A',
      siteId: SITE,
    });
  });

  it('propagates the allocator shortage instead of returning a no-deduction result', async () => {
    // FARM-CRITICAL-237: there is NO non-deducting success path. A shortage must
    // reach the caller as a failure, never as an empty/absent location that a
    // caller could read as "this feed is simply not storage-tracked".
    const { service, manager, allocateForDeduction } = makeHarness();
    allocateForDeduction.mockRejectedValue(new BadRequestException('pool short'));

    await expect(
      service.resolveFeedDeductionLocation(manager, TENANT, FEED, 12, new Date()),
    ).rejects.toThrow('pool short');
  });
});

describe('StockMovementService.recordMovement — single low-stock sink', () => {
  // The durable LowStockDetected signal is enqueued AT THE MUTATION CORE so
  // every stock-reducing writer (manual movement, feeding deduction, PO
  // receipt) emits it on the caller's transactional manager. Previously the
  // detection lived only in the RecordStockMovementHandler wrapper, so
  // feeding-driven depletion never raised it (FARM-HIGH-217 dead chain).
  const ctx = { tenantId: TENANT, userId: USER };

  it('enqueues LowStockDetected (low_stock) when the aggregate falls to/below minStock', async () => {
    const { service, manager, outboxEnqueue } = makeHarness({
      fromLot: inv({ quantity: 500 }),
      aggregateTotal: '80', // feed minStock default is 100
    });

    const result = await service.recordMovement(manager, outInput(50), ctx);

    expect(result.lowStock).toEqual({ severity: 'low_stock', minimumThreshold: 100 });
    expect(outboxEnqueue).toHaveBeenCalledTimes(1);
    const [event, passedManager] = outboxEnqueue.mock.calls[0];
    expect(event.eventType).toBe('LowStockDetected');
    expect(event).toMatchObject({
      itemType: StorageItemType.FEED,
      itemId: FEED,
      itemName: 'Grower 4mm',
      currentQuantity: 80,
      unit: 'kg',
      minimumThreshold: 100,
      severity: 'low_stock',
    });
    expect(passedManager).toBe(manager); // same caller transaction — atomic with the decrement
  });

  it('enqueues out_of_stock when the aggregate reaches zero', async () => {
    const { service, manager, outboxEnqueue } = makeHarness({
      fromLot: inv({ quantity: 500 }),
      aggregateTotal: '0',
    });

    const result = await service.recordMovement(manager, outInput(50), ctx);

    expect(result.lowStock?.severity).toBe('out_of_stock');
    expect(outboxEnqueue.mock.calls[0][0].severity).toBe('out_of_stock');
  });

  it('stays silent when the aggregate remains above minStock', async () => {
    const { service, manager, outboxEnqueue } = makeHarness({
      fromLot: inv({ quantity: 500 }),
      aggregateTotal: '250',
    });

    const result = await service.recordMovement(manager, outInput(50), ctx);

    expect(result.lowStock).toBeNull();
    expect(outboxEnqueue).not.toHaveBeenCalled();
  });

  it('does not evaluate low stock for inbound movements', async () => {
    const { service, manager, outboxEnqueue } = makeHarness({ aggregateTotal: '0' });

    const result = await service.recordMovement(
      manager,
      {
        movementType: MovementType.IN,
        itemType: StorageItemType.FEED,
        itemId: FEED,
        quantity: 10,
        toLocationId: LOCATION,
      },
      ctx,
    );

    expect(result.lowStock).toBeNull();
    expect(outboxEnqueue).not.toHaveBeenCalled();
  });

  it('does not re-enqueue on an idempotent replay', async () => {
    const { service, manager, outboxEnqueue } = makeHarness({
      existingMovement: stub<StockMovement>({ id: 'mv-existing' }),
      aggregateTotal: '0',
    });

    const result = await service.recordMovement(
      manager,
      { ...outInput(50), idempotencyKey: 'k-1' },
      ctx,
    );

    expect(result.idempotentHit).toBe(true);
    expect(result.lowStock).toBeNull();
    expect(outboxEnqueue).not.toHaveBeenCalled();
  });
});
