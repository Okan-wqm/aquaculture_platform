import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { buildTransactionalOutboxDownSql, buildTransactionalOutboxUpSql } from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-INFRA-HIGH-003 — config-service transactional outbox.
 *
 * config-service was onboarded to the event backbone solely to be a GDPR
 * tenant-erasure target; the target executor enqueues erasure proof events to
 * this outbox and the shared worker relays them to NATS. Source-schema table in
 * `config` (cross-tenant infrastructure, never per-tenant cloned). Mirrors
 * billing's CreateBillingOutbox. The proof ledger is created by the sibling
 * EnsureConfigTenantErasureProofLedger migration.
 */
@SourceOnlyMigration({
  reason: 'config_outbox is a source-schema transactional outbox for config-service',
})
export class CreateConfigOutbox1800600000000 implements MigrationInterface {
  name = 'CreateConfigOutbox1800600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'config',
      table: 'config_outbox',
      pollIndexName: 'idx_config_outbox_poll',
      tenantIndexName: 'idx_config_outbox_tenant',
      idempotencyIndexName: 'idx_config_outbox_idempotency',
      notifyFunctionName: 'notify_config_outbox_new',
      notifyTriggerName: 'config_outbox_notify_trigger',
      notifyChannel: 'config_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'config',
      table: 'config_outbox',
      pollIndexName: 'idx_config_outbox_poll',
      tenantIndexName: 'idx_config_outbox_tenant',
      idempotencyIndexName: 'idx_config_outbox_idempotency',
      notifyFunctionName: 'notify_config_outbox_new',
      notifyTriggerName: 'config_outbox_notify_trigger',
      notifyChannel: 'config_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
