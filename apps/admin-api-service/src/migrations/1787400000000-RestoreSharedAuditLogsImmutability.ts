import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RestoreSharedAuditLogsImmutability1787400000000
 * ============================================================================
 *
 * Restores BEFORE UPDATE / BEFORE DELETE immutability triggers + the
 * `legalHold` boolean column on `shared.audit_logs` that were silently
 * dropped by `1787200000000-RealignSharedAuditLogsSchema.ts`.
 *
 * # Why this migration exists
 *
 * Migration 1782000000000 originally installed two database-level triggers
 * on the audit table:
 *
 *   1. `trg_audit_logs_prevent_update` — RAISE EXCEPTION on every UPDATE
 *      (audit rows are append-only; once written, immutable).
 *   2. `trg_audit_logs_prevent_legal_hold_delete` — RAISE EXCEPTION on
 *      DELETE when the row is on legal hold (litigation preservation).
 *
 * It also added the `legalHold boolean` column the second trigger reads.
 * Triggers + column were sitting on the historical admin.audit_logs which
 * was later moved to shared schema by 1782200000000.
 *
 * Migration 1787200000000 then ran `DROP TABLE shared.audit_logs CASCADE`
 * to rebuild the table with the canonical backend-common shape (14 cols).
 * The CASCADE silently dropped the triggers AND removed the legalHold
 * column — the recreate did not restore either.
 *
 * Compliance impact of this regression:
 *   - SOX § 404 (auditable internal controls)
 *   - PCI-DSS § 10.5 (secure audit trails)
 *   - SOC 2 CC4 (control monitoring + audit-trail tamper-evidence)
 *   - GDPR Art 30 (record-of-processing integrity)
 *   - litigation hold (legalHold column gone → cannot mark rows for hold)
 *
 * # What this migration does
 *
 * 1. ADD COLUMN `legalHold boolean NOT NULL DEFAULT false` on
 *    `shared.audit_logs` (idempotent).
 * 2. CREATE OR REPLACE the two trigger functions in `shared` schema —
 *    function bodies match the 1782000000000 originals so behaviour is
 *    identical.
 * 3. DROP+CREATE the two triggers on `shared.audit_logs` (idempotent
 *    via DROP TRIGGER IF EXISTS guard).
 *
 * No row data is touched — the table contents (post-realign) are
 * preserved as-is.
 *
 * # Idempotency
 *
 * - ADD COLUMN uses IF NOT EXISTS.
 * - Trigger functions use CREATE OR REPLACE.
 * - Trigger objects use DROP IF EXISTS + CREATE pair.
 * - Re-running the migration is a safe no-op.
 *
 * # Down-rollback policy
 *
 * Rollback is REFUSED. Removing audit-row immutability or the legalHold
 * column violates SOX § 404, PCI-DSS § 10.5, SOC 2 CC4, and GDPR Art 30
 * tamper-evidence requirements simultaneously. Any operator who genuinely
 * needs to remove these protections must follow the documented manual
 * procedure with a written legal-team waiver. Throwing from down() is
 * deliberate — the cost of a quick rollback is paid forever in compliance
 * exposure; the cost of fix-forward is paid once.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-CRITICAL-001
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-CRITICAL-001
 * Closes: docs/reviews/multi-tenant-saas-expert/2026-04-28-core-platform-review.md#MT-CRITICAL-005
 * Closes: docs/reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-CRITICAL-001
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-HIGH-001
 */
