import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

@Entity({ schema: 'sensor', name: 'sensor_outbox', synchronize: false })
@Index('idx_sensor_outbox_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_sensor_outbox_tenant_entity', ['tenantId'])
@Index('idx_sensor_outbox_idempotency_entity', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class SensorOutbox extends OutboxEntityBase {}
