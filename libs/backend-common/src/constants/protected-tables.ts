/**
 * Protected Tables — Single Source of Truth
 * ============================================================================
 *
 * # WHY
 *
 * Some tables carry **compliance-critical invariants** that cannot survive a
 * `DROP TABLE`, `DROP SCHEMA … CASCADE`, or column drop. Destructive-DDL
 * protection and row-mutation policy are deliberately modelled as separate
 * dimensions below: a table can require retention protection while still
 * having a legitimate mutable lifecycle.
 *
 *   - **Audit trails** — `shared.audit_logs`, `event_store.events`,
 *     `farm.farm_audit_logs`, `hr.payroll_audit`, `ai.tool_execution_audit`,
 *     `alert.alert_audit_log`. SOC 2 CC4 + SOX § 404 record-integrity require
 *     append-only invariants; trigger-based immutability ENFORCES this.
 *   - **Compliance state** — `shared.gdpr_data_requests`, `shared.user_consents`,
 *     `shared.access_logs`. Legal-hold precedence
 *     (FRCP Rule 37(e) / TR CMK delil karartma) forbids destructive ops on
 *     held records.
 *
 *     **Legal-hold tables** live OUTSIDE the `shared` schema: per-tenant
 *     legal holds are stored in `messaging.legal_holds` (per-tenant fan-out),
 *     and the cross-tenant legal-hold registry is the future
 *     `compliance.legal_holds` (entity at
 *     `libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts`).
 *     No `shared.legal_holds` table exists or is planned — the prior
 *     entry was a phantom (ORPHAN-CRITICAL-075-related cleanup).
 *   - **Append-only ledgers** — `hr.leave_ledger_entries` (accrual invariant).
 *   - **Outbox tables** (pattern) — every `*_outbox` table. Destruction =
 *     event loss = downstream projection corruption.
 *
 * # HISTORICAL INCIDENT (2026-04)
 *
 * `apps/admin-api-service/src/migrations/1782200000000-MoveSharedTablesFromAdminToShared.ts`
 * ran `DROP TABLE shared.audit_logs CASCADE` to rebuild the table. The
 * CASCADE silently dropped:
 *   - the immutability trigger (UPDATE/DELETE reject)
 *   - the `legalHold` column
 *
 * The deploy window between `1782200` and `1787400-RestoreSharedAuditLogsImmutability`
 * left `shared.audit_logs` MUTABLE in any environment that deployed both
 * migrations. The recovery migration's docblock literally states:
 *
 *   > "The CASCADE silently dropped the triggers AND removed the legalHold
 *    column. This impacted SOX/PCI-DSS/SOC2 compliance"
 *
 * # ENFORCEMENT
 *
 * This module is imported by:
 *
 *   1. `tools/gates/migration-sql-lint.ts` rule R13 — pre-merge AST check.
 *      Destructive op on a protected table requires `-- COMPLIANCE-WAIVER:`
 *      marker + CODEOWNERS approval, NOT the regular `-- DESTRUCTIVE:` marker.
 *
 *   2. `tests/invariants/protected-tables-guard.spec.ts` — CI invariant test.
 *      Grep-asserts no production migration has bare DROP/TRUNCATE on a
 *      protected table.
 *
 *   3. `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 *      runtime guard (planned Faz 1) — runner refuses to execute a migration
 *      whose body matches a protected-table destructive pattern without the
 *      waiver marker.
 *
 * # ADR
 *
 * See `docs/adr/018-protected-tables-ssot.md` (Faz 7 of the day-one reset).
 *
 * # ADDING A NEW PROTECTED TABLE
 *
 * 1. Add one policy to `PROTECTED_TABLE_POLICIES`.
 * 2. Write an ADR explaining the compliance invariant being protected.
 * 3. Add an immutability trigger (or equivalent guard) to the next migration.
 * 4. CODEOWNERS gate review by `compliance-expert` + `security-reviewer`.
 *
 * # REMOVING A PROTECTED TABLE
 *
 * Requires `architectural-arbiter` approval + an explicit ADR supersede.
 * Never remove without an audit-trail of why the compliance invariant no
 * longer applies (e.g. table physically deleted in a controlled migration
 * with explicit `-- COMPLIANCE-WAIVER:` marker).
 */

