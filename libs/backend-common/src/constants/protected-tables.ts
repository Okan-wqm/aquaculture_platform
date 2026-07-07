/**
 * Protected Tables — Single Source of Truth
 * ============================================================================
 *
 * # WHY
 *
 * Some tables carry **compliance-critical invariants** that cannot survive a
 * `DROP TABLE`, `DROP SCHEMA … CASCADE`, or column drop. They are:
 *
 *   - **Audit trails** — `shared.audit_logs`, `event_store.events`,
 *     `farm.farm_audit_logs`, `hr.payroll_audit`, `ai.tool_execution_audit`,
 *     `alert.alert_audit_log`. SOC 2 CC4 + SOX § 404 record-integrity require
 *     append-only invariants; trigger-based immutability ENFORCES this.
 *   - **Compliance state** — `shared.gdpr_data_requests`, `shared.user_consents`,
 *     `shared.user_permissions`, `shared.access_logs`. Legal-hold precedence
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
 * 1. Add the fully-qualified name to `PROTECTED_TABLES`.
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
 * Fully-qualified schema.table names that are protected from destructive
 * DDL without an explicit compliance waiver.
 *
 * Order: grouped by compliance domain (audit / legal / consent / outbox).
 * Lowercase canonical form — every comparison MUST lowercase the input.
 */
export const PROTECTED_TABLES = [
  // ── Shared schema — cross-tenant compliance state (ADR-011 canonical 5-table set) ──
  // Aligned with SHARED_SCHEMA_TABLES in scripts/schema-registry/generate-init-schemas.ts
  // and with the CREATE TABLE statements in
  // apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql.
  // tests/invariants/shared-schema-canonical.spec.ts enforces parity between
  // these three sources on every PR.
  'shared.audit_logs',
  'shared.gdpr_data_requests',
  'shared.user_consents',
  'shared.user_permissions',
  'shared.access_logs',

  // ── Event sourcing — append-only stream of truth ──
  'event_store.events',
  'event_store.stored_events',
  'event_store.snapshots',

  // ── Per-service audit/ledger tables (cross-tenant within tenant-scoped services) ──
  'ai.tool_execution_audit',
  'alert.alert_audit_log',
  'farm.farm_audit_logs',
  'farm.tenant_erasure_audit',
  'hr.payroll_audit',
  'hr.leave_ledger_entries',
  'messaging.compliance_audit_log',
  'messaging.legal_holds',
  // ORPHAN-MEDIUM-324: sensor.sensor_audit_logs ships an append-only
  // immutability trigger + REVOKE UPDATE,DELETE (sensor Baseline) that names
  // "protected-tables-guard" in its exception, but the table was never added
  // to this SSoT — the gap the infrastructure-ledger-ssot invariant surfaced.
  'sensor.sensor_audit_logs',

  // ── Auth audit (SOC 2 CC7.2 detective control) ──
  'auth.audit_logs',
  'admin.audit_logs',
  'admin.impersonation_sessions',

  // ── Findings registry (review trail) ──
  'event_store.findings',
] as const;

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
export const COMPLIANCE_WAIVER_MARKER_RE =
  /--\s*COMPLIANCE-WAIVER:\s*\S+/i;

export type ProtectedTable = (typeof PROTECTED_TABLES)[number];

/**
 * Type-narrow a string against the protected list.
 */
export function isExplicitlyProtectedTable(
  qualifiedName: string,
): qualifiedName is ProtectedTable {
  const lowered = qualifiedName.toLowerCase();
  return (PROTECTED_TABLES as readonly string[]).includes(lowered);
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
  return (
    isExplicitlyProtectedTable(qualifiedName) ||
    matchesProtectedTablePattern(qualifiedName)
  );
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
export const PROTECTED_SCHEMAS = [
  'shared',
  'event_store',
  'auth',
] as const;

export type ProtectedSchema = (typeof PROTECTED_SCHEMAS)[number];

export function isProtectedSchema(schemaName: string): boolean {
  const lowered = schemaName.toLowerCase();
  return (PROTECTED_SCHEMAS as readonly string[]).includes(lowered);
}
