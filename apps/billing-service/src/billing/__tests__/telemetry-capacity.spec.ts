/**
 * Task 8 (100-tenant readiness plan) — telemetry capacity entitlement
 * invariants. The plan's two failing scenarios, locked as unit tests:
 *
 *   1. A reservation that does not fit the remaining platform envelope
 *      lands PENDING_CAPACITY — and `activate()` is the ONLY path to
 *      ACTIVE (it refuses while the envelope still cannot fit).
 *   2. While a pending (resize-up) version waits, the tenant's previous
 *      ACTIVE entitlement keeps working — the pending row never steals
 *      or pauses the active one.
 *
 * The service is exercised against an in-memory transactional double:
 * the EntityManager surface it touches is small (findOne/count/save/
 * create on the two entities + one raw SUM), which a typed fake covers
 * without a database.
 */

import { collaborator, stubMember } from '@aquaculture/testing';
import { DataSource, EntityManager } from 'typeorm';

import { TelemetryCapacityService } from '../services/telemetry-capacity.service';
import {
  TelemetryCapacityEntitlementState,
  TELEMETRY_PLATFORM_ENVELOPE,
} from '@platform/event-contracts';
import { TelemetryCapacityEntitlementEntity } from '../entities/telemetry-capacity-entitlement.entity';
import { BillingOutbox } from '../../outbox/billing-outbox.entity';

/**
 * The entitlement columns the fake stores, derived from the ENTITY rather
 * than re-declared beside it: a renamed or retyped column now breaks this
 * fixture at compile time instead of leaving the fake describing a table
 * that no longer exists.
 */
type StoredRow = Pick<
  TelemetryCapacityEntitlementEntity,
  'id' | 'tenantId' | 'version' | 'state' | 'm' | 'r' | 'observedRemainingM'
>;

/** What the service enqueues — the subset of the outbox row it fills in. */
type OutboxRow = Partial<BillingOutbox>;

/**
 * `satisfies` proves every entry is a real StoredRow key, so `row[key]` below
 * needs no cast at all — the blanket-cast index access this replaces checked
 * nothing and would have kept matching after a column rename.
 */
const STORED_ROW_KEYS = [
  'id',
  'tenantId',
  'version',
  'state',
  'm',
  'r',
  'observedRemainingM',
] as const satisfies readonly (keyof StoredRow)[];

const STORED_ROW_KEY_SET: ReadonlySet<string> = new Set(STORED_ROW_KEYS);

/**
 * TypeORM `where` matching over the modelled columns. An unmodelled column
 * throws instead of matching everything: a service that starts filtering on a
 * column this fake does not carry must fail loudly, not silently return every
 * row (which is how a capacity-envelope test goes green for the wrong reason).
 */
function matchesWhere(row: StoredRow, where: Partial<StoredRow>): boolean {
  for (const key of Object.keys(where)) {
    if (!STORED_ROW_KEY_SET.has(key)) {
      throw new Error(`FakeManager: where clause names an unmodelled column "${key}"`);
    }
  }
  return STORED_ROW_KEYS.every((key) => !(key in where) || row[key] === where[key]);
}

function isStoredRow(row: StoredRow | OutboxRow): row is StoredRow {
  return 'state' in row;
}

function upsertById<T extends { id?: string }>(bag: T[], row: T): T {
  const index = bag.findIndex((existing) => existing.id === row.id);
  if (index >= 0) bag[index] = row;
  else bag.push(row);
  return row;
}

/**
 * Minimal EntityManager double: entity-keyed row bags + the four methods
 * the service calls. Matches TypeORM's `manager.findOne(Entity, {where})`
 * surface (the repo-bypassing pattern the change-subscription handlers
 * use).
 */
class FakeManager {
  readonly tceRows: StoredRow[] = [];
  readonly outboxRows: OutboxRow[] = [];

  findOne(target: unknown, where: Partial<StoredRow>): Promise<StoredRow | null> {
    if (target !== TelemetryCapacityEntitlementEntity) return Promise.resolve(null);
    return Promise.resolve(this.tceRows.find((row) => matchesWhere(row, where)) ?? null);
  }

