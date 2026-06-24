import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'tenant_erasure_target_proofs is a source-schema proof ledger for notification-service erasure responses',
})
export class EnsureNotificationTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureNotificationTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}
