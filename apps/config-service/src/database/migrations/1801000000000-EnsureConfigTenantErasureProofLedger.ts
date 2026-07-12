import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-INFRA-HIGH-003 — config-service tenant-erasure proof ledger.
 *
 * The immutable proof ledger the TenantErasureTargetExecutor writes an erasure
 * proof row to (per operationId) before enqueuing the TenantDataErased event.
 * Source-schema table in `config`. Tracked by the tenant-erasure-ssot invariant
 * (TARGET_PROOF_LEDGER_FORWARD_MIGRATIONS). Mirrors billing's Ensure migration.
 */
@SourceOnlyMigration({
  reason:
    'tenant_erasure_target_proofs is a source-schema proof ledger for config-service erasure responses',
})
export class EnsureConfigTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureConfigTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'config',
      tenantIndexName: 'idx_config_erasure_proofs_tenant',
      eventIndexName: 'idx_config_erasure_proofs_event',
      targetIndexName: 'idx_config_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'config',
      tenantIndexName: 'idx_config_erasure_proofs_tenant',
      eventIndexName: 'idx_config_erasure_proofs_event',
      targetIndexName: 'idx_config_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }
}