  count(target: unknown, where: Partial<StoredRow>): Promise<number> {
    if (target !== TelemetryCapacityEntitlementEntity) return Promise.resolve(0);
    return Promise.resolve(this.tceRows.filter((row) => matchesWhere(row, where)).length);
  }

  save(target: unknown, data: StoredRow | OutboxRow): Promise<StoredRow | OutboxRow> {
    if (target === TelemetryCapacityEntitlementEntity && isStoredRow(data)) {
      return Promise.resolve(upsertById(this.tceRows, data));
    }
    if (target === BillingOutbox && !isStoredRow(data)) {
      return Promise.resolve(upsertById(this.outboxRows, data));
    }
    throw new Error('FakeManager.save: unmodelled entity target');
  }

  activeM(): number {
    return this.tceRows
      .filter((row) => row.state === TelemetryCapacityEntitlementState.ACTIVE)
      .reduce((sum, row) => sum + row.m, 0);
  }

  /**
   * The typed EntityManager face the service is handed. `findOne`, `count`,
   * `create` and `save` are all generic over the entity, and a generic
   * signature is exactly what a single-signature fake cannot be assignable to
   * — `stubMember` carries that unavoidable cast per member while the
   * enclosing `collaborator` keeps every other EntityManager member checked,
   * so a new collaborator call names itself instead of arriving as undefined.
   */
  asEntityManager(): EntityManager {
    return collaborator<EntityManager>(
      {
        findOne: stubMember<EntityManager['findOne']>(
          (target: unknown, options: { where: Partial<StoredRow> }) =>
            this.findOne(target, options.where),
        ),
        count: stubMember<EntityManager['count']>(
          (target: unknown, options: { where: Partial<StoredRow> }) =>
            this.count(target, options.where),
        ),
        create: stubMember<EntityManager['create']>(
          (_target: unknown, data: StoredRow | OutboxRow) => data,
        ),
        save: stubMember<EntityManager['save']>((target: unknown, data: StoredRow | OutboxRow) =>
          this.save(target, data),
        ),
      },
      'EntityManager',
    );
  }
}

class FakeDataSource {
  readonly manager = new FakeManager();

  /** The typed DataSource face the service is constructed with. */
  asDataSource(): DataSource {
    const entityManager = this.manager.asEntityManager();
    return collaborator<DataSource>(
      {
        transaction: stubMember<DataSource['transaction']>(
          (runInTransaction: (manager: EntityManager) => Promise<unknown>) =>
            runInTransaction(entityManager),
        ),
        query: stubMember<DataSource['query']>(() =>
          Promise.resolve([{ total: String(this.manager.activeM()) }]),
        ),
      },
      'DataSource',
    );
  }
}

