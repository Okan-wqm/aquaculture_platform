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

import { TelemetryCapacityService } from '../services/telemetry-capacity.service';
import {
  TelemetryCapacityEntitlementState,
  TELEMETRY_PLATFORM_ENVELOPE,
} from '@platform/event-contracts';
import { TelemetryCapacityEntitlementEntity } from '../entities/telemetry-capacity-entitlement.entity';
import { BillingOutbox } from '../../outbox/billing-outbox.entity';

interface StoredRow {
  id: string;
  tenantId: string;
  version: number;
  state: TelemetryCapacityEntitlementState;
  m: number;
  r: number;
  observedRemainingM?: number | null;
}

/**
 * Minimal EntityManager double: entity-keyed row bags + the four methods
 * the service calls. Matches TypeORM's `manager.findOne(Entity, {where})`
 * surface (the repo-bypassing pattern the change-subscription handlers
 * use).
 */
class FakeManager {
  tceRows: StoredRow[] = [];
  outboxRows: unknown[] = [];

  private bagFor(target: unknown): StoredRow[] | null {
    if (target === TelemetryCapacityEntitlementEntity) return this.tceRows;
    if (target === BillingOutbox) return this.outboxRows as StoredRow[];
    return null;
  }

  findOne(target: unknown, { where }: { where: Partial<StoredRow> }): Promise<StoredRow | null> {
    const bag = this.bagFor(target);
    const hit = bag?.find((row) =>
      Object.entries(where).every(([k, v]) => (row as never)[k] === v),
    );
    return Promise.resolve(hit ?? null);
  }

  count(target: unknown, { where }: { where: Partial<StoredRow> }): Promise<number> {
    const bag = this.bagFor(target) ?? [];
    return Promise.resolve(
      bag.filter((row) => Object.entries(where).every(([k, v]) => (row as never)[k] === v)).length,
    );
  }

  create(_target: unknown, data: StoredRow): StoredRow {
    return data;
  }

  save(_target: unknown, data: StoredRow): Promise<StoredRow> {
    const bag = this.bagFor(_target);
    const idx = bag?.findIndex((row) => row.id === data.id) ?? -1;
    if (idx >= 0 && bag) bag[idx] = data;
    else bag?.push(data);
    return Promise.resolve(data);
  }
}

class FakeDataSource {
  manager = new FakeManager();

  transaction<T>(fn: (manager: FakeManager) => Promise<T>): Promise<T> {
    return fn(this.manager);
  }

  query(): Promise<Array<{ total: string | null }>> {
    const activeM = this.manager.tceRows
      .filter((row) => row.state === TelemetryCapacityEntitlementState.ACTIVE)
      .reduce((sum, row) => sum + row.m, 0);
    return Promise.resolve([{ total: String(activeM) }]);
  }
}

function makeService(): { service: TelemetryCapacityService; ds: FakeDataSource } {
  const ds = new FakeDataSource();
  const service = new TelemetryCapacityService(ds as never);
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
    expect((ds.manager.outboxRows[0] as { eventType?: string }).eventType).toBe(
      'TelemetryCapacityEntitlementChanged',
    );
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
