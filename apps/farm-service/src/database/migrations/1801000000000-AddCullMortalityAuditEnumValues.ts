import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddCullMortalityAuditEnumValues1801000000000
 *
 * Additive enum-value alignment for AquaMobil Phase 4 (mortality/cull domain
 * correctness). Brings three Postgres enum types into line with the TypeScript
 * SSoT (apps/farm-service/src/batch/entities/tank-operation.enums.ts and the
 * AuditAction enum):
 *
 *   - tank_operations_cullreason_enum      += 'quality'        (FARM-HIGH-054)
 *   - tank_operations_mortalityreason_enum += 'predation'      (FARM-MEDIUM-052)
 *   - tank_operations_mortalityreason_enum += 'cannibalism'    (FARM-MEDIUM-052)
 *   - farm_audit_logs_action_enum          += 'MORTALITY_RECORDED' (FARM-MEDIUM-054)
 *   - farm_audit_logs_action_enum          += 'CULL_RECORDED'      (FARM-MEDIUM-054)
 *
 * # Tenant fan-out (current_schema-relative — load-bearing)
 *
 * The enum types are created schema-qualified as `farm`.`...` in the Baseline,
 * but every clone lives in its own `tenant_<uuid>` schema. db-migrate pins
 * search_path to `farm` OR `tenant_<id>` before each run, so the ALTER TYPE
 * statements reference the enum types UNQUALIFIED — exactly as
 * AlignEquipmentTypesRuntimeContract1800300000000 does — so the additive value
 * fans out to EVERY tenant clone, not just `farm`. Qualifying as "farm" would
 * leave tenant clones missing the value, which is the precise drift this guards
 * against (a QUALITY cull would then throw for only some tenants).
 *
 * # Casing (load-bearing — verified against Baseline)
 *
 * tank_operations_* enum labels are LOWERCASE ('small_size'); the audit-action
 * enum labels are UPPERCASE ('CREATE'). A casing slip produces a value the
 * entity enum cannot round-trip, so 'quality'/'predation'/'cannibalism' are
 * lowercase and 'MORTALITY_RECORDED'/'CULL_RECORDED' are uppercase.
 *
 * # Blue-green safety
 *
 * Additive enum values are inherently blue-green safe (no NOT NULL backfill).
 * MIGRATION FIRST, CODE SECOND: aqua-db-migrate is the sole schema writer and
 * runs BEFORE farm-service restart, so the new labels exist in every schema
 * before any new handler can persist them. Old code on the new DB ignores the
 * extra labels; new code on the old DB is blocked by postCondition() below
 * (fail-closed).
 */
export class AddCullMortalityAuditEnumValues1801000000000 implements MigrationInterface {
  name = 'AddCullMortalityAuditEnumValues1801000000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same transaction
  // on supported PostgreSQL versions (the identical constraint
  // AlignEquipmentTypes1800300000000 hit). Each statement is additive and
  // IF NOT EXISTS guarded, so statement-level autocommit is safe and idempotent
  // on re-run / partial failure.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // FARM-HIGH-054: QUALITY is accepted by the command / GraphQL / event layer
    // but was absent from the DB cull enum — a QUALITY cull threw 22P02 on INSERT.
    await queryRunner.query(
      `ALTER TYPE "tank_operations_cullreason_enum" ADD VALUE IF NOT EXISTS 'quality'`,
    );

    // FARM-MEDIUM-052: PREDATION / CANNIBALISM were valid in the command enum but
    // missing from the DB enum, so the handler silently coerced them to 'unknown'.
    await queryRunner.query(
      `ALTER TYPE "tank_operations_mortalityreason_enum" ADD VALUE IF NOT EXISTS 'predation'`,
    );
    await queryRunner.query(
      `ALTER TYPE "tank_operations_mortalityreason_enum" ADD VALUE IF NOT EXISTS 'cannibalism'`,
    );

    // FARM-MEDIUM-054: audit actions for mortality/cull rows written by the handlers.
    await queryRunner.query(
      `ALTER TYPE "farm_audit_logs_action_enum" ADD VALUE IF NOT EXISTS 'MORTALITY_RECORDED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "farm_audit_logs_action_enum" ADD VALUE IF NOT EXISTS 'CULL_RECORDED'`,
    );
  }

  /**
   * Fail-closed assurance: assert all five labels exist in the ACTIVE schema.
   * Returns false → the runner fails the migrate step → the deploy does not
   * restart farm-service against a DB missing a value (new code on old DB).
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH expected(typ, label) AS (VALUES
        ('tank_operations_cullreason_enum', 'quality'),
        ('tank_operations_mortalityreason_enum', 'predation'),
        ('tank_operations_mortalityreason_enum', 'cannibalism'),
        ('farm_audit_logs_action_enum', 'MORTALITY_RECORDED'),
        ('farm_audit_logs_action_enum', 'CULL_RECORDED'))
      SELECT COUNT(*)::text AS missing
        FROM expected x
       WHERE NOT EXISTS (
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
    // Forward-only: PostgreSQL cannot DROP an enum value without rewriting the
    // type and rebinding every column/row. Additive enum values are
    // non-destructive and intentionally irreversible (matches 1800300000000.down).
  }
}
