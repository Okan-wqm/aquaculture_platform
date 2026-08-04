import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the fail-closed TenantGuard audit action to farm's immutable ledger.
 *
 * The enum exists only in the source `farm` schema. Tenant fan-out executes
 * this migration with a different current_schema for each tenant, so the
 * guarded block intentionally becomes a no-op when the type is absent.
 */
export class AddSuperAdminCrossTenantAuditAction1807900000000 implements MigrationInterface {
  name = 'AddSuperAdminCrossTenantAuditAction1807900000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = current_schema()
             AND t.typname = 'farm_audit_logs_action_enum'
        ) THEN
          ALTER TYPE "farm_audit_logs_action_enum"
            ADD VALUE IF NOT EXISTS 'SUPER_ADMIN_CROSS_TENANT_ACCESS';
        END IF;
      END
      $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = current_schema()
             AND t.typname = 'farm_audit_logs_action_enum'
        ) THEN true
        ELSE EXISTS (
          SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            JOIN pg_enum e ON e.enumtypid = t.oid
           WHERE n.nspname = current_schema()
             AND t.typname = 'farm_audit_logs_action_enum'
             AND e.enumlabel = 'SUPER_ADMIN_CROSS_TENANT_ACCESS'
        )
      END AS valid
    `)) as Array<{ valid: boolean }>;

    return rows[0]?.valid === true;
  }

  public async down(): Promise<void> {
    // Forward-only: PostgreSQL cannot safely remove an enum label in place.
  }
}
