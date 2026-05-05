# Audit Table Doctrine

**Closes:** [DBR-LOW-002](../reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-LOW-002)

**Status:** AUTHORITATIVE. Defines when audit tables MUST be
NOT NULL on `tenantId`, when nullable is correct, and the RLS
policy shape that handles each case. The DBR-MEDIUM-006 follow-on
(architectural-arbiter ADR) extends this doctrine to cover the
full per-table audit-policy matrix.

---

## Three audit-table classes

Audit tables fall into three architectural classes, each with
distinct nullability + RLS contracts.

### Class 1 — Per-tenant audit (`tenantId` NOT NULL)

Tables that record actions WITHIN a single tenant boundary. Every
row has an authoritative tenant owner; cross-tenant rows are
forbidden by construction.

**Examples:**
- `farm.farm_audit_logs` — actions on farm-service entities
- `messaging.compliance_audit_log` — channel/message lifecycle
- `sensor.sensor_audit_logs` — entity-mutation rows from
  TypeORM AuditSubscriber

**Contract:**
- `tenantId` column: `uuid NOT NULL`.
- RLS policy: `USING tenantId = current_setting('app.current_tenant')::uuid`.
- Insert path validates tenantId is non-null; the column-level
  NOT NULL is the belt+suspenders fail-safe.

### Class 2 — Cross-tenant audit (`tenantId` nullable, NULL = system)

Tables that record actions ACROSS tenant boundaries OR record
system-level events that have no tenant.

**Examples:**
- `shared.audit_logs` — semantic-action audit (the canonical one)
- `admin.audit_logs` — SUPER_ADMIN cross-tenant actions
- `auth.audit_logs` — login/logout/MFA events (tenant-scoped at
  login time, but pre-auth events have no tenant yet)

**Contract:**
- `tenantId` column: `uuid NULL`.
- Semantics:
  - Non-NULL tenantId → action targeted that tenant.
  - NULL tenantId → system-level action (tenant provisioning,
    schema bootstrap, platform-wide configuration).
- RLS policy (when enabled): MUST handle NULL explicitly.

  ```sql
  CREATE POLICY shared_audit_log_tenant_isolation
    ON shared.audit_logs
    FOR SELECT
    USING (
      "tenantId" = current_setting('app.current_tenant')::uuid
      OR ("tenantId" IS NULL AND has_role('platform_admin'))
      OR current_setting('app.bypass_rls', true) = 'on'
    );
  ```

  Without explicit NULL handling, the default policy semantics
  reject NULL rows for every reader — system-level rows become
  invisible to platform admins (the only legitimate readers).

- A SUPER_ADMIN cross-tenant action may have BOTH a non-NULL
  `actedOnTenantId` (the targeted tenant) and a populated
  `actorHomeTenantId` (the admin's home tenant). The
  AUDITTRAIL-CRITICAL-004 mandatory shape exposes both
  axes — `tenantId` (legacy alias for actedOnTenantId)
  reflects the action's primary scope.

### Class 3 — Cross-tenant ledger (no tenant column at all)

Tables that record platform-wide events with no tenant binding.

**Examples:**
- `shared.gdpr_data_requests` — request type + status; tenant
  identifiers live on the request rows themselves
- (future) `shared.platform_audit` — platform-bootstrap events

**Contract:**
- No `tenantId` column.
- RLS not applicable (no per-row tenant discriminator to
  filter on).
- Queries gated at the application layer via SUPER_ADMIN-only
  controllers + audit row on every read.

---

## Decision tree — which class?

```
Q1: Does this table record actions that can ONLY belong to one tenant?
  YES → Class 1 (NOT NULL tenantId)
  NO  → Q2

Q2: Does this table record actions that can span tenants OR
    have legitimate system-level events?
  YES → Class 2 (nullable tenantId)
  NO  → Q3

Q3: Does this table track platform-wide state with no per-row
    tenant identity?
  YES → Class 3 (no tenantId column)
  NO  → re-read the question; you've described a per-row dimension
        that's not the tenant boundary
```

---

## RLS adoption migration path

Most audit tables today do NOT have RLS enabled at the database
layer. Tenant isolation happens at the application layer via
`getScopedRepository` + the request-context tenantId.

**Why we don't enable RLS by default on audit tables:**
- Class 2's NULL handling complicates the policy shape (admin
  visibility, bypass-rls semantics for cron jobs).
- Audit-row INSERT paths already validate tenantId scope at the
  service layer; double-validation costs query-planner overhead
  without changing the security posture in the common case.

**When to enable RLS:**
- Defense-in-depth for tables touched by raw SQL paths
  (migrations, cron jobs, operator-driven queries).
- After the policy shape has been written + tested against the
  per-class contract above (NOT just blanket-applied — Class 2
  needs the NULL-handling clause).
- Per-table architectural-arbiter approval; the audit-table
  doctrine here is the spec the policy must satisfy.

---

## Failure modes the doctrine prevents

1. **Class 1 misapplied as Class 2** — a per-tenant audit
   accidentally allows NULL inserts. Cross-tenant data leakage
   on the next RLS bypass.
2. **Class 2 misapplied as Class 1** — a cross-tenant audit
   forced to NOT NULL. System-level events (tenant
   provisioning, schema bootstrap) become un-auditable; the
   audit row write fails the column constraint.
3. **Class 2 RLS without NULL clause** — system-level rows
   invisible to readers; platform admins lose access to the
   primary forensic surface for cross-tenant operations.

---

## Per-table audit-class registry

| Table | Class | Notes |
|---|---|---|
| `shared.audit_logs` | 2 | Canonical cross-tenant + system audit. AUDITTRAIL-CRITICAL-004 mandatory shape. |
| `shared.access_logs` | 2 | Low-level HTTP request audit. NULL tenantId on pre-auth requests. |
| `shared.gdpr_data_requests` | 3 | Platform-level GDPR ledger; no tenant column. |
| `admin.audit_logs` | 2 | SUPER_ADMIN cross-tenant action trail. |
| `auth.audit_logs` | 2 | Login/logout/MFA events; pre-auth events have NULL tenantId. |
| `farm.farm_audit_logs` | 1 | Per-tenant. NOT NULL on tenantId. |
| `messaging.compliance_audit_log` | 1 | Per-tenant. NOT NULL. Has DB-level immutability triggers. |
| `sensor.sensor_audit_logs` | 1 | Per-tenant. NOT NULL. Entity-mutation stream. |

Adding a new audit table requires:
1. Determine the class via the decision tree above.
2. Set the NOT NULL / nullable contract per the class table.
3. If RLS is enabled, write the policy per the class spec.
4. Add the row to this registry.
5. Update the corresponding entity declaration's docblock with
   a cross-reference to this doctrine.

---

## Related documents

- [ADR-011](../adr/011-schema-ownership-model.md) — schema
  ownership + SHARED_SCHEMA_TABLES list.
- [ADR-012](../adr/012-schema-drift-prevention.md) — schema
  drift detection, including audit-table column shape.
- [`AUDITTRAIL-CRITICAL-004`](../reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-CRITICAL-004)
  — mandatory shape extension for shared.audit_logs.
- [`DBR-MEDIUM-006`](../reviews/database-reviewer/2026-04-28-core-platform-review.md)
  — architectural-arbiter ADR follow-on extending this doctrine.
