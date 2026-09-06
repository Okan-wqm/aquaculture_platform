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
  imports: [EdgeDeviceModule],
  providers: [
    PublishedOutboxPurgeHook,
    MqttAuthCacheInvalidationHook,
    ErasedTenantTombstoneService,
  ],
  exports: [PublishedOutboxPurgeHook, MqttAuthCacheInvalidationHook, ErasedTenantTombstoneService],
})
export class SensorErasureModule {}
