import { Module } from '@nestjs/common';

import { EdgeDeviceModule } from '../../edge-device/edge-device.module';
import { ErasedTenantTombstoneService } from './erased-tenant-tombstone.service';
import { MqttAuthCacheInvalidationHook } from './mqtt-auth-cache-invalidation.hook';
import { PublishedOutboxPurgeHook } from './published-outbox-purge.hook';

export { MqttAuthCacheInvalidationHook } from './mqtt-auth-cache-invalidation.hook';
export { PublishedOutboxPurgeHook } from './published-outbox-purge.hook';

/**
 * Task 1.8 (100-tenant readiness plan): the sensor-service erasure
 * extension — post-erasure hooks (published-outbox purge, MQTT auth cache
 * invalidation) + the erased-tenant tombstone the ingress gate consults.
 */
@Module({
  // MqttAuthCacheInvalidationHook needs the ONE MqttAuthService instance the
  // MQTT auth controller serves from — its in-memory cache is what the hook
  // invalidates. Importing EdgeDeviceModule (which exports it) resolves that
  // instance. Listing MqttAuthService under `providers` here instead made
  // Nest build a SECOND instance inside this module, where its
  // @InjectRepository(EdgeDevice) dependency does not exist: sensor-service
  // failed to boot on every deploy of main since 65753cb90 (2026-09-20
  // outage, SENSOR-CRITICAL-127), and had it resolved, the hook would have
  // purged a cache no request ever read. tests/invariants/
  // nest-module-provider-duplication.spec.ts bans the pattern.
  imports: [EdgeDeviceModule],
  providers: [
    PublishedOutboxPurgeHook,
    MqttAuthCacheInvalidationHook,
    ErasedTenantTombstoneService,
  ],
  exports: [PublishedOutboxPurgeHook, MqttAuthCacheInvalidationHook, ErasedTenantTombstoneService],
})
export class SensorErasureModule {}
