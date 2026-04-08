# Research: Row Level Security vs search_path for Multi-Tenant Isolation — Production Tradeoffs

**Topic:** Enterprise comparison of PostgreSQL Row Level Security (RLS) and `search_path`-based schema-per-tenant isolation, their threat models, and combining them for defense in depth.
**Date:** 2026-04-08
**Agent:** database-reviewer

## Sources
- [PostgreSQL: Documentation 15 — Row Security Policies](https://www.postgresql.org/docs/15/ddl-rowsecurity.html)
- [PostgreSQL: Documentation 15 — Predefined Roles (BYPASSRLS)](https://www.postgresql.org/docs/15/predefined-roles.html)
- [PostgreSQL: Documentation 15 — CREATE POLICY](https://www.postgresql.org/docs/15/sql-createpolicy.html)
- [PostgreSQL: Documentation 15 — ALTER ROLE (BYPASSRLS attribute)](https://www.postgresql.org/docs/15/sql-alterrole.html)
- [PostgreSQL Wiki: Row-security](https://wiki.postgresql.org/wiki/Row-security)
- [AWS: Multi-tenant data isolation with PostgreSQL Row Level Security](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- [AWS Prescriptive Guidance: Row-level security recommendations for SaaS on managed PostgreSQL](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html)
- [AWS Prescriptive Guidance: Choose the right PostgreSQL data access pattern for your SaaS application](https://aws.amazon.com/blogs/database/choose-the-right-postgresql-data-access-pattern-for-your-saas-application/)
- [AWS: Best practices for managed multi-tenant PostgreSQL SaaS](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/best-practices.html)
- [Crunchy Data: Row Level Security for Tenants in Postgres](https://www.crunchydata.com/blog/row-level-security-for-tenants-in-postgres)
- [Crunchy Data: Row Level Security Tutorial](https://www.crunchydata.com/developers/playground/row-level-security)
- [Cybertec: PostgreSQL Row Level Security, views and a lot of magic](https://www.cybertec-postgresql.com/en/postgresql-row-level-security-views-and-a-lot-of-magic/)
- [Citus Data: Raw SQL access for users with row-level-security](https://www.citusdata.com/blog/2018/04/04/raw-sql-access-with-row-level-security/)

## Key Findings

1. **Three dominant multi-tenant isolation models in PostgreSQL:**
   - **Database-per-tenant** — hardest isolation, highest cost, doesn't scale past ~100 tenants.
   - **Schema-per-tenant** — one PostgreSQL schema per tenant, selected via `search_path`. Aqua-saas default (`tenant_{16hex}`).
   - **Shared schema with RLS** — single schema, `tenant_id` column on every row, RLS policy filters rows. Scales to tens of thousands of tenants.
2. **Schema-per-tenant isolation mechanism:**
   - Each tenant's tables live in a distinct schema: `tenant_a1b2c3d4e5f6a7b8.batches`, `tenant_a1b2c3d4e5f6a7b8.harvests`, etc.
   - Every query resolves unqualified table names via `search_path`.
   - Setting `SET LOCAL search_path TO tenant_{id}, <service>, public` scopes all subsequent queries in the transaction to that tenant's schema.
   - **Isolation is enforced by missing names** — tenant A has no way to reference tenant B's tables unless they write `tenant_b.batches` explicitly, which tenant A's application never does.
3. **Schema-per-tenant strengths:**
   - Structural isolation: no shared rows, so no cross-tenant row leak even from a broken query.
   - Simple mental model for developers: the tenant scope is the schema, queries look normal.
   - Schema-level operations (DROP, backup, restore, migration) operate on one tenant cleanly.
   - Index statistics are per-tenant; one noisy tenant doesn't pollute another's query plans.
4. **Schema-per-tenant weaknesses:**
   - Catalog bloat at scale: ~10K schemas × ~50 tables = 500K entries in `pg_class`. Query planning overhead grows.
   - Migration fan-out: a schema change must be applied to every tenant schema, typically via a `TenantSchemaSyncService` + watchdog. A partial application yields drift.
   - Cross-tenant analytics (e.g., "count active batches across all tenants") requires iterating schemas.
   - Schema name is attacker-controlled in naive implementations — interpolation without regex validation = SQL injection.
   - `search_path` under PgBouncer transaction pooling: session-level `SET search_path` persists across transaction boundaries and leaks between tenants. `SET LOCAL` is required.
5. **Row Level Security mechanism:**
   - Table has a `tenant_id` column on every row.
   - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` turns on enforcement.
   - `CREATE POLICY ... USING (tenant_id = current_setting('app.current_tenant')::uuid)` defines the filter.
   - Application sets `SET LOCAL app.current_tenant = '...'` inside every transaction.
   - Every `SELECT`, `UPDATE`, `DELETE` is silently augmented with the policy's `WHERE` clause.
6. **RLS policy types:**
   - `PERMISSIVE` (default) — multiple permissive policies OR together. Any one matching = row visible.
   - `RESTRICTIVE` — multiple restrictive policies AND together. All must match.
   - Combining both: final filter = `(OR of permissive) AND (AND of restrictive)`.
   - Command-specific: `FOR SELECT`, `FOR INSERT`, `FOR UPDATE`, `FOR DELETE`, or `FOR ALL`.
7. **RLS strengths:**
   - Structural per-row enforcement — even raw SQL goes through the policy.
   - One schema, one migration path — no fan-out across tenants.
   - Scales to tens of thousands of tenants without catalog bloat.
   - Cross-tenant analytics is a SET ROLE away (with a reporting role that bypasses RLS via a policy, not BYPASSRLS).
8. **RLS weaknesses:**
   - **Depends on `current_setting()` being correctly set on every transaction.** A forgotten `SET LOCAL` returns an empty string, which combined with `NULLIF(..., '')::uuid` yields NULL, which the policy rejects. But if the policy is written `USING (tenant_id = current_setting('app.current_tenant')::uuid)` without NULLIF, the cast fails and every query errors. Worse: if the policy is written `USING (tenant_id::text = current_setting('app.current_tenant', true))`, a missing setting returns empty string, and a typo on the column side can make it match — production bug surface.
   - **Anyone who can set session variables can impersonate any tenant.** The isolation is only as strong as the application's discipline in never exposing `SET` to user input.
   - Policies have runtime cost — every row touched goes through the predicate. Well-indexed (leading `tenant_id` on every index) mitigates most of it.
   - Complex policies (joins, subqueries, function calls) can devastate the planner.
9. **BYPASSRLS is the silent killer.** A role with `BYPASSRLS` attribute or `SUPERUSER` privilege ignores ALL RLS policies. If the application connection role has `BYPASSRLS`, the entire RLS layer is a no-op.
   - Default postgres `postgres` role is SUPERUSER.
   - AWS RDS `rds_superuser` has BYPASSRLS implicitly.
   - Application roles MUST be created without SUPERUSER and without BYPASSRLS. Verify with `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles`.
10. **FORCE ROW LEVEL SECURITY** — by default, the table owner bypasses RLS on their own table. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` makes the owner also subject to RLS. Required if the application role owns the tables (common in managed PostgreSQL where the app role creates schemas).
11. **Application role discipline for RLS:**
    - Create an `app_user` role with `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`.
    - Grant only the minimum required table privileges (`SELECT`, `INSERT`, `UPDATE`, `DELETE` — rarely `TRUNCATE`).
    - Use a separate `app_migration` role (also without SUPERUSER) for DDL.
    - Use a separate `app_reporting` role with a policy-level exception for cross-tenant analytics, never BYPASSRLS.
12. **RLS + schema-per-tenant defense in depth:**
    - Use schema-per-tenant as the primary isolation (structural).
    - ALSO enable RLS on tables that carry `tenant_id` (e.g., shared hypertables like `sensor_metrics`, partitioned `messages`).
    - The RLS policy becomes a second fence: even if `search_path` was wrong, the `tenant_id` check still filters.
    - Cost: a few microseconds per row for the policy predicate.
13. **`current_setting('name', true)`** returns NULL for a missing setting instead of raising. Combined with `NULLIF(..., '')::uuid` this gives safe-by-default policies: if the setting is missing, no rows match.
14. **Security Definer functions inside RLS policies** are dangerous — they can bypass the policy's own intent. Avoid.
15. **Views and RLS interaction:** PostgreSQL 15+ honors `CREATE VIEW ... WITH (security_invoker = true)` which makes views run with the querying user's privileges (and policies). Without this, views run with the view owner's privileges and may bypass RLS silently. Every view over an RLS-protected table MUST use `security_invoker = true` or the view owner must not have BYPASSRLS.
16. **Triggers and RLS:** triggers run as the user who fired them (unless SECURITY DEFINER). If a trigger modifies another RLS-protected table, the policy applies. If the trigger owner has BYPASSRLS, the trigger writes unconstrained — often used as an RLS escape hatch for audit logging, but must be audited carefully.
17. **RLS does not protect constraints.** A unique constraint on `email` spans all rows regardless of RLS; a user in tenant A cannot sign up with an email that already exists in tenant B. Workaround: include `tenant_id` in the unique: `UNIQUE (tenant_id, email)`.
18. **Connection pooling and RLS:** same rule as `search_path` — `SET LOCAL` inside the transaction, never session-level. PgBouncer transaction pooling is safe with `SET LOCAL` and catastrophic with `SET`.

## Security Concerns
- Application connection role with `BYPASSRLS` or `SUPERUSER` = CRITICAL (RLS policies are toothless).
- Session-level `SET app.current_tenant` or `SET search_path` under PgBouncer transaction pooling = CRITICAL (tenant leak across transactions).
- RLS policy not enforced on the table owner (no `FORCE ROW LEVEL SECURITY`) when the app role owns the table = CRITICAL.
- RLS policy using raw `current_setting('name')` (no second argument `true`) on an unset variable = MEDIUM (raises, better than silent leak) or HIGH if the missing-setting path returns empty string that coerces to a matching row.
- View over RLS-protected table without `security_invoker = true` (PostgreSQL 15+) = HIGH (view bypasses RLS).
- Trigger with SECURITY DEFINER writing to RLS-protected table = HIGH (escape hatch, audit required).
- Schema-per-tenant with no regex validation on schema name interpolation = CRITICAL (SQL injection + cross-tenant access).
- `tenant_id` nullable on an RLS-protected table = CRITICAL (NULL rows may match or not match depending on policy, typically leak).
- Missing `tenant_id` in the predicate of a unique constraint on a shared-schema RLS table = HIGH (cross-tenant uniqueness accidentally enforced).

## Performance Concerns
- RLS predicate on every row lookup = single-digit microseconds when the predicate is a simple equality against a leading index column. Compounded across millions of rows, this is still real cost; acceptable.
- RLS policy with a subquery / function call = HIGH — planner loses the ability to push down predicates.
- Shared-schema RLS without `tenant_id` as the leading index column = HIGH (every query does an index range scan then policy filter).
- Schema-per-tenant with > 10K schemas = HIGH (catalog bloat, `pg_class` lookup per query).
- Combining RLS on hot tables (hypertables) without careful index review = MEDIUM (extra predicate per row).

## Architectural Implications for database-reviewer

- Aqua-saas uses schema-per-tenant as primary isolation. The reviewer must verify:
  - Every tenant schema matches `^tenant_[a-f0-9]{16}$`.
  - Schema name interpolation is always regex-validated.
  - `SET LOCAL search_path` is used inside every transaction (never session-level).
  - No cross-schema foreign keys between two tenant schemas.
- For shared-schema tables (hypertables, partitioned tables in `public` / module schema), RLS should be enabled as defense in depth.
- The application connection role MUST NOT have SUPERUSER or BYPASSRLS. Periodic audit:
  ```sql
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolcanlogin = true;
  ```
  Any app role with `rolbypassrls = true` or `rolsuper = true` = CRITICAL.
- RLS policies must use `current_setting('app.current_tenant', true)` (second arg for missing-is-NULL behavior) and NULLIF/cast safely.
- Views over RLS tables must use `security_invoker = true` on PostgreSQL 15+.
- Unique constraints on shared-schema RLS tables MUST include `tenant_id`.
- Triggers with SECURITY DEFINER writing to RLS-protected tables must be audit-logged.
- Cross-tenant analytics must use a separate role with policy-level exception, never BYPASSRLS.

## Domain Rule Additions for database-reviewer

Add to `## Domain Rules → Row-Level Integrity / Multi-Tenancy`:

- Application connection role MUST NOT have `SUPERUSER` or `BYPASSRLS` attribute. Any app role with either = CRITICAL. Audit via `pg_roles` on every schema change.
- Schema-per-tenant is the primary aqua-saas isolation model. Schema name MUST match `TENANT_SCHEMA_REGEX` (`^tenant_[a-f0-9]{16}$`) and interpolation MUST be regex-validated before use. Unvalidated = CRITICAL.
- `SET LOCAL search_path` / `SET LOCAL app.current_tenant` inside the transaction is the only safe pattern under PgBouncer transaction pooling. Session-level `SET` = CRITICAL (tenant leak).
- Shared-schema tables (`sensor_metrics`, partitioned `messages`, `compliance_audit_log`) SHOULD have RLS enabled as defense in depth with `tenant_id = current_setting('app.current_tenant', true)::uuid` policies.
- `ALTER TABLE ... FORCE ROW LEVEL SECURITY` MUST be set when the app role owns the table (typical in managed PostgreSQL). Missing = CRITICAL (owner bypasses policies).
- RLS policies using `current_setting('name')` without the second `true` argument = MEDIUM (raises on unset, surfaces bug but noisy); without NULLIF on the empty-string path = HIGH.
- Views over RLS-protected tables on PostgreSQL 15+ MUST be declared `WITH (security_invoker = true)`. Missing = HIGH.
- Triggers with `SECURITY DEFINER` writing to RLS-protected tables = HIGH until audited and justified.
- Unique constraints on shared-schema RLS tables MUST include `tenant_id` (e.g., `UNIQUE (tenant_id, email)`). Naive `UNIQUE (email)` = CRITICAL (cross-tenant collision).
- `tenant_id` column on RLS-protected tables MUST be `NOT NULL`. Nullable = CRITICAL (NULL policy behavior).
- Cross-tenant reporting MUST use a dedicated role with a policy-level exception (`CREATE POLICY ... TO reporting_role USING (true)`), NOT `BYPASSRLS`. BYPASSRLS on the reporting role = CRITICAL (no audit trail of cross-tenant access).
- Cross-schema FK between two `tenant_{id}` schemas = CRITICAL (tenant isolation breach).
