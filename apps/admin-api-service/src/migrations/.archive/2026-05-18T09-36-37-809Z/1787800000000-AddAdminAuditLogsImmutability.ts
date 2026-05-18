import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAdminAuditLogsImmutability1787800000000
 * ============================================================================
 *
 * Installs database-level immutability triggers + the `legalHold`
 * boolean column on `admin.audit_logs`. Mirrors the canonical
 * trigger set established for `shared.audit_logs` (admin-api migration
 * 1787400000000) and `auth.audit_logs` (auth-service migration
 * 1787100000000) and `farm.farm_audit_logs` (farm-service migration
 * 1788300000000).
 *
 * # Why this migration exists
 *
 * Pre-fix `admin.audit_logs` was mutable at the DB level. The audit-row
 * stream covers SUPER_ADMIN cross-tenant actions: impersonation start /
 * stop, tenant suspension, plan changes, system setting changes. The
 * cross-tenant nature makes this trail PARTICULARLY sensitive to
 * tampering — every row is written under BypassRlsService.withBypass()
 * which itself is a privileged path.
 *
 * AUDITTRAIL-HIGH-006 captured the gap: the trigger set was rolled out
 * for shared / auth / farm audit tables but the per-service admin audit
 * table was left unprotected.
 *
 * # What this migration does
 *
 *   1. ADD COLUMN `legalHold boolean NOT NULL DEFAULT false` on
 *      `admin.audit_logs` (idempotent).
 *   2. CREATE OR REPLACE the two trigger functions in `admin` schema —
 *      function bodies match the canonical originals.
 *   3. DROP+CREATE the two triggers on `admin.audit_logs` (idempotent
 *      via DROP TRIGGER IF EXISTS guard).
 *
 * # Compliance frameworks served
 *
 *   - SOX § 404 (auditable internal controls)
 *   - PCI-DSS § 10.5 (secure audit trails)
 *   - SOC 2 CC4 (control monitoring + audit-trail tamper-evidence)
 *   - GDPR Art 30 (record-of-processing integrity)
 *
 * # Down-rollback
 *
 * Rollback is REFUSED — same rationale as the sibling migrations.
 * Removing audit-row immutability violates four compliance frameworks
 * simultaneously.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-HIGH-006
 */
export class AddAdminAuditLogsImmutability1787800000000
  implements MigrationInterface
{
  name = 'AddAdminAuditLogsImmutability1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: legalHold column. NOT NULL with same-clause DEFAULT
    // (migration-sql-lint R2 compliant — blue-green safe).
    //
    // WHY: BEFORE DELETE trigger inspects OLD."legalHold" and refuses
    // deletion when the flag is true. Mirrors the canonical pattern.
    await queryRunner.query(`
      ALTER TABLE admin.audit_logs
      ADD COLUMN IF NOT EXISTS "legalHold" boolean NOT NULL DEFAULT false
    `);

    // Step 2a: prevent_update function.
    //
    // WHY: Audit rows are append-only by design. RAISE EXCEPTION on
    // every UPDATE prevents both buggy application code AND attackers
    // with direct DB credentials from rewriting history.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION admin.audit_logs_prevent_update()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'admin.audit_logs rows are immutable - UPDATE is not permitted';
      END;
      $$ LANGUAGE plpgsql
    `);

    // Step 2b: prevent_update trigger.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_update ON admin.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_update
      BEFORE UPDATE ON admin.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION admin.audit_logs_prevent_update()
    `);

    // Step 3a: prevent_legal_hold_delete function.
    //
    // WHY: Litigation hold imposes a legal duty to preserve evidence.
    // Even an authorised operator running a retention sweep must not
    // be able to delete rows flagged for hold. DB-level enforcement
    // means a buggy retention cron, a misconfigured CASCADE, or any
    // other accidental DELETE simply errors out.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION admin.audit_logs_prevent_legal_hold_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD."legalHold" = true THEN
          RAISE EXCEPTION 'Cannot delete admin.audit_logs row with active legal hold (id=%)', OLD.id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Step 3b: prevent_legal_hold_delete trigger.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_legal_hold_delete ON admin.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_legal_hold_delete
      BEFORE DELETE ON admin.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION admin.audit_logs_prevent_legal_hold_delete()
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // WHY: Removing audit-row immutability violates SOX § 404 + PCI-DSS § 10.5
    // + SOC 2 CC4 + GDPR Art 30 simultaneously.
    throw new Error(
      'Refusing to rollback admin.audit_logs immutability. ' +
        'Removing audit immutability or the legalHold column violates ' +
        'SOX § 404, PCI-DSS § 10.5, SOC 2 CC4, and GDPR Art 30 ' +
        'tamper-evidence requirements. See ' +
        'docs/runbooks/audit-immutability-rollback.md for the documented ' +
        'operator procedure (legal-team waiver mandated).',
    );
  }
}
