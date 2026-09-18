import type { EventBusHealth, IEventBus } from '@platform/event-bus';
import type { TenantProvisionedEvent } from '@platform/event-contracts';

import { getTenantSchemaName } from '../tenant-schema.utils';

import { TenantSchemaCacheInvalidationSubscriber } from './tenant-schema-cache-invalidation.subscriber';
import { TenantSchemaCacheService } from './tenant-schema-cache.service';

const HEALTHY: EventBusHealth = { isHealthy: true, connectionState: 'connected' };

/**
 * Fully-typed IEventBus double — every method stubbed so it slots into the
 * subscriber's `EVENT_BUS` slot with NO forced type assertion (the gate
 * forbids double casts; a complete mock satisfies jest.Mocked<IEventBus>).
 */
function makeMockEventBus(): jest.Mocked<IEventBus> {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
    publishBatch: jest.fn().mockResolvedValue(undefined),
    publishTo: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    subscribeForTenant: jest.fn().mockResolvedValue(undefined),
    subscribeTo: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribeFrom: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getHealth: jest.fn().mockResolvedValue(HEALTHY),
  };
}

/**
 * Proves the new-tenant guarantee: a freshly provisioned tenant is NOT blocked
 * by a stale negative schema-existence cache. The subscriber clears the shared
 * cache the instant `TenantProvisioned` fires, so the next schema-existence
 * check re-queries instead of serving the stale "does not exist" result.
 */
describe('TenantSchemaCacheInvalidationSubscriber (new-tenant negative-cache closure)', () => {
  const TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const SCHEMA_NAME = getTenantSchemaName(TENANT_ID); // tenant_1111111111114111

  function provisioned(tenantId: string): TenantProvisionedEvent {
    return {
      eventType: 'TenantProvisioned',
      tenantId,
      operationId: 'op-1',
      name: 'Acme',
      slug: 'acme',
    } as TenantProvisionedEvent;
  }

  it(
    'end-to-end: a request that lands BEFORE provisioning caches a negative, ' +
      'and TenantProvisioned clears it so the very next check re-queries',
    async () => {
      const cache = new TenantSchemaCacheService();
      const subscriber = new TenantSchemaCacheInvalidationSubscriber(cache, undefined);

      let dbChecks = 0;

      // T0: request arrives before aqua-db-migrate created the schema → negative cached.
      const before = await cache.getOrCheck(SCHEMA_NAME, () => {
        dbChecks += 1;
        return Promise.resolve(false);
      });
      expect(before).toBe(false);
      expect(dbChecks).toBe(1);

      // T1: schema now exists in the DB, but a second check within the 30s
      // negative TTL would WITHOUT invalidation still serve the stale `false`
      // (checker not invoked) — this is the bug.
      const stale = await cache.getOrCheck(SCHEMA_NAME, () => {
        dbChecks += 1;
        return Promise.resolve(true);
      });
      expect(stale).toBe(false);
      expect(dbChecks).toBe(1); // served from negative cache — checker NOT called

      // T2: provisioning completes → TenantProvisioned → subscriber invalidates.
      await subscriber.handle(provisioned(TENANT_ID));

      // T3: the next check re-queries the DB and sees the freshly created schema.
      const after = await cache.getOrCheck(SCHEMA_NAME, () => {
        dbChecks += 1;
        return Promise.resolve(true);
      });
      expect(after).toBe(true);
      expect(dbChecks).toBe(2); // negative entry was cleared → checker ran again
    },
  );

  it('subscribes to TenantProvisioned on init when an event bus is present', async () => {
    const cache = new TenantSchemaCacheService();
    const eventBus = makeMockEventBus();
    const subscriber = new TenantSchemaCacheInvalidationSubscriber(cache, eventBus);

    await subscriber.onModuleInit();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('TenantProvisioned', subscriber);
    expect(subscriber.getEventType()).toBe('TenantProvisioned');
  });

  it('boots without an event bus (dev/test) — falls back to negative TTL only', async () => {
    const cache = new TenantSchemaCacheService();
    const subscriber = new TenantSchemaCacheInvalidationSubscriber(cache, undefined);
    await expect(subscriber.onModuleInit()).resolves.toBeUndefined();
  });

  it('ignores events with a missing or malformed tenantId (no cross-tenant flush)', async () => {
    const cache = new TenantSchemaCacheService();
    const invalidateSpy = jest.spyOn(cache, 'invalidate');
    const subscriber = new TenantSchemaCacheInvalidationSubscriber(cache, undefined);

    await expect(subscriber.handle(provisioned(''))).resolves.toEqual(
      expect.objectContaining({ kind: 'terminate' }),
    );
    await expect(subscriber.handle(provisioned('not-a-uuid'))).resolves.toEqual(
      expect.objectContaining({ kind: 'terminate' }),
    );
    // The platform segment is a valid scope but not a tenant — terminated too.
    await expect(subscriber.handle(provisioned('system'))).resolves.toEqual(
      expect.objectContaining({ kind: 'terminate' }),
    );

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates exactly the provisioned tenant schema key', async () => {
    const cache = new TenantSchemaCacheService();
    const invalidateSpy = jest.spyOn(cache, 'invalidate');
    const subscriber = new TenantSchemaCacheInvalidationSubscriber(cache, undefined);

    await subscriber.handle(provisioned(TENANT_ID));

    expect(invalidateSpy).toHaveBeenCalledWith(SCHEMA_NAME);
  });
});
