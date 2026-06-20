import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationOutbox1800300000000 implements MigrationInterface {
  name = 'CreateNotificationOutbox1800300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'notification',
      table: 'notification_outbox',
      pollIndexName: 'idx_notification_outbox_poll',
      tenantIndexName: 'idx_notification_outbox_tenant',
      idempotencyIndexName: 'idx_notification_outbox_idempotency',
      notifyFunctionName: 'notify_notification_outbox_new',
      notifyTriggerName: 'notification_outbox_notify_trigger',
      notifyChannel: 'notification_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'notification',
      tenantIndexName: 'idx_notification_erasure_proofs_tenant',
      eventIndexName: 'idx_notification_erasure_proofs_event',
      targetIndexName: 'idx_notification_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'notification',
      tenantIndexName: 'idx_notification_erasure_proofs_tenant',
      eventIndexName: 'idx_notification_erasure_proofs_event',
      targetIndexName: 'idx_notification_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'notification',
      table: 'notification_outbox',
      pollIndexName: 'idx_notification_outbox_poll',
      tenantIndexName: 'idx_notification_outbox_tenant',
      idempotencyIndexName: 'idx_notification_outbox_idempotency',
      notifyFunctionName: 'notify_notification_outbox_new',
      notifyTriggerName: 'notification_outbox_notify_trigger',
      notifyChannel: 'notification_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
