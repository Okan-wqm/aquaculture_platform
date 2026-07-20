import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropImpersonationSessionsWriteGuard — reclassify admin.impersonation_sessions
 * from an append-only audit ledger to an OPERATIONAL, retention-guarded table.
 *
 * ADMIN-CRITICAL-013 / APA-288.
 *
 * # WHAT WAS BROKEN
 *
 * The day-one Baseline (1800000000000-Baseline.ts:265-280) installed
 * `trg_impersonation_sessions_prevent_update`, a BEFORE UPDATE OR DELETE trigger
 * that unconditionally RAISEs ("append-only ... UPDATE/DELETE refused"). But
 * admin.impersonation_sessions is NOT an audit ledger — it is the operational
 * session state machine. ImpersonationService issues an UPDATE (repo.save on an
 * existing row) on EVERY lifecycle transition:
 *   - endImpersonation  (status -> ENDED, endedAt, endReason)
 *   - terminateSession  (status -> TERMINATED)
 *   - extendSession     (expiresAt, actionsPerformed, actionCount)
 *   - expireSession     (status -> EXPIRED; driven by the EVERY_MINUTE cron and
 *                        lazily by validateSession)
 *   - logAction / logResourceAccess (append to the in-row jsonb arrays)
 * A BEFORE trigger fires for every role INCLUDING the table owner, so each of
 * these UPDATEs hit RAISE -> 500. A session could be INSERTed (start) but never
 * ended, terminated, extended, expired, or action-logged: the kill-switch for a
 * live SUPER_ADMIN impersonation credential was dead, the expiry cron threw
 * every minute forever, and after `maxConcurrentSessions` (default 3) starts an
 * admin was permanently locked out. (The Baseline `REVOKE UPDATE, DELETE ...
 * FROM PUBLIC` alongside the trigger was a no-op — a freshly created table
 * grants PUBLIC no DML, and the app connects as owner; the TRIGGER was the sole
 * blocker.)
 *
 * The regulatory append-only trail is NOT lost: every transition already writes
 * an IMPERSONATION_STARTED/ENDED/TERMINATED/EXPIRED/EXTENDED row to
 * admin.audit_logs (a true append-only ledger that keeps its own immutability
 * trigger — Baseline:249-264, required by audit-immutability-triggers.spec.ts).
 *
 * # THE FIX (root cause, not a patch)
 *
 * The misclassification lived in THREE hardcoded copies — the compliance SSoT
 * plus two generator scripts — so simply dropping the trigger would be
 * reinstated at the next baseline regeneration. This migration lands the DB
 * half; the classification half is fixed at the SSoT in the same change:
 *   - libs/backend-common/src/constants/protected-tables.ts now separates
 *     APPEND_ONLY_TABLES (true WORM ledgers) from LIFECYCLE_GUARDED_TABLES
 *     (operational, destructive-DDL-protected). impersonation_sessions moves to
 *     the latter and STAYS in PROTECTED_TABLES (no DROP without a waiver).
 *   - scripts/migration/baseline-generator.ts + apply-audit-immutability.mjs
 *     now derive from that SSoT, so neither re-injects the trigger.
 *   - tests/invariants/impersonation-sessions-operational.spec.ts pins all of
 *     the above (fails red on a re-introduced prevent_update trigger).
 *
 * up() does two things:
 *   1. DROP the prevent_update trigger + its function — unblocks the lifecycle.
 *      The trigger was BEFORE UPDATE *OR DELETE*, so dropping it also removes
 *      the row-DELETE guard; step 2 restores that narrowly.
 *   2. INSTALL a BEFORE DELETE-only guard (`trg_impersonation_sessions_prevent_delete`)
 *      so rows can transition (UPDATE) but can never be hard-deleted — the
 *      SOC 2 access-reconstruction / retention posture the table needs as a
 *      security record. This trigger is unconditional (trivially correct, same
 *      shape as the audit_logs guard); it is NOT a `*_prevent_update` trigger,
 *      so it does not reclassify the table as append-only.
 *
 * A future tier-1 hardening (a DB state-machine guard that also freezes identity
 * columns and rejects illegal status transitions while allowing legal lifecycle
 * UPDATEs) is tracked in docs/adr/046 — it needs a PR-gated real-Postgres
 * integration test that the sandbox/PR lane does not currently run, so it is not
 * shipped blind here.
 *
 * Closes: docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/impersonation-debug.md#APA-288
 */
export class DropImpersonationSessionsWriteGuard1801600000000 implements MigrationInterface {
  name = 'DropImpersonationSessionsWriteGuard1801600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Remove the misapplied append-only write-guard (blocked ALL lifecycle
    //    UPDATEs). DROP FUNCTION after DROP TRIGGER — the function is a
    //    dependency of the trigger. IF EXISTS keeps it idempotent on fresh DBs
    //    (Baseline creates it, this drops it — net absent) and already-migrated
    //    production DBs (trigger present today — removed cleanly).
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update ON "admin"."impersonation_sessions";`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "admin".impersonation_sessions_prevent_update_or_delete();`,
    );

    // 2. Restore the no-hard-delete guarantee narrowly (BEFORE DELETE only), so
    //    lifecycle UPDATEs succeed while row deletion stays refused for
    //    retention. Unconditional RAISE — a session row is never physically
    //    removed; it transitions to ENDED/EXPIRED/TERMINATED.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_sessions_prevent_delete()
      RETURNS trigger AS $lifecycleguard$
      BEGIN
        RAISE EXCEPTION 'admin.impersonation_sessions is an operational, retention-guarded table; row DELETE is refused. Sessions transition via UPDATE (active -> ended/expired/terminated).';
      END;
      $lifecycleguard$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_impersonation_sessions_prevent_delete
      BEFORE DELETE ON "admin"."impersonation_sessions"
      FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_sessions_prevent_delete();
    `);
  }

  public async down(): Promise<void> {
    // Forward-only corrective migration (same contract as
    // 1787400000000-RestoreSharedAuditLogsImmutability, pinned by the audit
    // immutability invariant's "refuses down() rollback" test). Re-installing
    // the BEFORE UPDATE write-guard would re-break the entire session lifecycle
    // after startImpersonation (the exact APA-288 defect this migration cures),
    // so re-creating it is not a legitimate rollback target. Production runs
    // DATABASE_MIGRATIONS_RUN=false with a forward-only runner regardless.
    throw new Error(
      'Refusing to rollback 1801600000000-DropImpersonationSessionsWriteGuard: ' +
        're-installing the impersonation_sessions BEFORE UPDATE write-guard would ' +
        're-break every session-lifecycle mutation (APA-288). This migration ' +
        'corrects a defect and is forward-only.',
    );
  }
}
