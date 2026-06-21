import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

@Entity({ schema: 'alert', name: 'alert_outbox', synchronize: false })
@Index('idx_alert_outbox_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_alert_outbox_tenant_entity', ['tenantId'])
@Index('idx_alert_outbox_idempotency_entity', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class AlertOutbox extends OutboxEntityBase {}
