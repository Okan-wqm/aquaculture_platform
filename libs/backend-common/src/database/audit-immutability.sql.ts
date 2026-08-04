import { validateSqlIdentifier } from './sql-identifier.util';

/**
 * The append-only contract for an audit table, as SQL — one definition for all
 * four of them.
 *
 * # What the contract is
 *
 * An audit row may never be UPDATED, and may be DELETED only when it is not
 * under legal hold. Those are two different rules and they need two different
 * triggers:
 *
 *   - `BEFORE UPDATE` raises unconditionally — there is no lawful update;
 *   - `BEFORE DELETE` raises only when `OLD."legalHold"` is true, and otherwise
 *     returns the row so the delete proceeds.
 *
 * The second half is load-bearing and easy to get wrong in the strict
 * direction. Audit retention EXPIRES rows: the retention module filters on
 * `legalHold = false` in the application layer and relies on this trigger as the
 * database-level backstop, exactly as its docstring says. A trigger that refuses
 * every delete does not harden that path, it breaks it — retention can no longer
 * remove anything, and an audit table that can only grow is its own incident.
 *
 * # Why this lives in a library rather than in each migration
 *
 * Four tables carry this contract — `shared.audit_logs`, `auth.audit_logs`,
 * `admin.audit_logs`, `farm.farm_audit_logs` — across three services, and a
 * migration cannot be shared across services. So the SQL is generated from one
 * place and each service's migration calls it. Before this, each table had its
 * own hand-written copy, and the 2026-05-18 baseline squash hand-authored a
 * FIFTH variant that consolidated both triggers into one unconditional
 * `UPDATE OR DELETE` refusal — dropping the legal-hold distinction on three
 * tables and dropping `shared.audit_logs` protection entirely.
 * ORPHAN-CRITICAL-517.
 *
 * Names are derived from (schema, table), so a new audit table gets the exact
 * naming the invariant expects by calling this rather than by remembering a
 * convention.
 */

export interface AuditTableRef {
  /** Postgres schema, e.g. `shared`. */
  readonly schema: string;
  /** Table name, e.g. `audit_logs`. */
  readonly table: string;
}

/** Canonical object names for a table's append-only contract. */
export interface AuditImmutabilityNames {
  readonly updateFunction: string;
  readonly deleteFunction: string;
  readonly updateTrigger: string;
  readonly deleteTrigger: string;
}

function assertRef(ref: AuditTableRef): void {
  validateSqlIdentifier(ref.schema, 'schema');
  validateSqlIdentifier(ref.table, 'table');
}

/**
 * The four object names, derived rather than remembered.
 *
 * Exported because the invariant that guards this contract must name the same
 * objects the migrations create; deriving both from here is what stops the two
 * from drifting into a gate that checks names nothing produces.
 */
export function auditImmutabilityNames(ref: AuditTableRef): AuditImmutabilityNames {
  assertRef(ref);
  return {
    updateFunction: `${ref.schema}.${ref.table}_prevent_update`,
    deleteFunction: `${ref.schema}.${ref.table}_prevent_legal_hold_delete`,
    updateTrigger: `trg_${ref.table}_prevent_update`,
    deleteTrigger: `trg_${ref.table}_prevent_legal_hold_delete`,
  };
}

/**
 * Statements that establish the append-only contract, in order.
 *
 * Idempotent and safe to run over the consolidated variant the baseline
 * introduced: every trigger is dropped before being created, and the superseded
 * `<schema>.<table>_prevent_update_or_delete` function is dropped after the
 * trigger that depended on it is gone. `CREATE OR REPLACE FUNCTION` handles
 * re-application.
 */
export function auditImmutabilityStatements(ref: AuditTableRef): string[] {
  const names = auditImmutabilityNames(ref);
  const qualified = `"${ref.schema}"."${ref.table}"`;

  return [
    `CREATE OR REPLACE FUNCTION ${names.updateFunction}()
       RETURNS TRIGGER AS $$
       BEGIN
         RAISE EXCEPTION '${ref.schema}.${ref.table} rows are immutable - UPDATE is not permitted';
       END;
       $$ LANGUAGE plpgsql`,

    `CREATE OR REPLACE FUNCTION ${names.deleteFunction}()
       RETURNS TRIGGER AS $$
       BEGIN
         IF OLD."legalHold" = true THEN
           RAISE EXCEPTION 'Cannot delete ${ref.schema}.${ref.table} row with active legal hold (id=%)', OLD.id;
         END IF;
         RETURN OLD;
       END;
       $$ LANGUAGE plpgsql`,

    // The baseline's consolidated trigger carries the SAME name as the update
    // trigger below, so dropping by name replaces it rather than colliding.
    `DROP TRIGGER IF EXISTS ${names.updateTrigger} ON ${qualified}`,
    `DROP TRIGGER IF EXISTS ${names.deleteTrigger} ON ${qualified}`,

    // Dropped only now: while the consolidated trigger existed, the function it
    // executed could not be removed.
    `DROP FUNCTION IF EXISTS "${ref.schema}".${ref.table}_prevent_update_or_delete()`,

    `CREATE TRIGGER ${names.updateTrigger}
       BEFORE UPDATE ON ${qualified}
       FOR EACH ROW
       EXECUTE FUNCTION ${names.updateFunction}()`,

    `CREATE TRIGGER ${names.deleteTrigger}
       BEFORE DELETE ON ${qualified}
       FOR EACH ROW
       EXECUTE FUNCTION ${names.deleteFunction}()`,
  ];
}

/**
 * Why there is no `down()` generator.
 *
 * Removing these triggers weakens audit posture, and the cost of weak audit
 * posture is paid forever. A migration that establishes this contract must
 * refuse rollback rather than offer a one-line operator path back to mutable
 * audit rows; providing a drop generator here would make that refusal an
 * opt-in. `audit-immutability-triggers.spec.ts` asserts no effective migration
 * leaves one of these triggers dropped.
 */
export const AUDIT_IMMUTABILITY_ROLLBACK_REFUSAL =
  'Refusing to rollback audit immutability: dropping these triggers would make ' +
  'audit rows mutable and would remove the database-level legal-hold guard that ' +
  'the retention path relies on. Roll forward with a new migration instead.';
