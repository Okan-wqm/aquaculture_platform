import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBillingOutbox1800600000000 implements MigrationInterface {
  name = 'CreateBillingOutbox1800600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'billing',
      table: 'billing_outbox',
      pollIndexName: 'idx_billing_outbox_poll',
      tenantIndexName: 'idx_billing_outbox_tenant',
      idempotencyIndexName: 'idx_billing_outbox_idempotency',
      notifyFunctionName: 'notify_billing_outbox_new',
      notifyTriggerName: 'billing_outbox_notify_trigger',
      notifyChannel: 'billing_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'billing',
      tenantIndexName: 'idx_billing_erasure_proofs_tenant',
      eventIndexName: 'idx_billing_erasure_proofs_event',
      targetIndexName: 'idx_billing_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'billing',
      tenantIndexName: 'idx_billing_erasure_proofs_tenant',
      eventIndexName: 'idx_billing_erasure_proofs_event',
      targetIndexName: 'idx_billing_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'billing',
      table: 'billing_outbox',
      pollIndexName: 'idx_billing_outbox_poll',
      tenantIndexName: 'idx_billing_outbox_tenant',
      idempotencyIndexName: 'idx_billing_outbox_idempotency',
      notifyFunctionName: 'notify_billing_outbox_new',
      notifyTriggerName: 'billing_outbox_notify_trigger',
      notifyChannel: 'billing_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
