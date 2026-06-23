import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'tenant_erasure_target_proofs is a source-schema proof ledger for billing-service erasure responses',
})
export class EnsureBillingTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureBillingTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}
