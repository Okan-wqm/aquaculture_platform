import { validateSqlIdentifier } from './sql-identifier.util';

/**
 * The append-only contract for an audit table, as SQL — one definition for all
 * four of them.
 *
 * # What the contract is
 *
 * An audit row may never be UPDATED. DELETE has one explicit authority mode,
 * selected by the owning table and enforced by a separate trigger:
 *
 *   - `BEFORE UPDATE` raises unconditionally — there is no lawful update;
 *   - `LEGAL_HOLD_RETENTION` admits the existing table-local retention path for
 *     rows not under legal hold;
 *   - `DEDICATED_RETENTION_CONTROLLER` additionally requires one exact database
 *     role, revokes runtime mutation grants, and still refuses legal-hold rows.
 *
 * The distinction is load-bearing: a normal application role must never gain
 * deletion merely because a row is not held, while an existing owner that has
 * not migrated to a dedicated controller must retain its declared behavior.
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
 * tables and dropping `shared.audit_logs` protection entirely. The option is
 * data, not a second SQL implementation, so both authority modes keep the same
 * name derivation, transition cleanup, legal-hold guard, and invariant surface.
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

export const AUDIT_DELETE_AUTHORITY = Object.freeze({
  LEGAL_HOLD_RETENTION: 'LEGAL_HOLD_RETENTION',
  DEDICATED_RETENTION_CONTROLLER: 'DEDICATED_RETENTION_CONTROLLER',
} as const);

export type AuditDeleteAuthority =
  (typeof AUDIT_DELETE_AUTHORITY)[keyof typeof AUDIT_DELETE_AUTHORITY];

export interface AuditImmutabilityOptions {
  /** Existing tables keep their legal-hold-aware runtime retention contract. */
  readonly deleteAuthority?: AuditDeleteAuthority;
  /** Required when deleteAuthority is DEDICATED_RETENTION_CONTROLLER. */
  readonly retentionControllerRole?: string;
  /** Runtime roles that must not retain direct UPDATE/DELETE grants. */
  readonly revokeMutationFromRoles?: readonly string[];
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
export function auditImmutabilityNames(
  ref: AuditTableRef,
  options: AuditImmutabilityOptions = {},
): AuditImmutabilityNames {
  assertRef(ref);
  const dedicatedController =
    options.deleteAuthority === AUDIT_DELETE_AUTHORITY.DEDICATED_RETENTION_CONTROLLER;
  return {
    updateFunction: `${ref.schema}.${ref.table}_prevent_update`,
    deleteFunction: dedicatedController
      ? `${ref.schema}.${ref.table}_authorize_retention_delete`
      : `${ref.schema}.${ref.table}_prevent_legal_hold_delete`,
    updateTrigger: `trg_${ref.table}_prevent_update`,
    deleteTrigger: dedicatedController
      ? `trg_${ref.table}_authorize_retention_delete`
      : `trg_${ref.table}_prevent_legal_hold_delete`,
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
export function auditImmutabilityStatements(
  ref: AuditTableRef,
  options: AuditImmutabilityOptions = {},
): string[] {
  const deleteAuthority = options.deleteAuthority ?? AUDIT_DELETE_AUTHORITY.LEGAL_HOLD_RETENTION;
  const dedicatedController =
    deleteAuthority === AUDIT_DELETE_AUTHORITY.DEDICATED_RETENTION_CONTROLLER;
  const retentionControllerRole = options.retentionControllerRole;
  if (dedicatedController && retentionControllerRole === undefined) {
    throw new TypeError('retentionControllerRole is required for DEDICATED_RETENTION_CONTROLLER');
  }
  if (retentionControllerRole !== undefined) {
    validateSqlIdentifier(retentionControllerRole, 'role');
  }
  for (const role of options.revokeMutationFromRoles ?? []) {
    validateSqlIdentifier(role, 'role');
  }

  const names = auditImmutabilityNames(ref, options);
  const alternateNames = auditImmutabilityNames(ref, {
    deleteAuthority: dedicatedController
      ? AUDIT_DELETE_AUTHORITY.LEGAL_HOLD_RETENTION
      : AUDIT_DELETE_AUTHORITY.DEDICATED_RETENTION_CONTROLLER,
  });
  const qualified = `"${ref.schema}"."${ref.table}"`;
  const deleteFunctionBody = dedicatedController
    ? `BEGIN
         IF current_user <> '${retentionControllerRole}' THEN
           RAISE EXCEPTION '${ref.schema}.${ref.table} DELETE requires database role ${retentionControllerRole}';
         END IF;
         IF OLD."legalHold" = true THEN
           RAISE EXCEPTION 'Cannot delete ${ref.schema}.${ref.table} row with active legal hold (id=%)', OLD.id;
         END IF;
         RETURN OLD;
       END;`
    : `BEGIN
         IF OLD."legalHold" = true THEN
           RAISE EXCEPTION 'Cannot delete ${ref.schema}.${ref.table} row with active legal hold (id=%)', OLD.id;
         END IF;
         RETURN OLD;
       END;`;

  const privilegeStatements = dedicatedController
    ? [
        `REVOKE UPDATE, DELETE ON ${qualified} FROM PUBLIC`,
        ...(options.revokeMutationFromRoles ?? []).map(
          (role) => `DO $privilege$
             BEGIN
               IF to_regrole('${role}') IS NOT NULL THEN
                 EXECUTE 'REVOKE UPDATE, DELETE ON ${qualified} FROM "${role}"';
               END IF;
             END
             $privilege$`,
        ),
        `DO $privilege$
           BEGIN
             IF to_regrole('${retentionControllerRole}') IS NOT NULL THEN
               EXECUTE 'GRANT SELECT, DELETE ON ${qualified} TO "${retentionControllerRole}"';
             END IF;
           END
           $privilege$`,
      ]
    : [];

  return [
    `CREATE OR REPLACE FUNCTION ${names.updateFunction}()
       RETURNS TRIGGER AS $$
       BEGIN
         RAISE EXCEPTION '${ref.schema}.${ref.table} rows are immutable - UPDATE is not permitted';
       END;
       $$ LANGUAGE plpgsql`,

    `CREATE OR REPLACE FUNCTION ${names.deleteFunction}()
       RETURNS TRIGGER AS $$
       ${deleteFunctionBody}
       $$ LANGUAGE plpgsql`,

    // The baseline's consolidated trigger carries the SAME name as the update
    // trigger below, so dropping by name replaces it rather than colliding.
    `DROP TRIGGER IF EXISTS ${names.updateTrigger} ON ${qualified}`,
    `DROP TRIGGER IF EXISTS ${names.deleteTrigger} ON ${qualified}`,
    `DROP TRIGGER IF EXISTS ${alternateNames.deleteTrigger} ON ${qualified}`,

    // Dropped only now: while the consolidated trigger existed, the function it
    // executed could not be removed.
    `DROP FUNCTION IF EXISTS "${ref.schema}".${ref.table}_prevent_update_or_delete()`,
    `DROP FUNCTION IF EXISTS ${alternateNames.deleteFunction}()`,

    `CREATE TRIGGER ${names.updateTrigger}
       BEFORE UPDATE ON ${qualified}
       FOR EACH ROW
       EXECUTE FUNCTION ${names.updateFunction}()`,

    `CREATE TRIGGER ${names.deleteTrigger}
       BEFORE DELETE ON ${qualified}
       FOR EACH ROW
       EXECUTE FUNCTION ${names.deleteFunction}()`,

    ...privilegeStatements,
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
