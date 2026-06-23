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
export class EnsureHydroponicsTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureHydroponicsTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}
