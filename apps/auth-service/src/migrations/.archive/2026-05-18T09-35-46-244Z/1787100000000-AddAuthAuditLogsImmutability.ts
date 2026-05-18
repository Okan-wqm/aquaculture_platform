import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAuthAuditLogsImmutability1787100000000
 * ============================================================================
 *
 * Installs database-level immutability triggers + the `legalHold`
 * boolean column on `auth.audit_logs`. Mirrors the protection set
 * `1787400000000-RestoreSharedAuditLogsImmutability.ts` (admin-api)
 * established for `shared.audit_logs` — extends the same Tier-1
 * make-impossible discipline to the auth-service local audit table.
 *
 * # Why this migration exists
 *
 * Pre-fix `auth.audit_logs` was mutable at the DB level. The audit-row
 * stream covers login attempts, MFA verification, token revoke /
 * blacklist, password resets, and SUPER_ADMIN cross-tenant access —
 * every regulated identity-side action. AUDITTRAIL-HIGH-005 captured
 * the gap: the W0.D fix restored protections for `shared.audit_logs`
 * but the per-service auth audit table was left unprotected, leaving
 * the auth-side trail freely UPDATE-able and DELETE-able by any
 * application role with table privileges.
 *
 * # What this migration does
 *
 *   1. ADD COLUMN `legalHold boolean NOT NULL DEFAULT false` on
 *      `auth.audit_logs` (idempotent).
 *   2. CREATE OR REPLACE the two trigger functions in `auth` schema —
 *      function bodies match the canonical shared-schema originals so
 *      behaviour is identical across audit tables.
 *   3. DROP+CREATE the two triggers on `auth.audit_logs` (idempotent
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
 * Rollback is REFUSED — same rationale as the shared-schema migration.
 * Removing audit-row immutability violates four compliance frameworks
 * simultaneously; operators with a genuine need follow
 * `docs/runbooks/audit-immutability-rollback.md` (legal-team waiver
 * mandated).
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-HIGH-005
 */
export class AddAuthAuditLogsImmutability1787100000000
  implements MigrationInterface
{
  name = 'AddAuthAuditLogsImmutability1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: Add the legalHold column. NOT NULL with same-clause DEFAULT
    // (migration-sql-lint R2 compliant — blue-green safe).
    //
    // WHY: The BEFORE DELETE trigger inspects `OLD."legalHold"` and
    // refuses deletion when the flag is true. The flag is set INSERT-
    // side only; once written the BEFORE UPDATE trigger blocks any
    // mutation through it.
    await queryRunner.query(`
      ALTER TABLE auth.audit_logs
      ADD COLUMN IF NOT EXISTS "legalHold" boolean NOT NULL DEFAULT false
    `);

    // Step 2a: prevent_update function (mirrors shared.audit_logs canonical).
    //
    // WHY: Audit rows are append-only by design. RAISE EXCEPTION on every
    // UPDATE prevents both buggy application code AND attackers with
    // direct DB credentials from rewriting history. Function lives in
    // `auth` schema so it is invoked even when the calling session has
    // a different search_path.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION auth.audit_logs_prevent_update()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'auth.audit_logs rows are immutable - UPDATE is not permitted';
      END;
      $$ LANGUAGE plpgsql
    `);

    // Step 2b: prevent_update trigger.
    //
    // WHY: A function alone does nothing; the trigger object binds the
    // function to a table+event. BEFORE UPDATE fires before any row
    // modification commits, so the RAISE inside the function aborts the
    // entire statement transactionally.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_update ON auth.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_update
      BEFORE UPDATE ON auth.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION auth.audit_logs_prevent_update()
    `);

    // Step 3a: prevent_legal_hold_delete function.
    //
    // WHY: Litigation hold imposes a legal duty to preserve evidence.
    // Even an authorised operator running a retention sweep must not
    // be able to delete rows flagged for hold. Database-level
    // enforcement means a buggy retention cron, a misconfigured
    // CASCADE, or any other accidental DELETE simply errors out instead
    // of silently destroying evidence.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION auth.audit_logs_prevent_legal_hold_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD."legalHold" = true THEN
          RAISE EXCEPTION 'Cannot delete auth.audit_logs row with active legal hold (id=%)', OLD.id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Step 3b: prevent_legal_hold_delete trigger.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_legal_hold_delete ON auth.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_legal_hold_delete
      BEFORE DELETE ON auth.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION auth.audit_logs_prevent_legal_hold_delete()
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // WHY: Removing audit-row immutability violates SOX § 404 + PCI-DSS § 10.5
    // + SOC 2 CC4 + GDPR Art 30 simultaneously. A "convenient" rollback
    // is forbidden — the cost of weak audit posture is paid forever.
    throw new Error(
      'Refusing to rollback auth.audit_logs immutability. ' +
        'Removing audit immutability or the legalHold column violates ' +
        'SOX § 404, PCI-DSS § 10.5, SOC 2 CC4, and GDPR Art 30 ' +
        'tamper-evidence requirements. See ' +
        'docs/runbooks/audit-immutability-rollback.md for the documented ' +
        'operator procedure (legal-team waiver mandated).',
    );
  }
}
