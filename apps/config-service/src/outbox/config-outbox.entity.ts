import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

/**
 * config-service transactional outbox (DB-INFRA-HIGH-003).
 *
 * config-service was onboarded to the event backbone solely to be a GDPR
 * tenant-erasure target: the `TenantErasureTargetExecutor` enqueues its erasure
 * proof events here, and the shared `OutboxWorker` publishes them to NATS.
 * Mirrors `billing-service`'s billing_outbox — all columns inherited from
 * `OutboxEntityBase`; `synchronize:false` because the migration owns the DDL.
 */
@Entity({ schema: 'config', name: 'config_outbox', synchronize: false })
@Index('idx_config_outbox_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_config_outbox_tenant_entity', ['tenantId'])
@Index('idx_config_outbox_idempotency_entity', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class ConfigOutbox extends OutboxEntityBase {}
