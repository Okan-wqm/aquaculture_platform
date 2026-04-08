# Research: PostgreSQL RLS vs Search Path Tradeoffs

**Topic:** Row-Level Security policy-based isolation, current_setting('app.current_tenant'), BYPASSRLS prevention, search_path + RLS combined defense-in-depth, policy bypass via role privileges
**Date:** 2026-04-08
**Agent:** data-expert

## Sources

- [PostgreSQL 18 — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) (policies, FORCE RLS, BYPASSRLS)
- [PostgreSQL 18 — Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) (secure schema usage patterns)
- [AWS Prescriptive Guidance — Row-level security recommendations](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html) (SaaS tenant isolation best practices)
- [AWS Blog — Multi-tenant data isolation with PostgreSQL RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- Platform source: `libs/backend-common/src/database/rls/tenant-rls.service.ts`, `apply-tenant-rls.helper.ts`, `rls-connection-bootstrap.service.ts`

## Key Findings

### The two isolation models and why aqua-saas combines them

There are three canonical models for multi-tenant data isolation in PostgreSQL:

1. **Database-per-tenant.** Strongest isolation, highest cost, hardest to query across tenants.
2. **Schema-per-tenant (what aqua-saas uses).** Each tenant has its own PostgreSQL schema (`tenant_<16hex>`). Physical separation at the schema level. Connection-level isolation via `search_path`. Requires per-tenant schema provisioning.
3. **Shared schema + RLS.** One schema, one set of tables, every row has a `tenant_id` column, RLS policies enforce `tenant_id = current_setting('app.current_tenant')`. Lowest provisioning cost, highest runtime risk (one policy bug = total leak).

aqua-saas combines models 2 and 3: **schema-per-tenant as the primary isolation boundary, with RLS as defense in depth**. The rationale is that no single mechanism should be trusted alone to prevent cross-tenant leaks — both must fail for a leak to occur.

### The RLS policy pattern (as implemented in `tenant-rls.service.ts`)

The canonical policy format:

```sql
CREATE POLICY "tenant_isolation_<schema>_<table>" ON "<schema>"."<table>"
FOR ALL
USING ("tenantId" = COALESCE(current_setting('app.current_tenant', true), '')::uuid)
```

Components:

- **`FOR ALL`** — applies to SELECT, INSERT, UPDATE, DELETE. The policy is evaluated for both `USING` (visible rows) and `WITH CHECK` (writable rows).
- **`current_setting('app.current_tenant', true)`** — the second argument `true` means "return NULL if the setting is not set" instead of raising an error. Combined with `COALESCE(..., '')` this means: if the setting is unset, the cast to `uuid` of `''` raises an error, which fails closed.
- **`::uuid` cast** — this is the critical defense. If the `tenantId` column is `uuid` and the session setting is also cast to `uuid`, the equality is type-safe. **If the column is `varchar`, the cast fails with `operator does not exist: character varying = uuid`** — which is exactly the 2026-04-07 incident root cause.

The `TenantRlsService.enableRls()` method is idempotent via catching `PG_DUPLICATE_OBJECT` (`42710`). This is correct because the platform runs RLS bootstrap on every startup.

### `SET LOCAL app.current_tenant = <uuid>` — the transaction-scoped context

RLS depends on the application setting the tenant context **before** any query runs. The contract in aqua-saas (`TenantRlsService.setTenantContext`):

```typescript
await manager.query(
  `SELECT set_config('app.current_tenant', $1, true) /* SET LOCAL for RLS */`,
  [tenantId],
);
```

The `true` third argument to `set_config()` makes this equivalent to `SET LOCAL` — transaction-scoped, released at COMMIT/ROLLBACK. This is critical: a session-scoped `SET app.current_tenant = X` would contaminate the pooled connection so the next checkout gets tenant X's context even if the next request is for tenant Y.

The `withTenantContext(manager, tenantId, callback)` helper provides the correct pattern:

```typescript
await setTenantContext(manager, tenantId);
try {
  return await callback();
} finally {
  await clearTenantContext(manager);  // sets app.current_tenant = '' — fails the uuid cast → no rows
}
```

The `finally` branch sets the context to `''`, which makes the RLS policy evaluate `'' ::uuid` — which raises an error, which fails closed. Any query outside a `withTenantContext` wrapper will fail with an RLS error rather than returning all tenants' data. This is the correct posture.

### The three roles that bypass RLS (and how to prevent each)

PostgreSQL docs: *"Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system."* Additionally: *"Table owners normally bypass row security, though a table owner can choose to be subject to row security with `ALTER TABLE ... FORCE ROW LEVEL SECURITY`."*

The three bypass vectors:

1. **Superuser.** No way to prevent this at the SQL level. The application DB role must **never** be a superuser. Review: grep deployment config for `CREATE ROLE ... SUPERUSER` and flag any app role.
2. **`BYPASSRLS` attribute.** A role created with `BYPASSRLS` bypasses all RLS policies. The application role must not have this attribute. Review: `SELECT rolname FROM pg_roles WHERE rolbypassrls = true` on deployment to verify.
3. **Table owner.** By default, the owner of a table bypasses RLS. If the application connects as the same role that created the tables (common in TypeORM setups), **RLS is completely bypassed**. The fix is either:
   - Connect the application as a different role from the one that owns the tables (the correct architectural answer).
   - Use `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, which makes even the owner subject to RLS.

AWS Prescriptive Guidance states: *"The login should not be the table owner or defined with BYPASSRLS."* This is the single most important RLS hardening step and is easy to miss because the default TypeORM setup uses one role for everything.

The `TenantRlsService` has `generateForceRlsSql()` which emits `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, but the reviewer must confirm this is actually called for every table, not just the ones where it's obvious.

### The `BYPASSRLS` role for admin operations

The platform has `bypass-rls.service.ts` and `admin-bypass-rls.interceptor.ts`. These are legitimate for ops operations (backups, cross-tenant admin dashboards, cross-tenant reports). The enforcement rules:

- The bypass path must require an explicit admin privilege at the application layer (not just an API key).
- Every bypass must be audit-logged with the admin user ID and reason.
- The bypass role must be a separate PostgreSQL role from the request-handling role, not a runtime attribute toggle.
- The bypass connection must be opened from a **separate DataSource** (with its own pool) so that bypass state cannot leak into request-handling connections via pool reuse.

Review: any code path that sets a bypass flag on the request-handling DataSource is a **CRITICAL** finding because the flag can leak to the next checkout on the same connection.

### Combining RLS with schema-per-tenant: defense in depth

Both models in aqua-saas simultaneously:

- **Schema isolation:** `search_path = "tenant_A", "farm", public` means unqualified queries resolve `sensors` → `tenant_A.sensors` first. Tenant B's data is in a different schema and inaccessible via unqualified names.
- **RLS isolation:** Even if a query somehow names `tenant_B.sensors` directly, the RLS policy `WHERE tenantId = current_setting('app.current_tenant')::uuid` filters out rows not belonging to the current context.

**For a leak to occur, both must fail**: (a) the `search_path` must resolve to the wrong tenant's schema or a qualified cross-tenant query, AND (b) the RLS policy must allow the row. This is genuine defense in depth.

But the combination also has failure modes:

- **`tenant_id` type mismatch breaks RLS (2026-04-07 incident).** If a table has `tenant_id varchar(255)` and the RLS policy casts `current_setting(...)::uuid`, the policy errors out with `operator does not exist`. The *service crashes* rather than leaking — but this is itself a CRITICAL reliability issue because the whole service goes down.
- **Missing RLS policy on a table.** If a table in a tenant schema is missing an RLS policy, RLS is effectively disabled for that table. The `RlsSchemaBootstrapService` should enable RLS on every expected table; the reviewer confirms coverage.
- **Unset `app.current_tenant`.** If a request runs without setting the tenant context, the RLS policy `COALESCE(..., '')::uuid` raises an error, failing closed. This is the correct behavior.
- **`FORCE ROW LEVEL SECURITY` not applied.** If the table owner connects and `FORCE RLS` is not set, the policy is bypassed silently. This is the silent failure mode.

### The tenant schema search_path + `tenant_id` column question

There is a subtle design question: when every table lives in a tenant-specific schema, does a `tenant_id` column on each table even make sense? Two arguments:

**Against:** In a pure schema-per-tenant model, every row in `tenant_A.sensors` is, by definition, tenant A's. Adding a `tenant_id` column is redundant.

**For:** Defense in depth. The column enables (a) the `CrossTenantProbe` watchdog to verify that rows haven't crossed schemas, (b) the RLS policy to provide a second filter, (c) admin queries across schemas via `UNION ALL` to use a single filter.

aqua-saas chooses the "for" side — every tenant-schema table carries `tenant_id`. The cost is storage + write overhead; the benefit is cross-schema probing and RLS as a second line of defense. This is the correct choice for a safety-critical SaaS.

### The `BaseEvent.tenantId` → `set_config('app.current_tenant')` bridge

The end-to-end flow for a NATS event consumer:

1. Event arrives with `BaseEvent.tenantId` at the top level.
2. Consumer reads `tenantId`, validates it against expected format (UUID v4).
3. Consumer opens a transaction: `BEGIN`.
4. Consumer sets tenant context: `SELECT set_config('app.current_tenant', $1, true)` with `$1 = tenantId`.
5. Consumer sets `search_path`: `SET LOCAL search_path = "tenant_<16hex>", "<source>", public`.
6. Consumer executes business logic queries — both RLS and `search_path` enforce isolation.
7. Consumer commits: `COMMIT` — both contexts release automatically.

If any step is missing, the isolation boundary is weakened. Review rule: every NATS consumer must follow this sequence. A consumer that sets `search_path` but not `app.current_tenant` has schema isolation but not RLS. A consumer that sets `app.current_tenant` but not `search_path` has RLS but queries the wrong schema's tables (which will find nothing or error, failing closed).

### What `search_path` gives that RLS doesn't

- **Physical separation.** Each tenant's data is in a different schema, which means different pg_catalog entries, different statistics, different query plans. A corrupted index for tenant A does not affect tenant B.
- **Per-tenant backup/restore.** `pg_dump -n "tenant_A"` dumps exactly one tenant. With shared-schema RLS, filtering by tenant during backup is painful.
- **Per-tenant resource quotas.** `pg_database_size('tenant_A')` is not a thing, but per-schema measurements work: `SELECT pg_total_relation_size('tenant_A.sensors')`.
- **Deletion simplicity.** `DROP SCHEMA tenant_A CASCADE` deletes every row with no risk of missing a `DELETE FROM foo WHERE tenant_id = A` clause.
- **Indices are tenant-scoped.** An index on `tenant_A.sensors(sensor_id)` contains only tenant A's rows. Cache eviction patterns match tenant access patterns naturally.

### What RLS gives that `search_path` doesn't

- **Policy-level enforcement.** A bug in `search_path` setup still gets caught by the RLS policy.
- **Aggregate cross-tenant queries are possible (when deliberately opened).** An admin report that needs to count rows across all tenants can be written as a single query if RLS is bypassed by an admin role — the schema-per-tenant model requires `UNION ALL` across N schemas.
- **Defense against qualified queries.** If someone writes `SELECT * FROM tenant_B.sensors` from tenant A's context, RLS still filters the result set. `search_path` alone does not help — the query explicitly qualifies the schema.
- **Column-level access control.** RLS policies can reference columns, enabling policies like "only the owning department can see salary data" on top of the tenant filter.

## Security Concerns

- **Application DB role is the same as the table owner** = **CRITICAL**. RLS silently bypassed. The fix: a separate application role that lacks `BYPASSRLS` and is not the owner, combined with `FORCE ROW LEVEL SECURITY` on every tenant table.
- **Application DB role has `BYPASSRLS`** = **CRITICAL**. Check `pg_roles.rolbypassrls` on deployment.
- **Application DB role is a superuser** = **CRITICAL**. Always.
- **Table created without RLS enabled** = **CRITICAL**. Every tenant-schema table must have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + at least one policy.
- **Policy uses `USING (true)` or `FOR ALL USING (true)`** = **CRITICAL**. This is "allow everything" — effectively no policy.
- **`app.current_tenant` set via `SET` (session-scoped) instead of `set_config(..., true)` or `SET LOCAL`** = **CRITICAL**. Leaks across pool checkouts.
- **Missing `ALTER TABLE ... FORCE ROW LEVEL SECURITY`** = **HIGH**. Without FORCE, the owner bypasses the policy.
- **Admin bypass mechanism without audit logging** = **HIGH**. Every RLS bypass must be recorded with user ID and reason.
- **Admin bypass mechanism on the main request DataSource** = **CRITICAL**. Must be a separate DataSource with its own pool.
- **`current_setting('app.current_tenant')` without the `true` second argument** = **HIGH**. Raises an error instead of returning NULL; the `COALESCE(..., '')` pattern is the correct fail-closed.
- **Column type mismatch between `tenantId` column and the policy cast** = **CRITICAL** (the 2026-04-07 incident class).

## Performance Concerns

- **RLS policy subquery on every row.** A policy like `USING (tenantId IN (SELECT id FROM auth.tenants WHERE status = 'ACTIVE'))` runs a subquery per row. Prefer policies that reference only current row values and a GUC: `USING (tenantId = current_setting('app.current_tenant')::uuid)`.
- **`current_setting()` is not free but is cheap.** The cost is a hash lookup in the GUC table. For policies evaluated millions of times per query, this adds up but is not a bottleneck.
- **Planner sometimes cannot use indexes through RLS.** If the policy references a GUC, the planner may not push the filter down to the index scan. Test query plans: `EXPLAIN ANALYZE` on a representative query and confirm the RLS filter is part of the index condition.
- **`FORCE RLS` may prevent some fast paths.** Table owners normally get shortcuts that skip RLS evaluation. With FORCE, every owner query pays the RLS cost.
- **Schema-per-tenant has statistics fragmentation.** Each schema has its own stats. Query plans may differ between tenants based on data distribution. Usually acceptable, occasionally surprising.
- **`EXPLAIN` leakage.** RLS does not block EXPLAIN, which can leak statistics about rows the user cannot see. Document this as a known limitation for admin dashboards.

## Architectural Implications for data-expert reviews

1. **Single most important review check: who owns the tables.** The application DB role must not be the table owner. The review runs `SELECT tableowner FROM pg_tables WHERE schemaname LIKE 'tenant_%' LIMIT 1` mentally and confirms the owner is not the application role. If it is, the review demands `FORCE RLS` as a minimum and flags the architecture as needing a role split.
2. **Every tenant-schema table must have RLS enabled + FORCE RLS + a policy.** The reviewer grep-checks for `generateEnableRlsSql`, `generateForceRlsSql`, and `generateCreatePolicySql` coverage against the list of tables in `MODULE_SCHEMAS[module].tables`.
3. **The `tenant_id` column must be `uuid`, not `varchar`.** Type mismatch with the policy cast = **CRITICAL**.
4. **The `set_config('app.current_tenant', $1, true)` pattern is mandatory.** Any code path that uses bare `SET` is **CRITICAL**.
5. **`withTenantContext` wrapper must include a `finally` that clears the context.** Without the clear, the context leaks across transactions on the same connection.
6. **Admin bypass must be a separate role + separate DataSource.** Any PR that adds bypass logic on the main DataSource is **CRITICAL**.
7. **Audit log for every bypass.** Missing audit is **HIGH**.
8. **Defense in depth checklist.** For every new entity in a multi-tenant module, the reviewer checks: (a) `@Column({ type: 'uuid' }) tenantId`, (b) `MODULE_SCHEMAS` entry, (c) RLS policy coverage, (d) `CrossTenantProbe` recognition of the column name, (e) `search_path` automatic routing via `TenantConnectionBootstrap`.
9. **`FOR ALL USING (true)` catch-all policies are never acceptable on tenant tables.** **CRITICAL** finding.
10. **Explicit test that RLS is enforced.** Each module should have an integration test that opens a connection without setting `app.current_tenant` and confirms that SELECT returns zero rows (or raises an error). Missing this test is **HIGH**.

## Domain Rule Additions for data-expert

- Application PostgreSQL role is the owner of tenant-schema tables (i.e., the same role that created them) **and** `FORCE ROW LEVEL SECURITY` is not applied = **CRITICAL** (RLS silently bypassed).
- Application PostgreSQL role has `BYPASSRLS` attribute or is a superuser = **CRITICAL**.
- Tenant-schema table created without `ENABLE ROW LEVEL SECURITY` = **CRITICAL**.
- Tenant-schema table with RLS enabled but no policy = **CRITICAL** (default-deny means unused, but the intent is wrong).
- RLS policy using `USING (true)` or `FOR ALL USING (true)` on a tenant table = **CRITICAL**.
- `tenant_id` column typed as `varchar` / `text` / `string` instead of `uuid`, combined with an RLS policy that casts `current_setting(..., true)::uuid` = **CRITICAL** (2026-04-07 incident class).
- `SET app.current_tenant = ...` (session-scoped) instead of `set_config('app.current_tenant', $1, true)` or `SET LOCAL` = **CRITICAL** (pool contamination).
- `withTenantContext()` wrapper without a `finally` clear of `app.current_tenant` = **HIGH**.
- Admin RLS bypass code path executing on the main request DataSource instead of a dedicated bypass DataSource = **CRITICAL**.
- Admin RLS bypass code path without audit log entry (user ID + reason + timestamp) = **HIGH**.
- `current_setting('app.current_tenant')` without the `, true` (missing_ok) second argument = **HIGH** (hard error instead of fail-closed NULL).
- Missing `FORCE ROW LEVEL SECURITY` on a tenant-schema table when the application role might be the table owner = **HIGH**.
- Missing integration test that asserts RLS denies access when `app.current_tenant` is unset = **HIGH**.
- RLS policy that references another table via a subquery (e.g., `USING (tenant_id IN (SELECT id FROM auth.tenants ...))`) without a `SELECT ... FOR SHARE` or security-definer function wrapper = **MEDIUM** (race condition, perf concern).
- `ENABLE RLS` and `FORCE RLS` missing from `apply-tenant-rls.helper.ts` coverage for any entity with a `tenantId` column = **CRITICAL**.