/**
 * Row-write classifications are orthogonal to destructive-DDL protection.
 *
 * - `append-only`: UPDATE is never legal. DELETE policy is stated separately
 *   because audit retention may delete an unheld row while WORM ledgers may
 *   never delete a row.
 * - `lifecycle-mutated`: the owning state machine legitimately UPDATEs rows.
 * - `mutable`: this SSoT makes no row-write restriction; only destructive DDL
 *   protection applies.
 */
export const ROW_MUTATION_POLICY = {
  APPEND_ONLY: 'append-only',
  LIFECYCLE_MUTATED: 'lifecycle-mutated',
  MUTABLE: 'mutable',
} as const;

export const ROW_DELETE_POLICY = {
  DENY: 'deny',
  LEGAL_HOLD_RETENTION: 'legal-hold-retention',
  ALLOW: 'allow',
} as const;

export type RowMutationPolicy = (typeof ROW_MUTATION_POLICY)[keyof typeof ROW_MUTATION_POLICY];
export type RowDeletePolicy = (typeof ROW_DELETE_POLICY)[keyof typeof ROW_DELETE_POLICY];

interface ProtectedTablePolicyDefinition {
  readonly qualifiedName: `${string}.${string}`;
  readonly rowMutation: RowMutationPolicy;
  readonly rowDelete: RowDeletePolicy;
}

/**
 * Canonical policy record for every explicitly protected table.
 *
 * `PROTECTED_TABLES`, `APPEND_ONLY_TABLES`, lifecycle classifications, and the
 * migration-generator row-guard inputs are projections of this one list. A
 * table is never re-enumerated in a second policy constant.
 */
