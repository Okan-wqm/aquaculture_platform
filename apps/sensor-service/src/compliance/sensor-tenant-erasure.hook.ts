import type { TenantErasurePostErasureHook } from '@aquaculture/backend-common/compliance';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ITenantEventMessageEraser } from '@platform/event-bus';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';
import type { EntityManager } from 'typeorm';

import { MqttAuthService } from '../edge-device/mqtt-auth.service';
import { SensorMetaCacheService } from '../ingestion/sensor-meta-cache.service';
import { SensorTopicCacheService } from '../ingestion/sensor-topic-cache.service';

export interface TenantTopicCacheEraser {
  eraseTenantCache(tenantId: string): Promise<void>;
}

export interface TenantMetaCacheEraser {
  invalidateTenant(tenantId: string): void;
}

export interface TenantMqttAuthCacheEraser {
  invalidateTenant(tenantId: string): void;
}

@Injectable()
export class SensorTenantErasureHook implements TenantErasurePostErasureHook {
  readonly hookName = 'sensor-ingress-routing-erasure';
  private readonly logger = new Logger(SensorTenantErasureHook.name);

  constructor(
    @Inject(SensorTopicCacheService)
    private readonly topicCache: TenantTopicCacheEraser,
    @Inject(SensorMetaCacheService)
    private readonly metaCache: TenantMetaCacheEraser,
    @Inject(MqttAuthService)
    private readonly mqttAuthCache: TenantMqttAuthCacheEraser,
    @Inject('EVENT_BUS')
    private readonly messageEraser: ITenantEventMessageEraser,
  ) {}

  async onTenantErased(event: TenantErasureRequestedEvent, manager: EntityManager): Promise<void> {
    await manager.query(`DELETE FROM "sensor"."edge_device_directory" WHERE "tenant_id" = $1`, [
      event.tenantId,
    ]);
    await this.topicCache.eraseTenantCache(event.tenantId);
    this.metaCache.invalidateTenant(event.tenantId);
    this.mqttAuthCache.invalidateTenant(event.tenantId);
    await this.messageEraser.eraseTenantMessages(event.tenantId);
    this.logger.log(
      `Sensor ingress routing erased for tenant=${event.tenantId} operation=${event.operationId}`,
    );
  }
}
