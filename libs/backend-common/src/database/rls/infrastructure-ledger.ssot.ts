/**
 * SSoT — cross-tenant infrastructure AUDIT LEDGERS.
 * ============================================================================
 *
 * Keyed by the SOURCE schema the ledger lives in. Every table here:
 *
 *   1. lives in a service's base/source schema (NOT a `tenant_<uuid>` clone —
 *      these are `infrastructureTables` / platform tables, never fan-out
 *      copied per tenant),
 *   2. is CROSS-TENANT: rows are written from paths that legitimately have NO
 *      tenant context on the connection — cron jobs, NATS `@MessagePattern`
 *      consumers, TypeORM subscribers on ingestion mutations, pre-auth login
 *      events, platform-level SUPER_ADMIN actors (tenantId NULL), and
 *      unauthenticated webhooks,
 *   3. is an APPEND-ONLY immutable audit ledger (SOX §404 / SOC 2 CC4+CC7 —
 *      enforced by BEFORE UPDATE/DELETE immutability triggers).
 *
 * # Why they must NOT carry `tenant_isolation_policy`
 *
 * The canonical tenant policy is `bypass OR tenantId = current_tenant`. A
 * cross-tenant ledger written with NO `app.current_tenant` GUC (or a NULL
 * tenantId) can NEVER satisfy that predicate, so PostgreSQL silently REJECTS
 * every such INSERT — the compliance-critical audit row vanishes with no
 * error. This is the exact defect diagnosed as ORPHAN-HIGH-308 (auth) and
 * ORPHAN-MEDIUM-324 (alert / hr / sensor / ai / shared). Worse for
 * `hr.payroll_audit`: the rejected INSERT rolls back the whole payroll
 * transaction.
 *
 * These tables instead get the canonical infrastructure-ledger policy
 * (`applyInfrastructureLedgerRls`): an unconditional append INSERT policy + a
 * system-aware SELECT policy that lets any context read back the row it just
 * wrote (fixing the `INSERT … RETURNING` re-check too) while still filtering a
 * tenant-scoped read to its own rows — and NO update/delete policy, so
 * immutability is enforced by RLS as well as by the trigger.
 *
 * # Deliberately EXCLUDED (do not add without the reasoning)
 *
 *   - PER-TENANT audit tables — `messaging.compliance_audit_log`,
 *     `sensor.vfd_parameter_audit_logs`, `sensor.audit_archive_v1`. These are
 *     in each module's `tables` (fan-out cloned into `tenant_<uuid>` schemas),
 *     isolated by the schema boundary, and written WITH tenant context. Tenant
 *     RLS is correct for them.
 *   - `admin.audit_logs` — never carried `tenant_isolation_policy` (append-only
 *     trigger + `REVOKE UPDATE,DELETE FROM PUBLIC` only); admin writes run
 *     under `AdminBypassRlsInterceptor`. Not at risk.
 *   - outbox / inbox / DLQ / migrations / erasure-proof ledgers — mutable
 *     queues + bookkeeping, drained by the outbox worker's audited RLS bypass
 *     (ORPHAN-HIGH-321). Different lifecycle; not append-only ledgers.
 *
 * # Invariant coupling
 *
 * `tests/invariants/infrastructure-ledger-ssot.spec.ts` cross-checks this list
 * against `PROTECTED_TABLES` (every ledger must be immutability-protected) and
 * against `MODULE_SCHEMAS[].infrastructureTables` (every tenant-scoped-service
 * ledger must be a declared cross-tenant infra table). Adding a ledger here
 * without satisfying both fails CI.
 */
export const INFRASTRUCTURE_AUDIT_LEDGERS: Readonly<Record<string, readonly string[]>> = {
  // Platform-level schemas (no tenant fan-out; source-only).
  auth: ['audit_logs'],
  shared: ['audit_logs'],

  // Tenant-scoped service SOURCE schemas (the ledger stays cross-tenant; only
  // the per-tenant `tables` are cloned).
  farm: ['farm_audit_logs', 'tenant_erasure_audit'],
  hr: ['payroll_audit'],
  alert: ['alert_audit_log'],
  ai: ['tool_execution_audit'],
  sensor: ['sensor_audit_logs'],
} as const;

/**
 * The infrastructure audit-ledger table names for `schema`, or `[]` when the
 * schema owns none. Used by the db-migrate hardening pass to drive
 * `applyInfrastructureLedgerRls`.
 */
export function getInfrastructureAuditLedgers(schema: string): readonly string[] {
  return INFRASTRUCTURE_AUDIT_LEDGERS[schema] ?? [];
}

/**
 * Fully-qualified `schema.table` names of every infrastructure audit ledger —
 * the flat form the invariant spec cross-checks against `PROTECTED_TABLES`.
 */
export function listInfrastructureAuditLedgerQualifiedNames(): string[] {
  return Object.entries(INFRASTRUCTURE_AUDIT_LEDGERS).flatMap(([schema, tables]) =>
    tables.map((table) => `${schema}.${table}`),
  );
}
