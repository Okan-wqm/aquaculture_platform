import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'tenant_erasure_target_proofs is source-schema infrastructure and must not be cloned into tenant schemas',
})
export class EnsureHrTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureHrTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'hr',
      tenantIndexName: 'idx_hr_erasure_proofs_tenant',
      eventIndexName: 'idx_hr_erasure_proofs_event',
      targetIndexName: 'idx_hr_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'hr',
      tenantIndexName: 'idx_hr_erasure_proofs_tenant',
      eventIndexName: 'idx_hr_erasure_proofs_event',
      targetIndexName: 'idx_hr_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }
}
