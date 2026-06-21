import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHydroponicsOutbox1800100000000 implements MigrationInterface {
  name = 'CreateHydroponicsOutbox1800100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'hydroponics',
      table: 'hydroponics_outbox',
      pollIndexName: 'idx_hydroponics_outbox_poll',
      tenantIndexName: 'idx_hydroponics_outbox_tenant',
      idempotencyIndexName: 'idx_hydroponics_outbox_idempotency',
      notifyFunctionName: 'notify_hydroponics_outbox_new',
      notifyTriggerName: 'hydroponics_outbox_notify_trigger',
      notifyChannel: 'hydroponics_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'hydroponics',
      tenantIndexName: 'idx_hydroponics_erasure_proofs_tenant',
      eventIndexName: 'idx_hydroponics_erasure_proofs_event',
      targetIndexName: 'idx_hydroponics_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'hydroponics',
      tenantIndexName: 'idx_hydroponics_erasure_proofs_tenant',
      eventIndexName: 'idx_hydroponics_erasure_proofs_event',
      targetIndexName: 'idx_hydroponics_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'hydroponics',
      table: 'hydroponics_outbox',
      pollIndexName: 'idx_hydroponics_outbox_poll',
      tenantIndexName: 'idx_hydroponics_outbox_tenant',
      idempotencyIndexName: 'idx_hydroponics_outbox_idempotency',
      notifyFunctionName: 'notify_hydroponics_outbox_new',
      notifyTriggerName: 'hydroponics_outbox_notify_trigger',
      notifyChannel: 'hydroponics_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
