import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddBatchInputTypeSmolt1803300000000
 *
 * Adds the 'SMOLT' label to the batch input-type enum (RPT-016a) — a distinct
 * regulatory lifecycle stage for the settefisk report, aligning the Postgres
 * enum with the TypeScript SSoT (batch.types.ts BatchInputType).
 *
 * # Tenant fan-out (current_schema-relative — load-bearing)
 *
 * `batches_v2_inputtype_enum` exists ONLY in the `farm` schema (Baseline creates
 * it `farm`-qualified); tenant_<uuid> clones' `batches_v2` reference it
 * cross-schema with no local copy. db-migrate fans this out with search_path
 * pinned per-schema: the `farm` run adds the value to the shared type; every
 * per-tenant run finds no local type and MUST skip — a bare `ALTER TYPE` there
 * throws 42704 and fails the deploy. Each ALTER is type-presence-guarded in
 * current_schema, mirroring AddCullMortalityAuditEnumValues1801300000000.
 *
 * # Blue-green safety
 *
 * Additive enum values are inherently blue-green safe (no NOT NULL backfill).
 * MIGRATION FIRST, CODE SECOND: db-migrate is the sole schema writer and runs
 * before farm-service restart, so 'SMOLT' exists in every schema before any new
 * handler can persist it; old code ignores the extra label.
 */
export class AddBatchInputTypeSmolt1803300000000 implements MigrationInterface {
  name = 'AddBatchInputTypeSmolt1803300000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same transaction;
  // additive + IF NOT EXISTS guarded, so statement-level autocommit is safe and
  // idempotent on re-run (mirrors AddCullMortalityAuditEnumValues).
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValueIfTypePresent(queryRunner, 'batches_v2_inputtype_enum', 'SMOLT');
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema — the
   * `farm` run applies it to the shared type; per-tenant runs (type absent by
   * design) skip. typeName/value are migration-internal literals, no injection
   * surface.
   */
  private async addEnumValueIfTypePresent(
    queryRunner: QueryRunner,
    typeName: string,
    value: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = current_schema()
             AND t.typname = '${typeName}'
        ) THEN
          ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS '${value}';
        END IF;
      END
      $$;
    `);
  }

  /**
   * Fail-closed: 'SMOLT' exists wherever the enum type is present in the ACTIVE
   * schema. Counted missing ONLY when the type exists in current_schema but
   * lacks the label — so the `farm` run fail-closes on a genuinely missing
   * value while per-tenant runs (type absent by design) pass.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH expected(typ, label) AS (VALUES
        ('batches_v2_inputtype_enum', 'SMOLT'))
      SELECT COUNT(*)::text AS missing
        FROM expected x
       WHERE EXISTS (
         SELECT 1
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema()
            AND t.typname = x.typ
       )
         AND NOT EXISTS (
         SELECT 1
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = current_schema()
            AND t.typname = x.typ
            AND e.enumlabel = x.label
       )
    `)) as Array<{ missing: string }>;
    return rows[0]?.missing === '0';
  }

  public async down(): Promise<void> {
    // Enum values cannot be dropped in PostgreSQL without recreating the type;
    // additive labels are forward-only (matches the enum-value migration norm).
  }
}
