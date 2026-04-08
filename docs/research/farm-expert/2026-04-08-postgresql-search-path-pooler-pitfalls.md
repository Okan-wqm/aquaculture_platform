# Research: PostgreSQL `search_path` Multi-Tenant Isolation + Connection Pooler Pitfalls

**Topic:** Why the naive `SET search_path` approach breaks under PgBouncer transaction pooling and what the correct production pattern is.
**Date:** 2026-04-08
**Agent:** farm-expert

## Sources
- [Alibaba Cloud: Performance Impact of `set search_path`](https://www.alibabacloud.com/blog/postgresql-multi-tenant-usage-performance-impact-test-of-set-search-path_598627)
- [PgBouncer at Scale — 10K+ connections multi-tenant (DZone)](https://dzone.com/articles/database-connection-pooling-at-scale-pgbouncer-mul)
- [Supabase Supavisor — cloud-native multi-tenant pooler (GitHub)](https://github.com/supabase/supavisor)
- [AWS: Multi-tenant isolation with PostgreSQL RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- [Severalnines: Multitenancy Options for PostgreSQL](https://severalnines.com/blog/multitenancy-options-postgresql/)
- [Cloudflare: Performance isolation in multi-tenant Postgres](https://blog.cloudflare.com/performance-isolation-in-a-multi-tenant-database-environment/)
- [Azure Database for PostgreSQL multitenant guidance (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/postgresql)

## Key Findings

1. **Session-level `SET search_path` is catastrophically unsafe under transaction pooling.** PgBouncer's transaction pooling returns the server connection to the pool after COMMIT/ROLLBACK. The next transaction from a different tenant can land on the same server connection and inherit the previous tenant's `search_path` — a full cross-tenant data leak.
2. **The correct pattern is `SET LOCAL search_path`** inside every transaction. `SET LOCAL` scopes the change to the current transaction and is automatically reset on COMMIT/ROLLBACK. This is compatible with PgBouncer transaction pooling.
3. **Middleware injection** is the robust production pattern: every request acquires a tenant-scoped connection, issues `SET LOCAL search_path TO tenant_{id}, <service>, public` as the first statement of every transaction, then runs business queries.
4. **Schema name interpolation is an injection vector.** `SET LOCAL search_path TO ${userInput}` without validation is a direct SQL injection. Schema names MUST be validated against a strict regex (e.g. `^tenant_[a-f0-9]{16}$`) before interpolation.
5. **Row-Level Security (RLS)** is the alternative isolation model. RLS uses `current_setting('app.current_tenant')` as the tenant discriminator and policy-enforces tenant filtering at the row level. Safer than `search_path` because the isolation is structural.
6. **RLS bypass risks:** if the application connection role is `SUPERUSER` or has `BYPASSRLS`, RLS policies do not apply. RLS bypass via role privilege = CRITICAL.
7. **`SET LOCAL` does not propagate across `BEGIN` boundaries inside a single transaction block if the transaction is wrapped unusually.** Verify with the actual ORM's transaction semantics.
8. **Advisory locks at schema granularity** prevent concurrent schema modifications on the same tenant schema during migration sync.
9. **Cross-tenant probes** (a watchdog that periodically writes to one tenant and reads from another expecting an isolation failure) catch misconfigurations that would otherwise go unnoticed for months.

## Security Concerns
- Naive `SET search_path` at session level with transaction pooling = **CRITICAL** cross-tenant data leak.
- Schema name without regex validation before interpolation = **CRITICAL** SQL injection.
- Application connection role has `BYPASSRLS` or is `SUPERUSER` = **CRITICAL** — RLS policies are toothless.
- Missing cross-tenant probe watchdog = **HIGH** — no late-detection mechanism for isolation regressions.
- Schema creation without advisory lock = **HIGH** — race conditions during tenant provisioning.
- Missing audit log of `X-Act-As-Tenant` header use (SUPER_ADMIN impersonation) = **CRITICAL** compliance gap.

## Performance Concerns
- `SET LOCAL search_path` has measurable overhead per transaction (single-digit microseconds, but multiplied by high-concurrency workloads). Benchmark if p99 latency is critical.
- Schema count scales up to ~10K comfortably in PostgreSQL 15; beyond that, system catalog queries degrade. Plan for schema-per-tenant limits.
- `pg_catalog.pg_class` lookups per connection startup can become a bottleneck with many tenants. LRU caching of schema existence checks mitigates this.
- Connection pool size per tenant matters: too few starves tenants, too many exhausts PostgreSQL `max_connections`. Rule of thumb: `max_connections` ~= CPU cores × 4, pool per service proportional.

## Architectural Implications for farm-expert reviews
- Any raw SQL or ORM query where the schema name is interpolated without regex validation = CRITICAL.
- Any code path that sets `search_path` at session level (not `SET LOCAL`) under pooler = CRITICAL.
- Any query missing both `search_path` scoping AND explicit `WHERE tenantId = $1` = CRITICAL.
- Tenant-scoped connections without `AsyncLocalStorage` (Node.js) or equivalent context propagation = HIGH.
- Watchdog `CrossTenantProbe` missing from scheduled jobs = HIGH.
- `getScopedRepository()` / `getRepository()` mix-up: unscoped repository access to tenant tables = HIGH.

## Domain Rule Additions for farm-expert

Add to `## Domain Rules → Multi-Tenancy (Critical)`:
- Schema name interpolation in raw SQL MUST be validated against `TENANT_SCHEMA_REGEX` (`^tenant_[a-f0-9]{16}$`) before use. Unvalidated interpolation = CRITICAL (SQL injection + tenant leak).
- `search_path` MUST be set with `SET LOCAL` inside the transaction (compatible with pooler transaction pooling). Session-level `SET search_path` = CRITICAL under PgBouncer.
- Every repository access on tenant data MUST go through `getScopedRepository()`. Direct `getRepository()` on tenant entities = HIGH (may bypass tenant filter).
- Application connection role MUST NOT have `SUPERUSER` or `BYPASSRLS`. Privileged role = CRITICAL RLS bypass risk.
- Cross-tenant probe watchdog MUST run on schedule and fail-close on isolation breach. Missing probe = HIGH.
- SUPER_ADMIN impersonation via `X-Act-As-Tenant` header MUST be audit-logged with `recordAwait()` (guaranteed persistence before response). Async audit-log = CRITICAL compliance gap.
