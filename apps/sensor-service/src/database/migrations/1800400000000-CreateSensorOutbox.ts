import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSensorOutbox1800400000000 implements MigrationInterface {
  name = 'CreateSensorOutbox1800400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTransactionalOutboxUpSql({
      schema: 'sensor',
      table: 'sensor_outbox',
      pollIndexName: 'idx_sensor_outbox_poll',
      tenantIndexName: 'idx_sensor_outbox_tenant',
      idempotencyIndexName: 'idx_sensor_outbox_idempotency',
      notifyFunctionName: 'notify_sensor_outbox_new',
      notifyTriggerName: 'sensor_outbox_notify_trigger',
      notifyChannel: 'sensor_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'sensor',
      tenantIndexName: 'idx_sensor_erasure_proofs_tenant',
      eventIndexName: 'idx_sensor_erasure_proofs_event',
      targetIndexName: 'idx_sensor_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'sensor',
      tenantIndexName: 'idx_sensor_erasure_proofs_tenant',
      eventIndexName: 'idx_sensor_erasure_proofs_event',
      targetIndexName: 'idx_sensor_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    for (const sql of buildTransactionalOutboxDownSql({
      schema: 'sensor',
      table: 'sensor_outbox',
      pollIndexName: 'idx_sensor_outbox_poll',
      tenantIndexName: 'idx_sensor_outbox_tenant',
      idempotencyIndexName: 'idx_sensor_outbox_idempotency',
      notifyFunctionName: 'notify_sensor_outbox_new',
      notifyTriggerName: 'sensor_outbox_notify_trigger',
      notifyChannel: 'sensor_outbox_notify',
    })) {
      await queryRunner.query(sql);
    }
  }
}
