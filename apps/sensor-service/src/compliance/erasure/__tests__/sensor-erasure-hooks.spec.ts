import { collaborator, stub, stubMember } from '@aquaculture/testing';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

import { ErasedTenantTombstoneService } from '../erased-tenant-tombstone.service';
import { MqttAuthCacheInvalidationHook } from '../mqtt-auth-cache-invalidation.hook';
import { PublishedOutboxPurgeHook } from '../published-outbox-purge.hook';
import { MqttAuthService } from '../../../edge-device/mqtt-auth.service';
import { MqttAuthController } from '../../../edge-device/mqtt-auth.controller';
import { EdgeDeviceModule } from '../../../edge-device/edge-device.module';
import { SensorErasureModule } from '../erasure.module';

/**
 * Task 1.8 (100-tenant readiness plan): the sensor-service erasure
 * extensions. The published-outbox purge deletes ONLY published rows for
 * the erased tenant (pending rows — including the erasure's own proof —
 * must survive); the MQTT-auth cache invalidation drops every entry
 * mapping to the tenant; the tombstone makes ingress ACK-drop erased
 * tenants' late messages instead of recreating data.
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

describe('MqttAuthCacheInvalidationHook (Task 1.8)', () => {
  it('resolves the production modules and invalidates the same MQTT cache used by the HTTP controller', async () => {
    // Only persistence/configuration are doubles. Both production modules,
    // their provider ownership, the controller and MQTT cache remain real.
    const dataSource = new DataSource({ type: 'postgres' });
    const query = jest.spyOn(dataSource, 'query').mockResolvedValue([]);
    @Global()
    @Module({
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: new ConfigService({ NODE_ENV: 'test', MQTT_AUTH_MODE: 'http' }) },
      ],
      exports: [DataSource, ConfigService],
    })
    class ErasurePersistenceFixtureModule {}
    const module = await Test.createTestingModule({
      imports: [ErasurePersistenceFixtureModule, EdgeDeviceModule, SensorErasureModule],
    }).compile();
    try {
      const controller = module.select(EdgeDeviceModule).get(MqttAuthController, { strict: true });
      const hook = module.select(SensorErasureModule).get(MqttAuthCacheInvalidationHook, { strict: true });
      const username = 'erasure-cache-device';
      const request = { username, topic: `tenants/${TENANT}/devices/${username}/telemetry`, acc: 2 };
      query.mockResolvedValueOnce([{ tenant_id: TENANT }]).mockResolvedValueOnce([
        { id: '33333333-3333-4333-8333-333333333333', tenant_id: TENANT,
          mqtt_client_id: username, device_code: 'erasure-device', lifecycle_state: 'active' },
      ]);
      await expect(controller.checkAcl({}, request)).resolves.toBe('ok');
      const lookups = query.mock.calls.length;
      // Backing rows are now absent, but a second request still uses the cache.
      await expect(controller.checkAcl({}, request)).resolves.toBe('ok');
      expect(query).toHaveBeenCalledTimes(lookups);
      await hook.onTenantErased(erasureEvent(false), makeManager().manager);
      // Erasure must evict the controller's cache, not a separately injected copy.
      await expect(controller.checkAcl({}, request)).rejects.toThrow('Denied');
      expect(query.mock.calls.length).toBeGreaterThan(lookups);
    } finally {
      await module.close();
      query.mockRestore();
    }
  });

  it('drops every MQTT auth cache entry mapping to the erased tenant', async () => {
    const invalidate = jest.fn().mockReturnValue(2);
    const mqttAuth = collaborator<MqttAuthService>(
      { invalidateEntriesForTenant: invalidate },
      'MqttAuthService',
    );
    const hook = new MqttAuthCacheInvalidationHook(mqttAuth);
    const { manager } = makeManager();

    await hook.onTenantErased(erasureEvent(false), manager);

    expect(invalidate).toHaveBeenCalledWith(TENANT);
    expect(hook.hookName).toBe('sensor-mqtt-auth-cache-invalidation');
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
