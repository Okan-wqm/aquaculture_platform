import { Module } from '@nestjs/common';

import { EdgeRouteDirectoryPurgeHook } from './edge-route-directory-purge.hook';
import { ErasedTenantTombstoneService } from './erased-tenant-tombstone.service';
import { PublishedOutboxPurgeHook } from './published-outbox-purge.hook';

export { EdgeRouteDirectoryPurgeHook } from './edge-route-directory-purge.hook';
export { PublishedOutboxPurgeHook } from './published-outbox-purge.hook';

/**
 * Task 1.8 (100-tenant readiness plan): the sensor-service erasure
 * extension — the published-outbox purge and the edge route-directory purge
 * post-erasure hooks + the erased-tenant tombstone the ingress gate consults.
 *
 * The hooks run inside the executor's erasure transaction, which is bound to
 * the erased tenant's RLS context before anything else runs (the shared
 * TenantErasureTargetExecutor); without that binding every DELETE under the
 * pool's FORCE RLS matched zero rows. Each hook returns the rows it removed,
 * which the proof records next to its name.
 *
 * There is no MQTT auth cache hook: MqttAuthService keeps no positive device
 * cache (every CONNECT and ACL check reads the device row), so an erased
 * tenant's devices stop resolving once the erasure has removed their rows and
 * routes.
 */
@Module({
  providers: [PublishedOutboxPurgeHook, EdgeRouteDirectoryPurgeHook, ErasedTenantTombstoneService],
  exports: [PublishedOutboxPurgeHook, EdgeRouteDirectoryPurgeHook, ErasedTenantTombstoneService],
})
export class SensorErasureModule {}
