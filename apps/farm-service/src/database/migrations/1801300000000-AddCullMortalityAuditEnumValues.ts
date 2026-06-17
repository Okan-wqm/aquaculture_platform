import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddCullMortalityAuditEnumValues1801300000000
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
 * The three enum types exist ONLY in the `farm` schema — the Baseline creates
 * them `farm`-qualified, and every tenant_<uuid> clone's `tank_operations`
 * references them CROSS-SCHEMA (the column type is `farm.<enum>`), with no
 * per-tenant copy. db-migrate pins search_path to `farm` OR `tenant_<id>` and
 * fans this migration out to both: the `farm` run adds the values to the shared
 * types; every per-tenant run finds NO local type and MUST skip. The original
 * code issued bare unqualified `ALTER TYPE`, which on the tenant fan-out threw
 * 42704 "type does not exist" and failed the whole deploy (prod outage,
 * 2026-06-17). Each ALTER is now type-presence-guarded in current_schema — the
 * exact shape AlignEquipmentTypesRuntimeContract1800300000000 uses — so the
 * shared-`farm` value applies once and the tenant runs are guarded no-ops.
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
export class AddCullMortalityAuditEnumValues1801300000000 implements MigrationInterface {
  name = 'AddCullMortalityAuditEnumValues1801300000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same transaction
  // on supported PostgreSQL versions (the identical constraint
  // AlignEquipmentTypes1800300000000 hit). Each statement is additive and
  // IF NOT EXISTS guarded, so statement-level autocommit is safe and idempotent
  // on re-run / partial failure.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The three enum types live ONLY in the `farm` schema (Baseline creates them
    // `farm`-qualified); tenant_<uuid> tables reference them cross-schema and hold
    // no local copy. db-migrate fans this migration out with search_path pinned
    // per-schema: the `farm` run adds the values to the shared types, and every
    // per-tenant run MUST skip — the unqualified type is absent there, and a bare
    // `ALTER TYPE` throws 42704 "type does not exist", failing the whole deploy
    // (the production outage this guards). Each ALTER is type-presence-guarded in
    // current_schema, exactly as AlignEquipmentTypesRuntimeContract1800300000000
    // guards its own ALTERs.

    // FARM-HIGH-054: QUALITY threw 22P02 on INSERT while absent from the cull enum.
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'tank_operations_cullreason_enum',
      'quality',
    );
    // FARM-MEDIUM-052: PREDATION / CANNIBALISM were coerced to 'unknown' while absent.
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'tank_operations_mortalityreason_enum',
      'predation',
    );
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'tank_operations_mortalityreason_enum',
      'cannibalism',
    );
    // FARM-MEDIUM-054: audit actions for mortality/cull rows written by the handlers.
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'farm_audit_logs_action_enum',
      'MORTALITY_RECORDED',
    );
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'farm_audit_logs_action_enum',
      'CULL_RECORDED',
    );
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema.
   *
   * WHY: the enum types are `farm`-schema-qualified (Baseline); tenant_<uuid>
   * clones reference them cross-schema with no local copy, so on the per-tenant
   * fan-out current_schema() is the tenant and the unqualified type is absent —
   * a bare `ALTER TYPE` throws 42704 and fails the deploy. WHAT: the guard skips
   * the tenant runs (the `farm` run already added the value to the shared type);
   * ADD VALUE IF NOT EXISTS keeps the `farm` run idempotent on re-run.
   *
   * typeName/value are migration-internal literals (not caller input), so direct
   * interpolation carries no injection surface.
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
   * Fail-closed assurance: every expected label exists wherever its enum TYPE is
   * present in the ACTIVE schema. A label is counted missing ONLY when its type
   * exists in current_schema but lacks the label — so the `farm` run still
   * fail-closes on a genuinely missing value, while per-tenant runs (where the
   * type is absent by design) pass instead of blocking the deploy.
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
    // Forward-only: PostgreSQL cannot DROP an enum value without rewriting the
    // type and rebinding every column/row. Additive enum values are
    // non-destructive and intentionally irreversible (matches 1800300000000.down).
  }
}