export const PROTECTED_TABLE_POLICIES = [
  // ── Shared schema — cross-tenant compliance state (ADR-011 canonical 4-table set) ──
  // Aligned with SHARED_SCHEMA_TABLES in scripts/schema-registry/generate-init-schemas.ts
  // and with the CREATE TABLE statements in
  // apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql.
  // tests/invariants/shared-schema-canonical.spec.ts enforces parity between
  // these three sources on every PR.
  // shared.user_permissions was retired 2026-07-12 (ADR-042, ORPHAN-HIGH-378):
  // it was a dead parallel permission catalog superseded by the auth-service
  // tenant RBAC (auth.tenant_role_permissions.panel_permissions). Archived into
  // admin.retired_config_backups + dropped by admin-api migration 1801500000000.
  {
    qualifiedName: 'shared.audit_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.LEGAL_HOLD_RETENTION,
  },
  {
    qualifiedName: 'shared.gdpr_data_requests',
    rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
    rowDelete: ROW_DELETE_POLICY.ALLOW,
  },
  {
    qualifiedName: 'shared.user_consents',
    rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
    rowDelete: ROW_DELETE_POLICY.ALLOW,
  },
  {
    qualifiedName: 'shared.access_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },

  // ── Event sourcing — append-only stream of truth ──
  {
    qualifiedName: 'event_store.events',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'event_store.stored_events',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'event_store.snapshots',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },

  // ── Per-service protected tables (source templates and tenant fan-out) ──
  {
    qualifiedName: 'ai.tool_execution_audit',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'alert.alert_audit_log',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'farm.farm_audit_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.LEGAL_HOLD_RETENTION,
  },
  {
    qualifiedName: 'farm.tenant_erasure_audit',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'hr.payroll_audit',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'hr.leave_ledger_entries',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'messaging.compliance_audit_log',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'messaging.legal_holds',
    rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  {
    qualifiedName: 'messaging.legal_hold_release_operations',
    rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  // ORPHAN-MEDIUM-324: sensor.sensor_audit_logs ships an append-only
  // immutability trigger + REVOKE UPDATE,DELETE (sensor Baseline) that names
  // "protected-tables-guard" in its exception, but the table was never added
  // to this SSoT — the gap the infrastructure-ledger-ssot invariant surfaced.
  {
    qualifiedName: 'sensor.sensor_audit_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },
  // DB-SENSOR-HIGH-003: immutable VFD runtime control-command audit ledger
  // (append-only trigger + REVOKE UPDATE,DELETE in 1807000000000).
  {
    qualifiedName: 'sensor.vfd_command_audit_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },

  // ── Auth audit (SOC 2 CC7.2 detective control) ──
  {
    qualifiedName: 'auth.audit_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.LEGAL_HOLD_RETENTION,
  },
  {
    qualifiedName: 'admin.audit_logs',
    rowMutation: ROW_MUTATION_POLICY.APPEND_ONLY,
    rowDelete: ROW_DELETE_POLICY.LEGAL_HOLD_RETENTION,
  },
  {
    qualifiedName: 'admin.impersonation_sessions',
    rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
    rowDelete: ROW_DELETE_POLICY.DENY,
  },

  // ── Findings registry (review trail) ──
  {
    qualifiedName: 'event_store.findings',
    rowMutation: ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
    rowDelete: ROW_DELETE_POLICY.ALLOW,
  },
] as const satisfies readonly ProtectedTablePolicyDefinition[];

export type ProtectedTablePolicy = (typeof PROTECTED_TABLE_POLICIES)[number];
export type ProtectedTable = ProtectedTablePolicy['qualifiedName'];
export type AppendOnlyTable = Extract<
  ProtectedTablePolicy,
  { readonly rowMutation: 'append-only' }
>['qualifiedName'];
export type LifecycleMutatedTable = Extract<
  ProtectedTablePolicy,
  { readonly rowMutation: 'lifecycle-mutated' }
>['qualifiedName'];

/** Destructive-DDL protected names; derived from the policy SSoT. */
export const PROTECTED_TABLES: readonly ProtectedTable[] = Object.freeze(
  PROTECTED_TABLE_POLICIES.map((policy) => policy.qualifiedName),
);

/** Tables whose rows reject UPDATE; delete behavior remains policy-specific. */
export const APPEND_ONLY_TABLES: readonly AppendOnlyTable[] = Object.freeze(
  PROTECTED_TABLE_POLICIES.filter(
    (policy): policy is Extract<ProtectedTablePolicy, { readonly rowMutation: 'append-only' }> =>
      policy.rowMutation === ROW_MUTATION_POLICY.APPEND_ONLY,
  ).map((policy) => policy.qualifiedName),
);

/** Tables with legitimate state-machine UPDATEs; derived, never re-listed. */
export const LIFECYCLE_MUTATED_TABLES: readonly LifecycleMutatedTable[] = Object.freeze(
  PROTECTED_TABLE_POLICIES.filter(
    (
      policy,
    ): policy is Extract<ProtectedTablePolicy, { readonly rowMutation: 'lifecycle-mutated' }> =>
      policy.rowMutation === ROW_MUTATION_POLICY.LIFECYCLE_MUTATED,
  ).map((policy) => policy.qualifiedName),
);

/**
 * Row-guard policies relevant to a service baseline for `schema`.
 *
 * Mutable rows with allowed deletion need no database row guard. Every other
 * combination is materialized by the baseline tooling from this projection:
 * strict append-only, legal-hold-aware retention, or lifecycle UPDATE with
 * hard DELETE denied.
 */
export function rowGuardTablePoliciesForSchema(schema: string): readonly ProtectedTablePolicy[] {
  const prefix = `${schema.toLowerCase()}.`;
  return PROTECTED_TABLE_POLICIES.filter(
    (policy) =>
      policy.qualifiedName.startsWith(prefix) &&
      (policy.rowMutation === ROW_MUTATION_POLICY.APPEND_ONLY ||
        policy.rowDelete !== ROW_DELETE_POLICY.ALLOW),
  );
}

/** Bare table name from a canonical policy record. */
export function protectedTableName(policy: ProtectedTablePolicy): string {
  return policy.qualifiedName.slice(policy.qualifiedName.indexOf('.') + 1);
}

/** Unique bare names, retained for callers that audit one schema at a time. */
export function appendOnlyTableBaseNames(): string[] {
  return [...new Set(APPEND_ONLY_TABLES.map((table) => table.slice(table.indexOf('.') + 1)))];
}

/**
 * Pattern-based protected tables. Any table matching one of these patterns
 * is treated as protected regardless of explicit listing.
 *
 * The outbox pattern (`*_outbox` and `*.outbox`) catches `farm.farm_outbox`,
 * `sensor.sensor_outbox`, `hr.hr_outbox`, `messaging.messaging_outbox`,
 * `billing.billing_outbox` etc. Outbox destruction = event loss =
 * projection corruption downstream.
 */
export const PROTECTED_TABLE_PATTERNS: readonly RegExp[] = [
  /^[a-z_][a-z0-9_]*\.[a-z_]+_outbox$/i,
  /^[a-z_][a-z0-9_]*\.outbox$/i,
];

/**
 * Compliance waiver comment marker.
 *
 * A migration may perform destructive DDL on a protected table ONLY when:
 *
 *   1. The migration body contains a comment of the form
 *      `-- COMPLIANCE-WAIVER: <finding-id> <human reason>`
 *
 *   2. The PR carries CODEOWNERS approval from BOTH
 *      `compliance-expert` AND `security-reviewer`.
 *
 *   3. An ADR has been merged documenting the invariant relaxation.
 *
 * The regular `-- DESTRUCTIVE:` marker (R1) is INSUFFICIENT for protected
 * tables — protected destruction needs the higher-bar waiver.
 */
export const COMPLIANCE_WAIVER_MARKER_RE = /--\s*COMPLIANCE-WAIVER:\s*\S+/i;

/**
 * Type-narrow a string against the protected list.
 */
export function isExplicitlyProtectedTable(qualifiedName: string): qualifiedName is ProtectedTable {
  const lowered = qualifiedName.toLowerCase();
  return PROTECTED_TABLES.some((table) => table === lowered);
}

/**
 * Match a fully-qualified table name against pattern-based rules.
 */
export function matchesProtectedTablePattern(qualifiedName: string): boolean {
  const lowered = qualifiedName.toLowerCase();
  return PROTECTED_TABLE_PATTERNS.some((p) => p.test(lowered));
}

/**
 * Canonical check: is this table protected (explicit OR pattern)?
 *
 * Callers MUST pass a fully-qualified `schema.table` name. Bare table
 * names (no schema prefix) return `false` because protection is
 * schema-scoped — a `audit_logs` table in some random schema is not the
 * same as `shared.audit_logs`.
 */
export function isProtectedTable(qualifiedName: string): boolean {
  if (!qualifiedName.includes('.')) {
    return false;
  }
  return isExplicitlyProtectedTable(qualifiedName) || matchesProtectedTablePattern(qualifiedName);
}

/**
 * Protected schemas — DROP SCHEMA CASCADE on these is **always** flagged,
 * regardless of contained tables. The blast radius makes per-table
 * enumeration moot; you cannot drop `shared` without losing audit logs,
 * legal holds, consent records, and access logs in a single statement.
 *
 * `tenant_<uuid>` is intentionally NOT here — per-tenant schemas are
 * dropped by `TenantSchemaSyncService` during tenant offboarding under
 * explicit tenant-erasure flow.
 */
export const PROTECTED_SCHEMAS = ['shared', 'event_store', 'auth'] as const;

export type ProtectedSchema = (typeof PROTECTED_SCHEMAS)[number];

export function isProtectedSchema(schemaName: string): boolean {
  const lowered = schemaName.toLowerCase();
  return PROTECTED_SCHEMAS.some((schema) => schema === lowered);
}
