import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = '"farm"."tenant_erasure_audit"';

/**
 * COMPLIANCE-HIGH-003 — record the statutory-retention outcome of a
 * GDPR Art 17 erasure cascade on the durable audit row.
 *
 * The cascade no longer hard-deletes government-filed regulatory records
 * (regulatory_reports, biomass_reports). Under the Art 17(3)(b)
 * legal-obligation carve-out those rows are RETAINED and their
 * operator-identifying columns anonymised in place. These two columns
 * make that decision auditable:
 *   - retainedRowsByTable  — per-table count of rows kept under the
 *     carve-out (tableName → rowCount).
 *   - retainedRowsAnonymised — how many of those rows had a PII column
 *     hashed.
 * A regulator inspecting the audit row can see the controller made a
 * lawful, documented retention decision rather than silently failing to
 * erase.
 *
 * `tenant_erasure_audit` is cross-tenant farm-schema infrastructure
 * (`@SourceOnlyMigration` — never cloned into tenant schemas), so the
 * ALTER is schema-qualified and runs once against the source schema.
 * Blue-green safe: both columns are NOT NULL with a DEFAULT, so an
 * in-flight old-code INSERT that omits them still succeeds. Idempotent,
 * forward-only.
 */
@SourceOnlyMigration({
  reason:
    'tenant_erasure_audit is farm-schema cross-tenant infrastructure and must not be cloned into tenant schemas',
})
export class AddTenantErasureRetainedColumns1805100000000 implements MigrationInterface {
  name = 'AddTenantErasureRetainedColumns1805100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS "retainedRowsByTable" jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS "retainedRowsAnonymised" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS "retainedRowsAnonymised"`);
    await queryRunner.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS "retainedRowsByTable"`);
  }
}
