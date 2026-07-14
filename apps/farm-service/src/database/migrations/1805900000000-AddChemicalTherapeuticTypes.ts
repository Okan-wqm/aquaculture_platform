import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddChemicalTherapeuticTypes1805900000000
 *
 * Additive enum-value alignment for FARM-HIGH-003 Phase 4.2 (fish-health setup
 * therapeutic substances read/write through the Chemical master instead of a
 * client-side mock). Brings the Postgres `chemicals_type_enum` into line with
 * the TypeScript SSoT (apps/farm-service/src/chemical/entities/chemical.entity.ts
 * ChemicalType) by adding the therapeutic categories the fish-health tab needs:
 *
 *   - chemicals_type_enum += 'antifungal'
 *   - chemicals_type_enum += 'vaccine'
 *   - chemicals_type_enum += 'wound_care'
 *
 * # Tenant fan-out (current_schema-relative — load-bearing)
 *
 * `chemicals_type_enum` exists ONLY in the `farm` schema — the Baseline creates
 * it farm-qualified (see 1800000000000-Baseline.ts:490), and every tenant_<uuid>
 * clone's `chemicals` references it CROSS-SCHEMA with no per-tenant copy. This
 * migration issues an UNQUALIFIED `ALTER TYPE` guarded by current_schema so it is
 * NOT source-schema-qualified DDL. db-migrate pins search_path
 * to `farm` OR `tenant_<id>` and fans this migration out to both: the `farm` run
 * adds the values to the shared type; every per-tenant run finds NO local type
 * and MUST skip. A bare unqualified `ALTER TYPE` on the tenant fan-out throws
 * 42704 "type does not exist" and fails the whole deploy, so each ALTER is
 * type-presence-guarded in current_schema — the exact shape
 * AddCullMortalityAuditEnumValues1801300000000 uses.
 *
 * # Casing (load-bearing — verified against Baseline)
 *
 * chemicals_type_enum labels are LOWERCASE snake_case ('water_conditioner',
 * 'ph_adjuster'), so the new labels are 'antifungal' / 'vaccine' / 'wound_care'.
 * A casing slip produces a value the entity enum cannot round-trip.
 *
 * # Blue-green safety
 *
 * Additive enum values are inherently blue-green safe (no NOT NULL backfill).
 * MIGRATION FIRST, CODE SECOND: db-migrate is the sole schema writer and runs
 * BEFORE farm-service restart, so the new labels exist in every schema before any
 * new handler can persist them; old code ignores the extra labels.
 */
export class AddChemicalTherapeuticTypes1805900000000 implements MigrationInterface {
  name = 'AddChemicalTherapeuticTypes1805900000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same transaction;
  // each statement is additive and IF NOT EXISTS guarded, so statement-level
  // autocommit is safe and idempotent on re-run (mirrors
  // AddCullMortalityAuditEnumValues1801300000000).
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValueIfTypePresent(queryRunner, 'chemicals_type_enum', 'antifungal');
    await this.addEnumValueIfTypePresent(queryRunner, 'chemicals_type_enum', 'vaccine');
    await this.addEnumValueIfTypePresent(queryRunner, 'chemicals_type_enum', 'wound_care');
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema — the
   * `farm` run applies it to the shared type; per-tenant runs (type absent by
   * design) skip, else a bare `ALTER TYPE` throws 42704 and fails the deploy.
   * typeName/value are migration-internal literals, so direct interpolation
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
   * Fail-closed: every expected label exists wherever its enum TYPE is present in
   * the ACTIVE schema. A label is counted missing ONLY when its type exists in
   * current_schema but lacks the label — so the `farm` run fail-closes on a
   * genuinely missing value while per-tenant runs (type absent by design) pass.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH expected(typ, label) AS (VALUES
        ('chemicals_type_enum', 'antifungal'),
        ('chemicals_type_enum', 'vaccine'),
        ('chemicals_type_enum', 'wound_care'))
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
    // non-destructive and intentionally irreversible (matches 1801300000000.down).
  }
}