function makeService(): { service: TelemetryCapacityService; ds: FakeDataSource } {
  const ds = new FakeDataSource();
  const service = new TelemetryCapacityService(ds.asDataSource());
  return { service, ds };
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('TelemetryCapacityService (Task 8 entitlement machine)', () => {
  it('a reservation that fits the envelope activates immediately', async () => {
    const { service, ds } = makeService();
    const row = await service.reserve(TENANT_A, { m: 500, r: 900 }, crypto.randomUUID());
    expect(row.state).toBe(TelemetryCapacityEntitlementState.ACTIVE);
    expect(ds.manager.tceRows).toHaveLength(1);
  });

  it('a reservation beyond the remaining envelope lands PENDING_CAPACITY', async () => {
    const { service, ds } = makeService();
    // Fill the platform envelope from ANOTHER tenant.
    await service.reserve(
      TENANT_B,
      { m: TELEMETRY_PLATFORM_ENVELOPE.totalM, r: 3600 },
      crypto.randomUUID(),
    );

    const row = await service.reserve(TENANT_A, { m: 1, r: 10 }, crypto.randomUUID());
    expect(row.state).toBe(TelemetryCapacityEntitlementState.PENDING_CAPACITY);
    // …and it did NOT steal or pause the other tenant's active share.
    const bActive = ds.manager.tceRows.find((r) => r.tenantId === TENANT_B);
    expect(bActive?.state).toBe(TelemetryCapacityEntitlementState.ACTIVE);
  });

  it('activate() refuses while the envelope still cannot fit the pending values', async () => {
    const { service } = makeService();
    await service.reserve(
      TENANT_B,
      { m: TELEMETRY_PLATFORM_ENVELOPE.totalM, r: 3600 },
      crypto.randomUUID(),
    );
    await service.reserve(TENANT_A, { m: 400, r: 800 }, crypto.randomUUID());

    await expect(service.activate(TENANT_A)).rejects.toThrow(/activation refused.*resize proof/);
  });

  it('a pending resize-up never disturbs the previous ACTIVE version', async () => {
    const { service, ds } = makeService();
    // Tenant A active on a small slice…
    await service.reserve(TENANT_A, { m: 100, r: 200 }, crypto.randomUUID());
    // …the platform fills up elsewhere…
    await service.reserve(
      TENANT_B,
      { m: TELEMETRY_PLATFORM_ENVELOPE.totalM - 100, r: 3600 },
      crypto.randomUUID(),
    );
    // …A asks for MORE than remains → pending, while v1 stays ACTIVE.
    await service.reserve(TENANT_A, { m: 300, r: 600 }, crypto.randomUUID());

    const aRows = ds.manager.tceRows.filter((r) => r.tenantId === TENANT_A);
    expect(aRows).toHaveLength(2);
    expect(aRows.find((r) => r.version === 1)?.state).toBe(
      TelemetryCapacityEntitlementState.ACTIVE,
    );
    expect(aRows.find((r) => r.version === 2)?.state).toBe(
      TelemetryCapacityEntitlementState.PENDING_CAPACITY,
    );
  });

  it('activate() supersedes the old ACTIVE row and flips the pending one, atomically', async () => {
    const { service, ds } = makeService();
    // Tenant A active on a small slice…
    await service.reserve(TENANT_A, { m: 100, r: 200 }, crypto.randomUUID());
    // …the platform fills up completely…
    await service.reserve(
      TENANT_B,
      { m: TELEMETRY_PLATFORM_ENVELOPE.totalM - 100, r: 3000 },
      crypto.randomUUID(),
    );
    // …so A's resize-up must pend (0 headroom remains).
    const pendingA = await service.reserve(TENANT_A, { m: 300, r: 600 }, crypto.randomUUID());
    expect(pendingA.state).toBe(TelemetryCapacityEntitlementState.PENDING_CAPACITY);

    // B's subscription ends — the headroom returns.
    await service.release(TENANT_B);

    const activated = await service.activate(TENANT_A);
    expect(activated.state).toBe(TelemetryCapacityEntitlementState.ACTIVE);

    const aRows = ds.manager.tceRows.filter((r) => r.tenantId === TENANT_A);
    expect(aRows.find((r) => r.version === 1)?.state).toBe(
      TelemetryCapacityEntitlementState.SUPERSEDED,
    );
    // Exactly one ACTIVE row per tenant after the flip.
    expect(aRows.filter((r) => r.state === TelemetryCapacityEntitlementState.ACTIVE)).toHaveLength(
      1,
    );
  });

  it('every state transition enqueues the outbox event in the same transaction', async () => {
    const { service, ds } = makeService();
    await service.reserve(TENANT_A, { m: 10, r: 20 }, crypto.randomUUID());
    expect(ds.manager.outboxRows).toHaveLength(1);
    expect(ds.manager.outboxRows[0]?.eventType).toBe('TelemetryCapacityEntitlementChanged');
  });

  it('a retried reserve with the same idempotency key resolves to the same row', async () => {
    const { service, ds } = makeService();
    const key = crypto.randomUUID();
    const first = await service.reserve(TENANT_A, { m: 10, r: 20 }, key);
    const retry = await service.reserve(TENANT_A, { m: 10, r: 20 }, key);
    expect(retry.id).toBe(first.id);
    expect(ds.manager.tceRows).toHaveLength(1);
  });
});
