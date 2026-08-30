import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddRegulatoryAuditEnumValues1804700000000
 *
 * COMPLIANCE-HIGH-001 — the regulatory-reporting module never wrote an
 * actor-attributed audit row for any regulator action, so a filed
 * Mattilsynet/Fiskeridirektoratet submission (or its approval, dismissal,
 * override, or failure) left no immutable trail. Wiring those writes needs
 * the `farm_audit_logs_action_enum` type to carry the new action labels.
 *
 * Adds to `farm_audit_logs_action_enum`:
 *   - REGULATORY_SUBMITTED   (a report crossed the trust boundary)
 *   - REGULATORY_FAILED      (a submission attempt failed)
 *   - REGULATORY_APPROVED    (operator approved a draft for submission)
 *   - REGULATORY_DISMISSED   (operator dismissed a draft)
 *   - REGULATORY_OVERRIDDEN  (operator filled a MANUAL_REQUIRED field)
 *
 * # Tenant fan-out (current_schema-relative — load-bearing)
 *
 * `farm_audit_logs_action_enum` exists ONLY in the `farm` schema (Baseline
 * creates it `farm`-qualified); `farm.farm_audit_logs` is cross-tenant
 * infrastructure with no per-tenant clone. db-migrate fans this migration
 * out with search_path pinned per-schema: the `farm` run adds the values,
 * and every per-tenant run finds no local type and MUST skip — a bare
 * `ALTER TYPE` there throws 42704 and fails the deploy. Each ALTER is
 * type-presence-guarded in current_schema, exactly as
 * AddCullMortalityAuditEnumValues1801300000000 guards its own.
 *
 * # Casing — audit-action labels are UPPERCASE (verified against Baseline).
 *
 * # Blue-green safety — additive enum values need no NOT NULL backfill;
 * MIGRATION FIRST (aqua-db-migrate runs before farm-service restart) so the
 * labels exist before any handler can persist them.
 */
export class AddRegulatoryAuditEnumValues1804700000000 implements MigrationInterface {
  name = 'AddRegulatoryAuditEnumValues1804700000000';

  // ALTER TYPE ... ADD VALUE cannot be consumed later in the same
  // transaction on supported PostgreSQL versions. Each statement is
  // additive and IF NOT EXISTS guarded, so statement-level autocommit is
  // safe and idempotent on re-run / partial failure.
  transaction = false;

  private static readonly ACTION_VALUES = [
    'REGULATORY_SUBMITTED',
    'REGULATORY_FAILED',
    'REGULATORY_APPROVED',
    'REGULATORY_DISMISSED',
    'REGULATORY_OVERRIDDEN',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of AddRegulatoryAuditEnumValues1804700000000.ACTION_VALUES) {
      await this.addEnumValueIfTypePresent(queryRunner, 'farm_audit_logs_action_enum', value);
    }
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema —
   * the `farm` run applies the value to the shared type; per-tenant runs
   * (where the type is absent by design) skip. ADD VALUE IF NOT EXISTS keeps
   * the `farm` run idempotent. typeName/value are migration-internal
   * literals (not caller input), so direct interpolation carries no
   * injection surface.
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
   * Fail-closed: every expected label exists wherever the enum TYPE is
   * present in the ACTIVE schema. A label counts missing ONLY when the type
   * exists in current_schema but lacks it — so the `farm` run fail-closes on
   * a genuinely missing value while per-tenant runs (type absent) pass.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH expected(typ, label) AS (VALUES
        ('farm_audit_logs_action_enum', 'REGULATORY_SUBMITTED'),
        ('farm_audit_logs_action_enum', 'REGULATORY_FAILED'),
        ('farm_audit_logs_action_enum', 'REGULATORY_APPROVED'),
        ('farm_audit_logs_action_enum', 'REGULATORY_DISMISSED'),
        ('farm_audit_logs_action_enum', 'REGULATORY_OVERRIDDEN'))
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
    // Forward-only: PostgreSQL cannot DROP an enum value without rewriting
    // the type and rebinding every column/row. Additive enum values are
    // non-destructive and intentionally irreversible (matches 1801300000000).
  }
}
