import { EntityManager } from 'typeorm';

import { ErasedTenantTombstoneService } from '../erased-tenant-tombstone.service';
import { MqttAuthCacheInvalidationHook } from '../mqtt-auth-cache-invalidation.hook';
import { PublishedOutboxPurgeHook } from '../published-outbox-purge.hook';
import { MqttAuthService } from '../../../edge-device/mqtt-auth.service';

/**
 * Task 1.8 (100-tenant readiness plan): the sensor-service erasure
 * extensions. The published-outbox purge deletes ONLY published rows for
 * the erased tenant (pending rows — including the erasure's own proof —
 * must survive); the MQTT-auth cache invalidation drops every entry
 * mapping to the tenant; the tombstone makes ingress ACK-drop erased
 * tenants' late messages instead of recreating data.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

function makeManager(): {
  manager: EntityManager;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params ?? [] });
    return ['', 3]; // [row, rowCount] — pg DELETE result shape
  });
  const managerPartial: Partial<EntityManager> = { query: query as never };
  return { manager: managerPartial as EntityManager, queries };
}

describe('PublishedOutboxPurgeHook (Task 1.8)', () => {
  it('deletes ONLY published rows for the erased tenant, inside the tx', async () => {
    const hook = new PublishedOutboxPurgeHook();
    const { manager, queries } = makeManager();

    await hook.onTenantErased({ tenantId: TENANT, dryRun: false } as never, manager);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('DELETE FROM "sensor"."sensor_outbox"');
    expect(queries[0]!.sql).toContain('"publishedAt" IS NOT NULL');
    expect(queries[0]!.params).toEqual([TENANT]);
  });

  it('is a no-op on dry-run (must not mutate the outbox)', async () => {
    const hook = new PublishedOutboxPurgeHook();
    const { manager, queries } = makeManager();

    await hook.onTenantErased({ tenantId: TENANT, dryRun: true } as never, manager);
    expect(queries).toHaveLength(0);
  });

  it('carries a stable hookName folded into the proof hash', () => {
    expect(new PublishedOutboxPurgeHook().hookName).toBe('sensor-published-outbox-purge');
  });
});

describe('MqttAuthCacheInvalidationHook (Task 1.8)', () => {
  it('drops every MQTT auth cache entry mapping to the erased tenant', async () => {
    const invalidate = jest.fn().mockReturnValue(2);
    const mqttAuthPartial: Partial<MqttAuthService> = {
      invalidateEntriesForTenant: invalidate as never,
    };
    const hook = new MqttAuthCacheInvalidationHook(mqttAuthPartial as MqttAuthService);
    const { manager } = makeManager();

    await hook.onTenantErased({ tenantId: TENANT, dryRun: false } as never, manager);

    expect(invalidate).toHaveBeenCalledWith(TENANT);
    expect(hook.hookName).toBe('sensor-mqtt-auth-cache-invalidation');
  });
});

describe('ErasedTenantTombstoneService (Task 1.8)', () => {
  it('ingress gate: isErased answers false until marked, then true', () => {
    const svc = new ErasedTenantTombstoneService({} as never);
    expect(svc.isErased(TENANT)).toBe(false);
    svc.markErased(TENANT);
    expect(svc.isErased(TENANT)).toBe(true);
    // Another tenant is unaffected.
    expect(svc.isErased('22222222-2222-4222-8222-222222222222')).toBe(false);
  });
});
