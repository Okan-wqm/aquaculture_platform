import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAlertOutbox1800200000000 implements MigrationInterface {
  name = 'CreateAlertOutbox1800200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'alert',
      table: 'alert_outbox',
      pollIndexName: 'idx_alert_outbox_poll',
      tenantIndexName: 'idx_alert_outbox_tenant',
      idempotencyIndexName: 'idx_alert_outbox_idempotency',
      notifyFunctionName: 'notify_alert_outbox_new',
      notifyTriggerName: 'alert_outbox_notify_trigger',
      notifyChannel: 'alert_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'alert',
      tenantIndexName: 'idx_alert_erasure_proofs_tenant',
      eventIndexName: 'idx_alert_erasure_proofs_event',
      targetIndexName: 'idx_alert_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'alert',
      tenantIndexName: 'idx_alert_erasure_proofs_tenant',
      eventIndexName: 'idx_alert_erasure_proofs_event',
      targetIndexName: 'idx_alert_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'alert',
      table: 'alert_outbox',
      pollIndexName: 'idx_alert_outbox_poll',
      tenantIndexName: 'idx_alert_outbox_tenant',
      idempotencyIndexName: 'idx_alert_outbox_idempotency',
      notifyFunctionName: 'notify_alert_outbox_new',
      notifyTriggerName: 'alert_outbox_notify_trigger',
      notifyChannel: 'alert_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
