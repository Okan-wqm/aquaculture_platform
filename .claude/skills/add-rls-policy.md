---
name: add-rls-policy
description: Add a new Postgres Row-Level Security policy to a tenant-scoped or shared table with FORCE ROW LEVEL SECURITY + security_invoker views + test coverage
type: skill
version: 1
owners: database-reviewer, auth-security-expert, data-expert
handoff:
  on_complete_invoke: [database-reviewer, auth-security-expert]
  on_security_touch: security-reviewer
  on_event_impact: null
  on_multi_tenant_touch: multi-tenant-saas-expert
---

# Skill — Add RLS Policy

## When to invoke

A review surfaces "tenant table X has no RLS policy" OR a new tenant-scoped table is being added. RLS is a defense-in-depth layer per the tenant-isolation 5-layer model (`TenantGuard → search_path → RLS → WHERE tenant_id → CrossTenantProbe`).

## Prerequisites

- Table carries a `tenant_id uuid NOT NULL` column.
- Application role is NOT a superuser AND does NOT have `BYPASSRLS` (audit via `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolcanlogin;`).
- Application session sets `app.current_tenant` via `SET LOCAL` inside every request-scoped transaction (per `TenantConnectionBootstrap.patchConnectionPool()` contract — see data-expert's `search_path` three-branch contract).

## Cascade

### Step 1 — Enable RLS + FORCE ROW LEVEL SECURITY on the table

**Affected files:** migration `<timestamp>-EnableRlsOn<Table>.ts`.

**Mechanism:**
```sql
ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <schema>.<table> FORCE ROW LEVEL SECURITY;
```

**Why:** `ENABLE` alone leaves the table OWNER exempt from RLS. If the application role owns the table (common under `CREATE TABLE LIKE ... INCLUDING ALL` during tenant-schema provisioning), RLS is SILENTLY bypassed. `FORCE` closes that hole. Per database-reviewer invariant, missing `FORCE` on owner-owned tables = CRITICAL.

**Verification:** `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '<table>';` returns `(t, t)`.

**Cross-domain notifications:** `security-reviewer` cross-cutting quality gate; `auth-security-expert` for auth flow validation.

### Step 2 — Write the policy expression with safe `current_setting`

**Affected files:** same migration as Step 1.

**Mechanism:**
```sql
CREATE POLICY <table>_tenant_isolation ON <schema>.<table>
  FOR ALL
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
```

- `current_setting('app.current_tenant', true)` — second arg `true` returns NULL for missing setting instead of raising.
- `NULLIF(..., '')` — empty string → NULL (fail-closed: NULL does not equal any tenantId, so row is invisible).
- `::uuid` — cast forces type-safety; a bogus string setting errors out rather than matches by coincidence.
- `FOR ALL` — covers SELECT/INSERT/UPDATE/DELETE with the same predicate.
- `WITH CHECK` — prevents INSERT/UPDATE from writing rows that the SELECT predicate would hide (otherwise you could insert a row for another tenant and immediately lose it).

**Why:** raw `current_setting('name')` without second arg raises on unset (breaks the catch-all policy at boot). Empty-string coercion without `NULLIF` matches any row (the empty-cast-to-uuid can produce a match depending on driver). The `WITH CHECK` clause is often forgotten — write amplification bug without it. Per database-reviewer RLS invariants: `FOR ALL USING (true)` or catch-all-returning-true on a tenant table = CRITICAL.

**Verification:** integration test sets `SET LOCAL app.current_tenant = '<tenant-A>'`, inserts a row, then sets `SET LOCAL app.current_tenant = '<tenant-B>'` + asserts row is invisible. Second test: insert a row for tenant-A while session is tenant-B → expects the `WITH CHECK` violation.

**Cross-domain notifications:** `security-reviewer` tenant-isolation audit.

### Step 3 — Add admin-bypass policy on a SEPARATE role (if needed)

**Affected files:** same migration.

**Mechanism:** IF cross-tenant reporting / admin debugging is required, do NOT grant `BYPASSRLS` to the role — use a POLICY-level exception:

```sql
CREATE POLICY <table>_admin_read ON <schema>.<table>
  FOR SELECT
  TO reporting_role
  USING (true);
```

AND use a SEPARATE DataSource (its own connection pool) so bypass state cannot leak into request connections.

**Why:** `BYPASSRLS` on the role invisibly disables RLS for every session that connects as that role — no audit trail of who used the bypass. A POLICY-level exception TO `reporting_role` is audit-traceable via query logs + requires explicit application wiring to use the reporting DataSource. Per database-reviewer: BYPASSRLS on the reporting role = CRITICAL.

**Verification:** integration test asserts reporting_role SELECT returns all tenants' rows; application_role SELECT returns only the active tenant's rows.

**Cross-domain notifications:** `auth-security-expert` for admin-bypass audit discipline.

### Step 4 — Wrap existing views with `security_invoker` (PG 15+)

**Affected files:** any view that SELECTs from the RLS-protected table — `apps/<svc>/src/<domain>/views/*.sql`, migration files creating views.

**Mechanism:** add `WITH (security_invoker = true)` to every view definition:

```sql
CREATE OR REPLACE VIEW <schema>.<view_name> WITH (security_invoker = true) AS
  SELECT ... FROM <schema>.<rls_protected_table> WHERE ...;
```

**Why:** without `security_invoker`, views run with the VIEW OWNER's privileges — if the owner is the application role, RLS is bypassed from inside the view. PG 15+ `security_invoker = true` makes the view run with the CALLER's privileges, preserving RLS. Per database-reviewer: views over RLS-protected tables without `security_invoker` = HIGH.

**Verification:** integration test queries the view from a tenant-A session + asserts it only returns tenant-A rows. Query `SELECT reloptions FROM pg_class WHERE relname = '<view>';` includes `security_invoker=true`.

**Cross-domain notifications:** `database-reviewer` schema-state secondary.

### Step 5 — Application-side `SET LOCAL app.current_tenant` discipline

**Affected files:** `libs/backend-common/src/database/tenant-connection.bootstrap.ts` (or equivalent request-scoped bootstrap).

**Mechanism:** on every pooled-connection checkout in a request context, the bootstrap emits `SET LOCAL app.current_tenant = '<JWT-tenantId>'` as the FIRST statement after `SET LOCAL search_path = ...`. `SET LOCAL` scope is the current transaction only — the pool checkout for the next request resets. Session-scoped `SET app.current_tenant = ...` = CRITICAL (leaks tenant across transactions sharing a pooled server connection).

**Why:** RLS policies read `app.current_tenant` via `current_setting()`. If the setting is never established, the fail-closed `NULLIF(..., '')` path returns NULL → zero rows visible (rather than an error) — which is correct from a security-postur perspective BUT means the entire request fails silently. Fix both: bootstrap sets it correctly on legitimate requests + application observes the row-count anomaly for unset cases.

**Verification:** integration test simulating a request without `app.current_tenant` set → expects zero rows returned from a tenant-scoped repository query (not an exception).

**Cross-domain notifications:** `data-expert` (pool-contamination risk); `auth-security-expert` (JWT claim validation feeds the bootstrap).

### Step 6 — Add the policy to `apply-tenant-rls.helper` for per-tenant schema replay

**Affected files:** `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`.

**Mechanism:** per data-expert invariant, `CREATE TABLE LIKE ... INCLUDING ALL` does NOT copy RLS policies. Every tenant-schema bootstrap must re-apply the policy via `apply-tenant-rls.helper`. Append the new policy to the helper's policy list with the `{tenant_schema}` placeholder.

**Why:** without replay, new tenants created after the migration never get the policy. Existing tenants would also miss it if the `SchemaManagerService.createTenantSchema` path is the only RLS installer. Per data-expert: `CREATE TABLE LIKE ... INCLUDING ALL` does NOT copy FK / RLS / triggers.

**Verification:** `provision-tenant` skill Step 4 integration test — a newly-provisioned tenant schema shows the policy via `pg_policies`.

**Cross-domain notifications:** `multi-tenant-saas-expert` tenant-lifecycle discipline.

### Step 7 — Update adoption-invariants test

**Affected files:** `tests/invariants/adoption-invariants.spec.ts` (if the RLS policy coverage is tracked there).

**Mechanism:** if adoption-invariants enumerates RLS-protected tables, add the newly-covered table. If the test doesn't enumerate RLS coverage yet, this step is a no-op — MT-HIGH-003 (2/7 services with RLS) is the broader backlog and is tracked separately.

**Why:** invariant tests catch drift. A newly-added policy that gets dropped by a future migration needs the invariant to holler.

**Verification:** `npx jest --config tests/invariants/jest.config.ts --testPathPatterns=adoption-invariants` pass.

**Cross-domain notifications:** `context-manager` (systemic pattern detection on RLS coverage).

## Validation checklist

- [ ] `FORCE ROW LEVEL SECURITY` applied + verified via `pg_class`.
- [ ] Policy uses `current_setting('app.current_tenant', true)` + `NULLIF` + `::uuid` cast.
- [ ] `WITH CHECK` clause present.
- [ ] Admin-bypass (if any) is POLICY-level on a SEPARATE role, not BYPASSRLS.
- [ ] All views on the table declared `WITH (security_invoker = true)`.
- [ ] Application bootstrap sets `SET LOCAL app.current_tenant` per request.
- [ ] Policy appended to `apply-tenant-rls.helper` for per-tenant replay.
- [ ] Integration tests: (a) tenant-A inserts are invisible to tenant-B SELECT; (b) cross-tenant INSERT blocked by `WITH CHECK`; (c) unset `app.current_tenant` returns zero rows fail-closed.

## Examples

- `libs/backend-common/src/database/rls/` — existing RLS helper; reference for Step 6.
- Current repository coverage: 2/7 schema-owning services per MT-HIGH-003 (multi-tenant-saas-expert backlog). This skill is what closes that gap service-by-service.

## Cross-references

- ADR-011 — schema ownership + RLS placement.
- `.claude/agents/database-reviewer.md` — RLS invariants (FORCE, current_setting safety, security_invoker views).
- `.claude/agents/data-expert.md` — three RLS bypass vectors (superuser, BYPASSRLS, owner-exemption).
- `.claude/agents/multi-tenant-saas-expert.md` — 5-layer tenant isolation.
- `.claude/agents/security-reviewer.md` — cross-cutting quality gate (tenant isolation).
- AWS Prescriptive Guidance — "Three RLS bypass vectors" reference.

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable.