export class RestoreSharedAuditLogsImmutability1787400000000
  implements MigrationInterface
{
  name = 'RestoreSharedAuditLogsImmutability1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Restore the legalHold column ──────────────────────────────
    //
    // WHY: 1787200000000-RealignSharedAuditLogsSchema CASCADE-dropped the
    // table and recreated it with a 14-column shape that omits legalHold.
    // The second trigger (prevent_legal_hold_delete) reads OLD."legalHold"
    // and cannot function without this column. Without legalHold, no row
    // can be marked under litigation preservation.
    //
    // WHAT: ADD COLUMN with explicit DEFAULT false. Migration-sql-lint R2
    // requires NOT NULL columns to declare a DEFAULT in the same clause
    // (blue-green safe — existing rows backfill to false synchronously).
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
      ADD COLUMN IF NOT EXISTS "legalHold" boolean NOT NULL DEFAULT false
    `);

    // ── Step 2a: prevent_update function (mirrors 1782000000000) ──────────
    //
    // WHY: Audit rows are append-only by design. RAISE EXCEPTION on every
    // UPDATE prevents both buggy application code AND attackers with
    // direct DB credentials from rewriting history. This is defense-in-
    // depth: even if the application-layer ORM is bypassed, the database
    // refuses. Function lives in `shared` schema so it is invoked even
    // when the calling session has a different search_path.
    //
    // WHAT: CREATE OR REPLACE so re-runs do not error. PL/pgSQL body
    // RAISEs immediately — the trigger never returns NEW; the UPDATE
    // is rejected by Postgres.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION shared.audit_logs_prevent_update()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'shared.audit_logs rows are immutable - UPDATE is not permitted';
      END;
      $$ LANGUAGE plpgsql
    `);

    // ── Step 2b: prevent_update trigger ───────────────────────────────────
    //
    // WHY: A function alone does nothing; the trigger object binds the
    // function to a table+event. BEFORE UPDATE fires before any row
    // modification commits, so the RAISE inside the function aborts the
    // entire statement transactionally.
    //
    // WHAT: DROP IF EXISTS first (idempotency on re-run). Then CREATE
    // BEFORE UPDATE FOR EACH ROW.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_update ON shared.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_update
      BEFORE UPDATE ON shared.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION shared.audit_logs_prevent_update()
    `);

    // ── Step 3a: prevent_legal_hold_delete function ──────────────────────
    //
    // WHY: Litigation hold imposes a legal duty to preserve evidence.
    // Even an authorised operator running a retention sweep must not
    // be able to delete rows flagged for hold. Database-level enforcement
    // means a buggy retention cron, a misconfigured CASCADE, or any other
    // accidental DELETE simply errors out instead of silently destroying
    // evidence.
    //
    // WHAT: PL/pgSQL function checks OLD."legalHold" (the row state
    // before deletion). If true, RAISE EXCEPTION with the row id so
    // the operator can find which row blocked the sweep. If false,
    // RETURN OLD allows the DELETE to proceed.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION shared.audit_logs_prevent_legal_hold_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD."legalHold" = true THEN
          RAISE EXCEPTION 'Cannot delete shared.audit_logs row with active legal hold (id=%)', OLD.id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);

    // ── Step 3b: prevent_legal_hold_delete trigger ────────────────────────
    //
    // WHY: BEFORE DELETE binds the function to the DELETE event. By
    // returning OLD only when legalHold is false, the function lets
    // legitimate retention sweeps run while blocking held rows.
    //
    // WHAT: DROP IF EXISTS + CREATE BEFORE DELETE FOR EACH ROW.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_prevent_legal_hold_delete ON shared.audit_logs
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_prevent_legal_hold_delete
      BEFORE DELETE ON shared.audit_logs
      FOR EACH ROW
      EXECUTE FUNCTION shared.audit_logs_prevent_legal_hold_delete()
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // WHY: Removing audit-row immutability or the legalHold column violates
    // SOX § 404, PCI-DSS § 10.5, SOC 2 CC4, and GDPR Art 30 tamper-evidence
    // requirements simultaneously. A "convenient" rollback is forbidden
    // because the cost of weak audit posture is paid forever — every
    // future regulator examination, breach investigation, and litigation
    // discovery would be undermined.
    //
    // WHAT: Refuse the rollback explicitly. The error message points
    // operators at the documented procedure (which itself requires a
    // legal-team waiver before any destructive action is taken).
    throw new Error(
      'Refusing to rollback shared.audit_logs immutability. ' +
        'Removing audit immutability or the legalHold column violates ' +
        'SOX § 404, PCI-DSS § 10.5, SOC 2 CC4, and GDPR Art 30 tamper-' +
        'evidence requirements. See docs/runbooks/audit-immutability-' +
        'rollback.md for the documented operator procedure (legal-team ' +
        'waiver required).',
    );
  }
}
