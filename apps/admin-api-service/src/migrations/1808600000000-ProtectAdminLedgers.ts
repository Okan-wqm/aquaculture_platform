import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  AUDIT_IMMUTABILITY_ROLLBACK_REFUSAL,
  auditImmutabilityStatements,
} from '@aquaculture/backend-common/database';

/**
 * ProtectAdminLedgers — admin.activity_logs and admin.tenant_activities become
 * WORM ledgers, and admin.audit_logs gains the mandatory audit shape
 * (ADR-0008, DATA-CRITICAL-012).
 *
 * WHY: the SUPER_ADMIN activity ledger carried no legal-hold column, no
 * trigger, and a 02:00 cron that UPDATEd `isArchived` on rows older than 90
 * days — the platform's own security ledger was mutable by design while a
 * decorative impersonation table carried the WORM trigger. tenant_activities
 * accepted rows with no actor. admin.audit_logs lacked ten of the columns the
 * canonical shared ledger treats as mandatory, so a SUPER_ADMIN cross-tenant
 * write could not record who acted from where, over which channel, with MFA,
 * or with what outcome.
 *
 * ORDER MATTERS inside this migration:
 *   1. backfill tenant_activities.performedBy and make it NOT NULL, and drop
 *      the activity_logs archive flags, BEFORE the UPDATE-refusing triggers
 *      exist — after step 3 no statement may touch an existing row;
 *   2. add legalHold to both ledgers and the ten columns to audit_logs
 *      (ADD COLUMN is DDL; the existing admin.audit_logs triggers refuse row
 *      UPDATE, not table alteration);
 *   3. apply the canonical immutability statements to both ledgers.
 *
 * Blue-green: every ADD COLUMN is nullable or carries a default; the single
 * SET NOT NULL follows its backfill in the same transaction, and every writer
 * of tenant_activities already supplies performedBy.
 */
export class ProtectAdminLedgers1808600000000 implements MigrationInterface {
  name = 'ProtectAdminLedgers1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    // ── 1. Mutable residue leaves before the ledgers become write-once ──
    await queryRunner.query(`
      UPDATE "admin"."tenant_activities"
         SET "performedBy" = 'system:legacy'
       WHERE "performedBy" IS NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'admin'
            AND table_name = 'tenant_activities'
            AND column_name = 'performedBy'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "admin"."tenant_activities" ALTER COLUMN "performedBy" SET NOT NULL;
        END IF;
      END $$;
    `);
    // -- COMPLIANCE-WAIVER: DATA-CRITICAL-012 archive flags are lifecycle state on a WORM ledger (ADR-0008); disposal belongs to the retention kernel (ADR-0012) -- DESTRUCTIVE: lifecycle flag, not evidence; rollback = none needed, no reader remains
    await queryRunner.query(
      `ALTER TABLE "admin"."activity_logs" DROP COLUMN IF EXISTS "isArchived"`,
    );
    // -- COMPLIANCE-WAIVER: DATA-CRITICAL-012 archive flags are lifecycle state on a WORM ledger (ADR-0008); disposal belongs to the retention kernel (ADR-0012) -- DESTRUCTIVE: lifecycle flag, not evidence; rollback = none needed, no reader remains
    await queryRunner.query(
      `ALTER TABLE "admin"."activity_logs" DROP COLUMN IF EXISTS "archivedAt"`,
    );

    // ── 2. Legal hold on both ledgers; the mandatory shape on audit_logs ──
    for (const table of ['activity_logs', 'tenant_activities']) {
      await queryRunner.query(`
        ALTER TABLE "admin"."${table}"
          ADD COLUMN IF NOT EXISTS "legalHold" boolean NOT NULL DEFAULT false
      `);
    }
    await queryRunner.query(`
      ALTER TABLE "admin"."audit_logs"
        ADD COLUMN IF NOT EXISTS "actorHomeTenantId" uuid,
        ADD COLUMN IF NOT EXISTS "actedOnTenantId" uuid,
        ADD COLUMN IF NOT EXISTS "method" character varying(16),
        ADD COLUMN IF NOT EXISTS "mfaVerified" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "result" character varying(16),
        ADD COLUMN IF NOT EXISTS "preStateHash" character varying(64),
        ADD COLUMN IF NOT EXISTS "postStateHash" character varying(64),
        ADD COLUMN IF NOT EXISTS "justification" text,
        ADD COLUMN IF NOT EXISTS "relatedAuditIds" uuid[],
        ADD COLUMN IF NOT EXISTS "correlationId" character varying(255)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_log_actor_home_tenant"
        ON "admin"."audit_logs" ("actorHomeTenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_log_acted_on_tenant"
        ON "admin"."audit_logs" ("actedOnTenantId")
    `);

    // ── 3. The canonical contract: UPDATE refused, DELETE refused under hold ──
    for (const table of [
      { schema: 'admin', table: 'activity_logs' },
      { schema: 'admin', table: 'tenant_activities' },
    ]) {
      for (const statement of auditImmutabilityStatements(table)) {
        await queryRunner.query(statement);
      }
    }
  }

  public async down(): Promise<void> {
    // Deliberately refuses. Dropping these triggers makes the security ledgers
    // mutable again and removes the legal-hold guard the retention path
    // depends on; roll forward with a new migration instead.
    throw new Error(AUDIT_IMMUTABILITY_ROLLBACK_REFUSAL);
  }
}
