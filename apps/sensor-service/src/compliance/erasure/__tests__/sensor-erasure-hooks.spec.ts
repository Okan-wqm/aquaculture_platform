import { collaborator, stub, stubMember } from '@aquaculture/testing';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

import { EdgeRouteDirectoryPurgeHook } from '../edge-route-directory-purge.hook';
import { ErasedTenantTombstoneService } from '../erased-tenant-tombstone.service';
import { PublishedOutboxPurgeHook } from '../published-outbox-purge.hook';

/**
 * Task 1.8 (100-tenant readiness plan): the sensor-service erasure
 * extensions. The published-outbox purge deletes ONLY published rows for
 * the erased tenant (pending rows — including the erasure's own proof —
 * must survive); the route purge drops the tenant's rows from the two
 * cross-tenant directories; the tombstone makes ingress ACK-drop erased tenants'
 * late messages instead of recreating data.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

/**
 * The erasure event the hooks read. `stub` type-checks the two fields the
 * hooks touch against the real contract, so a rename in
 * `TenantErasureRequestedEvent` breaks this fixture instead of silently
 * feeding the hooks `undefined`. The rest of `BaseEvent` is deliberately
 * absent — `eventId` is branded and only `createBaseEvent()` may mint one,
 * and no hook reads it.
 */
function erasureEvent(dryRun: boolean): TenantErasureRequestedEvent {
  return stub<TenantErasureRequestedEvent>({ tenantId: TENANT, dryRun });
}

function makeManager(): {
  manager: EntityManager;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params ?? [] });
    return ['', 3]; // [row, rowCount] — pg DELETE result shape
  });
  // `collaborator`, not `stub`: this stands in for BEHAVIOUR, so a hook that
  // grows a second EntityManager call fails naming the missing member instead
  // of dying on `undefined is not a function`. `query` is generic
  // (`query<T>(...): Promise<T>`), which no single-signature jest.fn can
  // satisfy — `stubMember` is the one place that cast is allowed to live, and
  // it still forces this call site to name the member's real type.
  const manager = collaborator<EntityManager>(
    { query: stubMember<EntityManager['query']>(query) },
    'EntityManager',
  );
  return { manager, queries };
}

describe('PublishedOutboxPurgeHook (Task 1.8)', () => {
  it('deletes ONLY published rows for the erased tenant, inside the tx', async () => {
    const hook = new PublishedOutboxPurgeHook();
    const { manager, queries } = makeManager();

    await hook.onTenantErased(erasureEvent(false), manager);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('DELETE FROM "sensor"."sensor_outbox"');
    expect(queries[0]!.sql).toContain('"publishedAt" IS NOT NULL');
    expect(queries[0]!.params).toEqual([TENANT]);
  });

  it('is a no-op on dry-run (must not mutate the outbox)', async () => {
    const hook = new PublishedOutboxPurgeHook();
    const { manager, queries } = makeManager();

    await hook.onTenantErased(erasureEvent(true), manager);
    expect(queries).toHaveLength(0);
  });

  it('carries a stable hookName folded into the proof hash', () => {
    expect(new PublishedOutboxPurgeHook().hookName).toBe('sensor-published-outbox-purge');
  });
});

describe('EdgeRouteDirectoryPurgeHook (SENSOR-HIGH-175)', () => {
  it("deletes the erased tenant's device and provisioning-key routes, inside the tx", async () => {
    const hook = new EdgeRouteDirectoryPurgeHook();
    const { manager, queries } = makeManager();

    await hook.onTenantErased(erasureEvent(false), manager);

    expect(queries.map((q) => q.sql)).toEqual([
      'DELETE FROM "sensor"."edge_device_directory" WHERE "tenant_id" = $1',
      'DELETE FROM "sensor"."tenant_provisioning_key_directory" WHERE "tenant_id" = $1',
    ]);
    expect(queries.every((q) => q.params[0] === TENANT)).toBe(true);
    expect(hook.hookName).toBe('sensor-edge-route-directory-purge');
  });

  it('is a no-op on dry-run', async () => {
    const hook = new EdgeRouteDirectoryPurgeHook();
    const { manager, queries } = makeManager();

    await hook.onTenantErased(erasureEvent(true), manager);
    expect(queries).toHaveLength(0);
  });
});

describe('ErasedTenantTombstoneService (Task 1.8)', () => {
  it('ingress gate: isErased answers false until marked, then true', () => {
    // An EMPTY collaborator is the assertion: the ingress gate is pure
    // in-memory state, so any DataSource access from these three calls throws
    // MissingDoubleMemberError naming the member instead of passing silently.
    const svc = new ErasedTenantTombstoneService(collaborator<DataSource>({}, 'DataSource'));
    expect(svc.isErased(TENANT)).toBe(false);
    svc.markErased(TENANT);
    expect(svc.isErased(TENANT)).toBe(true);
    // Another tenant is unaffected.
    expect(svc.isErased('22222222-2222-4222-8222-222222222222')).toBe(false);
  });
});
