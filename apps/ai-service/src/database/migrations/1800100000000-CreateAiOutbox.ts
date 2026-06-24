import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiOutbox1800100000000 implements MigrationInterface {
  name = 'CreateAiOutbox1800100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'ai',
      table: 'ai_outbox',
      pollIndexName: 'idx_ai_outbox_poll',
      tenantIndexName: 'idx_ai_outbox_tenant',
      idempotencyIndexName: 'idx_ai_outbox_idempotency',
      notifyFunctionName: 'notify_ai_outbox_new',
      notifyTriggerName: 'ai_outbox_notify_trigger',
      notifyChannel: 'ai_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'ai',
      tenantIndexName: 'idx_ai_erasure_proofs_tenant',
      eventIndexName: 'idx_ai_erasure_proofs_event',
      targetIndexName: 'idx_ai_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'ai',
      tenantIndexName: 'idx_ai_erasure_proofs_tenant',
      eventIndexName: 'idx_ai_erasure_proofs_event',
      targetIndexName: 'idx_ai_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'ai',
      table: 'ai_outbox',
      pollIndexName: 'idx_ai_outbox_poll',
      tenantIndexName: 'idx_ai_outbox_tenant',
      idempotencyIndexName: 'idx_ai_outbox_idempotency',
      notifyFunctionName: 'notify_ai_outbox_new',
      notifyTriggerName: 'ai_outbox_notify_trigger',
      notifyChannel: 'ai_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
