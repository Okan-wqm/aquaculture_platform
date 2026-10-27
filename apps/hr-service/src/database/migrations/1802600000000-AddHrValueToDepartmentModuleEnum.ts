import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddHrValueToDepartmentModuleEnum1802600000000
 *
 * Additive enum-value alignment for HR-MEDIUM-064 (module boundaries PKG-01 PR1, release R1).
 * `departments_hr_modulecode_enum` was created with farm, hydroponics and sensor only
 * (1802400000000), so a unit HR itself owns could only be stored as NULL, which hr-service reads
 * as company-wide. hr is an owner module (owner decision D4): the entity's column now takes the
 * module dictionary's owner modules (`OWNER_MODULE`, shared-contracts), and this brings the
 * Postgres type into line with them:
 *
 *   - departments_hr_modulecode_enum += 'hr'
 *
 * No row changes: moving the NULL units to hr is owner decision D7, a counted step of its own
 * (PKG-18).
 *
 * # Tenant fan-out (current_schema-relative — load-bearing)
 *
 * The type is created UNQUALIFIED, once per schema: db-migrate pins search_path to `hr` OR
 * `tenant_<id>` and replays 1802400000000 into each, so every schema that ran it holds its own
 * copy, and a tenant cloned from the source schema may reference the source's copy instead of one
 * of its own. This migration therefore issues an UNQUALIFIED `ALTER TYPE` guarded on the type
 * existing in current_schema: wherever a copy exists it gains the label, and a schema without one
 * skips instead of throwing 42704 "type does not exist" and failing the whole deploy — the exact
 * shape of AddChemicalTherapeuticTypes1805900000000 (farm).
 *
 * # Casing (load-bearing — verified against 1802400000000)
 *
 * The labels are the lowercase module codes ('farm', 'hydroponics', 'sensor'), so the new label is
 * 'hr', the dictionary's code. A casing slip produces a value the entity cannot round-trip.
 *
 * # Blue-green safety
 *
 * An additive enum value is blue-green safe: db-migrate is the sole schema writer and runs BEFORE
 * hr-service restarts, so the label exists in every schema before any new handler can persist it;
 * old code never writes it, and the drift validator compares labels as sets (class F, warn).
 */
export class AddHrValueToDepartmentModuleEnum1802600000000 implements MigrationInterface {
  name = 'AddHrValueToDepartmentModuleEnum1802600000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same transaction; the statement is
  // additive and IF NOT EXISTS guarded, so statement-level autocommit is safe and idempotent on
  // re-run (mirrors AddChemicalTherapeuticTypes1805900000000).
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValueIfTypePresent(queryRunner, 'departments_hr_modulecode_enum', 'hr');
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema — every schema holding
   * a copy gains the label; a schema without one skips, else a bare `ALTER TYPE` throws 42704 and
   * fails the deploy. typeName/value are migration-internal literals, so direct interpolation
   * carries no injection surface.
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
   * Fail-closed: the label exists wherever its enum TYPE is present in the ACTIVE schema. It is
   * counted missing ONLY when the type exists in current_schema but lacks the label, so a schema
   * holding a copy fail-closes on a genuinely missing value while a schema without one passes.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH expected(typ, label) AS (VALUES
        ('departments_hr_modulecode_enum', 'hr'))
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
    // Forward-only: PostgreSQL cannot DROP an enum value without rewriting the type and rebinding
    // every column and row. An additive enum value is non-destructive and intentionally
    // irreversible (matches AddChemicalTherapeuticTypes1805900000000.down).
  }
}
