import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { buildTransactionalOutboxDownSql, buildTransactionalOutboxUpSql } from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-INFRA-HIGH-003 — event-store-service transactional outbox.
 *
 * event-store-service was onboarded to the event backbone to be a GDPR
 * tenant-erasure target; the executor enqueues erasure proof events to this
 * outbox and the shared worker relays them to NATS. Source-schema table in
 * `event_store`. The proof ledger is created by the sibling
 * EnsureEventStoreTenantErasureProofLedger migration.
 */
@SourceOnlyMigration({
  reason: 'event_store_outbox is a source-schema transactional outbox for event-store-service',
})
export class CreateEventStoreOutbox1800300000000 implements MigrationInterface {
  name = 'CreateEventStoreOutbox1800300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'event_store',
      table: 'event_store_outbox',
      pollIndexName: 'idx_event_store_outbox_poll',
      tenantIndexName: 'idx_event_store_outbox_tenant',
      idempotencyIndexName: 'idx_event_store_outbox_idempotency',
      notifyFunctionName: 'notify_event_store_outbox_new',
      notifyTriggerName: 'event_store_outbox_notify_trigger',
      notifyChannel: 'event_store_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'event_store',
      table: 'event_store_outbox',
      pollIndexName: 'idx_event_store_outbox_poll',
      tenantIndexName: 'idx_event_store_outbox_tenant',
      idempotencyIndexName: 'idx_event_store_outbox_idempotency',
      notifyFunctionName: 'notify_event_store_outbox_new',
      notifyTriggerName: 'event_store_outbox_notify_trigger',
      notifyChannel: 'event_store_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
