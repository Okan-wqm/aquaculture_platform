import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  AUDIT_IMMUTABILITY_ROLLBACK_REFUSAL,
  auditImmutabilityStatements,
} from '@aquaculture/backend-common/database';

/**
 * RestoreAuditImmutabilityContract1808400000000
 * ============================================================================
 *
 * Restores the two-trigger append-only contract on `auth.audit_logs` that the
 * 2026-05-18 baseline squash replaced with a single unconditional refusal.
 *
 * # What the squash did
 *
 * The pre-squash design was two triggers per audit table:
 *
 *   - `<schema>.<table>_prevent_update` — BEFORE UPDATE, always raises;
 *   - `<schema>.<table>_prevent_legal_hold_delete` — BEFORE DELETE, raises ONLY
 *     when `OLD."legalHold"` is true, otherwise returns the row.
 *
 * The baseline hand-authored one function per table,
 * `<schema>.<table>_prevent_update_or_delete`, that raises on
 * `BEFORE UPDATE OR DELETE` unconditionally. That is not a stricter version of
 * the same rule — it is a different rule. Audit retention EXPIRES rows and
 * relies on the delete trigger as its database-level backstop while filtering
 * `legalHold = false` in the application layer; a blanket refusal means
 * retention can delete nothing at all, and an audit table that can only grow is
 * its own incident.
 *
 * # Why the SQL is generated
 *
 * Four tables across three services carry this contract, and a migration cannot
 * be shared across services. `auditImmutabilityStatements()` in
 * `@aquaculture/backend-common/database` is the one definition; each service's
 * migration calls it. Hand-copying is what produced the fifth variant this
 * migration is undoing.
 *
 * Forward-only and idempotent: every trigger is dropped before creation, and the
 * superseded consolidated function is dropped once the trigger using it is gone.
 *
 * Closes: docs/reviews/2026-07-26-aria-codex-audit-verification.md#ORPHAN-CRITICAL-517
 */
export class RestoreAuditImmutabilityContract1808400000000 implements MigrationInterface {
  name = 'RestoreAuditImmutabilityContract1808400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [{ schema: 'auth', table: 'audit_logs' }]) {
      for (const statement of auditImmutabilityStatements(table)) {
        await queryRunner.query(statement);
      }
    }
  }

  public async down(): Promise<void> {
    // Deliberately refuses. Dropping these triggers makes audit rows mutable and
    // removes the legal-hold guard the retention path depends on; the cost of
    // weak audit posture is paid forever, so there is no one-line way back.
    throw new Error(AUDIT_IMMUTABILITY_ROLLBACK_REFUSAL);
  }
}
