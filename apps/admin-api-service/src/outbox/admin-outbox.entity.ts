import { OutboxEntityBase } from '@platform/outbox';
import { Entity, Index } from 'typeorm';

@Entity({ schema: 'admin', name: 'admin_outbox', synchronize: false })
@Index('idx_admin_outbox_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_admin_outbox_tenant', ['tenantId'])
@Index('idx_admin_outbox_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class AdminOutbox extends OutboxEntityBase {}
