import { Module } from '@nestjs/common';

import { ErasedTenantTombstoneService } from './erased-tenant-tombstone.service';
import { PublishedOutboxPurgeHook } from './published-outbox-purge.hook';

export { PublishedOutboxPurgeHook } from './published-outbox-purge.hook';

/**
 * Task 1.8 (100-tenant readiness plan): the sensor-service erasure
 * extension — the published-outbox purge post-erasure hook + the
 * erased-tenant tombstone the ingress gate consults.
 *
 * There is no MQTT auth cache hook: MqttAuthService keeps no positive
 * device cache (every CONNECT and ACL check reads the device row), so an
 * erased tenant's devices stop resolving the moment their rows are gone.
 */
@Module({
  providers: [PublishedOutboxPurgeHook, ErasedTenantTombstoneService],
  exports: [PublishedOutboxPurgeHook, ErasedTenantTombstoneService],
})
export class SensorErasureModule {}
