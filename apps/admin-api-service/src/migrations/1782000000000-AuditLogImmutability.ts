import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AuditLogImmutability1782000000000
 * ============================================================================
 *
 * SECURITY: Enforces database-level immutability on the audit_logs table.
 *
 * 1. Adds `legalHold` boolean column (default false) for litigation preservation.
 * 2. Creates BEFORE UPDATE trigger that prevents ALL updates to audit log rows.
 *    Audit logs are append-only — once written, they must never be modified.
 * 3. Creates BEFORE DELETE trigger that prevents deletion of rows with
 *    legalHold=true. Non-held records can only be deleted through the
 *    application-layer purge service.
 *
 * These triggers provide defense-in-depth: even if application code has a bug
 * or an attacker gains direct DB access, the audit trail remains intact for
 * legally-held records.
 *
 * Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-006
 * Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-007
 */
export class AuditLogImmutability1782000000000 implements MigrationInterface {
  name = 'AuditLogImmutability1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Add legalHold column ──
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
      ADD COLUMN IF NOT EXISTS "legalHold" boolean NOT NULL DEFAULT false
    `);

    // ── Step 2: BEFORE UPDATE trigger — prevent all modifications ──
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_prevent_update()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs rows are immutable — UPDATE is not permitted';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_update ON "audit_logs"
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_update
      BEFORE UPDATE ON "audit_logs"
      FOR EACH ROW
      EXECUTE FUNCTION audit_logs_prevent_update()
    `);

    // ── Step 3: BEFORE DELETE trigger — block deletion of legally-held records ──
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_prevent_legal_hold_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD."legalHold" = true THEN
          RAISE EXCEPTION 'Cannot delete audit_logs row with active legal hold (id=%)', OLD.id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_legal_hold_delete ON "audit_logs"
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_legal_hold_delete
      BEFORE DELETE ON "audit_logs"
      FOR EACH ROW
      EXECUTE FUNCTION audit_logs_prevent_legal_hold_delete()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove triggers
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_legal_hold_delete ON "audit_logs"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS audit_logs_prevent_legal_hold_delete()
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_update ON "audit_logs"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS audit_logs_prevent_update()
    `);

    // Remove legalHold column
    await queryRunner.query(`
      ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "legalHold"
    `);
  }
}
