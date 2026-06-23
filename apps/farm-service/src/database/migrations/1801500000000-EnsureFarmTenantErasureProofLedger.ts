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
export class EnsureFarmTenantErasureProofLedger1801500000000 implements MigrationInterface {
  name = 'EnsureFarmTenantErasureProofLedger1801500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'farm',
      tenantIndexName: 'idx_farm_erasure_proofs_tenant',
      eventIndexName: 'idx_farm_erasure_proofs_event',
      targetIndexName: 'idx_farm_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'farm',
      tenantIndexName: 'idx_farm_erasure_proofs_tenant',
      eventIndexName: 'idx_farm_erasure_proofs_event',
      targetIndexName: 'idx_farm_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }
}
