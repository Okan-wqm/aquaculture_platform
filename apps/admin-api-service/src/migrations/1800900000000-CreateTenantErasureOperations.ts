import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTenantErasureOperations1800900000000
  implements MigrationInterface
{
  name = 'CreateTenantErasureOperations1800900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_erasure_operations (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        status varchar(32) NOT NULL,
        "requestedBy" varchar(255) NOT NULL,
        reason varchar(500) NOT NULL,
        "requestedAt" timestamptz NOT NULL,
        "legalHoldCheckedAt" timestamptz NOT NULL,
        "targetServices" text[] NOT NULL,
        proofs jsonb NOT NULL DEFAULT '{}'::jsonb,
        failures jsonb NOT NULL DEFAULT '[]'::jsonb,
        "proofHash" varchar(255),
        "schemaDeletionJobId" uuid,
        "schemaDeletionRequestedAt" timestamptz,
        "schemaDeletedAt" timestamptz,
        "completedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_tenant_erasure_operations_status
          CHECK (status IN ('IN_PROGRESS', 'BLOCKED', 'FAILED', 'COMPLETED')),
        CONSTRAINT chk_tenant_erasure_operations_targets_nonempty
          CHECK (cardinality("targetServices") > 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tenant_erasure_operations_tenant_status
        ON admin.tenant_erasure_operations ("tenantId", status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tenant_erasure_operations_status
        ON admin.tenant_erasure_operations (status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tenant_erasure_operations_schema_job
        ON admin.tenant_erasure_operations ("schemaDeletionJobId")
        WHERE "schemaDeletionJobId" IS NOT NULL
    `);
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'admin',
      tenantIndexName: 'idx_admin_erasure_proofs_tenant',
      eventIndexName: 'idx_admin_erasure_proofs_event',
      targetIndexName: 'idx_admin_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'admin',
      tenantIndexName: 'idx_admin_erasure_proofs_tenant',
      eventIndexName: 'idx_admin_erasure_proofs_event',
      targetIndexName: 'idx_admin_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      'DROP INDEX IF EXISTS admin.idx_tenant_erasure_operations_schema_job',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS admin.idx_tenant_erasure_operations_status',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS admin.idx_tenant_erasure_operations_tenant_status',
    );
    await queryRunner.query('DROP TABLE IF EXISTS admin.tenant_erasure_operations');
  }
}
