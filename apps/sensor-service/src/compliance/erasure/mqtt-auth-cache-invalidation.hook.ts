import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import type { TenantErasurePostErasureHook } from '@aquaculture/backend-common/compliance';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

import { MqttAuthService } from '../../edge-device/mqtt-auth.service';

/**
 * Task 1.8 (100-tenant readiness plan): tenant-wide MQTT auth cache
 * invalidation on erasure.
 *
 * WHY: `MqttAuthService.tenantIdCache` holds device-username → tenantId
 * entries with a 5-minute TTL, and `negativeLookupCache` a 30-second
 * negative TTL. A freshly erased tenant's device credentials therefore
 * stay VALID for up to five minutes post-erasure — a captured credential
 * can keep publishing into the erased tenant's topics (and with the
 * outbox purge ordering, land in a fresh `sensor_outbox` row). This hook
 * drops every cache entry mapping to the erased tenant at erasure time.
 *
 * The hook is process-local by necessity (the caches are in-memory); a
 * multi-replica deploy invalidates on the replica that handled the
 * erasure and the TTL bounds the staleness window on the others — the
 * honest bound the plan documents (full broadcast is the Task 2 NATS
 * event surface, `events.*.TenantErased`).
 */
@Injectable()
export class MqttAuthCacheInvalidationHook implements TenantErasurePostErasureHook {
  private readonly logger = new Logger(MqttAuthCacheInvalidationHook.name);
  readonly hookName = 'sensor-mqtt-auth-cache-invalidation';

  constructor(private readonly mqttAuth: MqttAuthService) {}

  async onTenantErased(event: TenantErasureRequestedEvent, _manager: EntityManager): Promise<void> {
    const dropped = this.mqttAuth.invalidateEntriesForTenant(event.tenantId);
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped} MQTT auth cache entries for erased tenant ${event.tenantId.slice(0, 8)}… — replicas without this hook stay stale up to the 5-minute TTL`,
      );
    }
  }
}
