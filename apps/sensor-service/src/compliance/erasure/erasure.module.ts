import { Module } from '@nestjs/common';

import { MqttAuthService } from '../../edge-device/mqtt-auth.service';
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
  providers: [
    PublishedOutboxPurgeHook,
    MqttAuthCacheInvalidationHook,
    ErasedTenantTombstoneService,
    // MqttAuthService is provided by EdgeDeviceModule; this module only
    // needs the class token resolvable for the hook's constructor.
    MqttAuthService,
  ],
  exports: [PublishedOutboxPurgeHook, MqttAuthCacheInvalidationHook, ErasedTenantTombstoneService],
})
export class SensorErasureModule {}
