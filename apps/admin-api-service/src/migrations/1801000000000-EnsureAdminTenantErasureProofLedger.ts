import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'tenant_erasure_target_proofs is a source-schema proof ledger for admin-api-service erasure responses',
})
export class EnsureAdminTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureAdminTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'admin',
      tenantIndexName: 'idx_admin_erasure_proofs_tenant',
      eventIndexName: 'idx_admin_erasure_proofs_event',
      targetIndexName: 'idx_admin_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'admin',
      tenantIndexName: 'idx_admin_erasure_proofs_tenant',
      eventIndexName: 'idx_admin_erasure_proofs_event',
      targetIndexName: 'idx_admin_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }
}
