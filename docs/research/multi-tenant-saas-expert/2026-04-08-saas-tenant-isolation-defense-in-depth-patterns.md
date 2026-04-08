# Research: SaaS Tenant Isolation Defense-in-Depth Patterns

**Topic:** Five-layer tenant isolation (DB search_path + RLS, Redis namespacing, NATS subject scoping, cache keys, request-scoped guards) with CrossTenantProbe watchdog
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- AWS Well-Architected Framework — SaaS Lens, Tenant Isolation chapter: https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-isolation.html — "Crossing tenant boundaries is a significant and potentially unrecoverable event for a SaaS business."
- AWS Security Blog, "Security practices in AWS multi-tenant SaaS environments": https://aws.amazon.com/blogs/security/security-practices-in-aws-multi-tenant-saas-environments/ — layered isolation guidance.
- Microsoft Learn, "Architectural approaches for storage and data in multitenant solutions": https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data — schema-per-tenant, shared-schema + RLS, stamp patterns.
- Microsoft Learn, "Tenancy models for a multitenant solution": https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models — silo / pool / hybrid tradeoffs.
- Redis official blog, "Data Isolation in Multi-Tenant SaaS": https://redis.io/blog/data-isolation-multi-tenant-saas/ — Redis ACL key-pattern restriction per tenant, namespaced keyspace.
- postgresql.org docs — schemas, search_path, RLS policies, BYPASSRLS, FORCE ROW LEVEL SECURITY.
- NATS documentation — subject hierarchies, authorization (subject-scoped allow/deny per account).
- OWASP Cheat Sheet: Multi-Tenant Security.
- Aqua-saas codebase: `libs/backend-common/src/redis/tenant-redis.service.ts`, `libs/backend-common/src/guards/tenant.guard.ts`, `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`, `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts`, `libs/backend-common/src/database/rls/tenant-rls.service.ts`.

## Key Findings

1. **No single isolation layer is trustworthy in isolation.** AWS SaaS Lens and Microsoft Azure Architecture Center both frame tenant isolation as defense in depth: every layer must be independently wrong for a cross-tenant leak to occur. Any SaaS platform that relies on a single control (application-layer filter, RLS alone, schema-per-tenant alone) ships a single-fault tenant-leak path.
2. **Five canonical layers** for a NestJS / NATS / Redis / Postgres stack:
   - **L1 Database schema + search_path** — the primary physical fence. Tenant schemas `tenant_{16hex}` + transaction-scoped `SET LOCAL search_path`.
   - **L2 Row-Level Security (RLS)** — secondary fence even on schema-per-tenant tables that carry a `tenantId` column. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` + no BYPASSRLS + separate owner role.
   - **L3 Redis keyspace namespacing** — `tenant:{uuid}:...` prefix enforced by `TenantRedisService.forTenant()` which validates tenant UUID BEFORE constructing the key. No raw `RedisService` access in tenant code paths.
   - **L4 NATS subject scoping** — subjects prefixed `tenants.{tenantId}.domain.event` AND `tenantId` redundantly in the event payload. Consumers fail-closed on mismatch.
   - **L5 Request-scoped guards** — `TenantGuard` reads tenantId from JWT claim only (never headers/body/query), `X-Act-As-Tenant` UUID-validated and MFA-gated for SUPER_ADMIN only.
3. **Validation of dynamic identifiers is CRITICAL because Postgres identifiers cannot be parameter-bound.** Every schema name interpolated into SQL must be validated against a strict regex (`TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/`) BEFORE interpolation. Same rule for Redis key fragments, NATS subject fragments, and cache key fragments derived from tenant IDs.
4. **Active watchdog is mandatory.** AWS SaaS Lens: "detect tenant-boundary violations as early as possible." Aqua-saas implements `CrossTenantProbe` as a read-only scanner that samples tenant schemas for rows whose `tenant_id` column does not match the schema's owning tenant. Missing or disabled watchdog is a CRITICAL gap.
5. **Redis ACL per-tenant key-pattern restriction** is the defense-in-depth layer beyond namespacing — even if a bug constructs a wrong key, the Redis user's ACL blocks the read. Enterprise tier only.
6. **NATS subject scoping must be enforced at broker level, not application level.** NATS accounts or subject-scoped credentials prevent a compromised service from subscribing to `tenants.>`.

## Security Concerns

- **Schema name injection** — unvalidated interpolation of tenant schema names is both SQL injection and a tenant leak, the two highest-severity classes combined.
- **Pool contamination via session-level `SET search_path`** — a single bare `SET search_path = public` in any code path contaminates the pooled connection for the next tenant's transaction under PgBouncer transaction pooling. Root cause of the 2026-04-07 farm-service incident.
- **Owner bypass of RLS** — by default the Postgres table owner bypasses RLS. If the application role owns the table, RLS is silently disabled. Mitigation: `ALTER TABLE ... FORCE ROW LEVEL SECURITY` or a dedicated non-owner application role.
- **BYPASSRLS attribute on the application role** — silent bypass, no alert. Must be periodically audited via `pg_roles.rolbypassrls`.
- **Cache key collision** — any `RedisService.set(key, ...)` without a tenant prefix is a cross-tenant leak. `getRepository()` equivalent for Redis.
- **NATS wildcard subscription leak** — a consumer subscribing `tenants.>` receives every tenant's events. Only legitimate for platform-wide telemetry with explicit audit.
- **Request-body tenantId** — accepting `tenantId` from request body or query parameters allows trivial horizontal escalation. CRITICAL regardless of role.

## Performance Concerns

- **Schema-per-tenant scales to ~10K schemas** before `pg_class` catalog bloat degrades plan time. Hybrid pooled-schema + RLS for tiers beyond.
- **RLS policy evaluation is per-row** — naive policies with subqueries cause plan-time blowup. Keep policies to `USING (tenantId = current_setting('app.current_tenant')::uuid)`.
- **CrossTenantProbe sampling** — full-coverage scans on large tenant counts require rotating-window design; `ORDER BY RANDOM() LIMIT 10` misses rare leaks.
- **TenantRedisService prefix overhead** — negligible (~1 byte per key on average) compared to the isolation guarantee.

## Architectural Implications for multi-tenant-saas-expert reviews

- Enforce the five-layer model as the canonical mental checklist for every review touching tenant data.
- Reject any PR that introduces a raw `getRepository()`, raw `RedisService` without `TenantRedisService.forTenant()`, or NATS `subscribe()` without a tenant-scoped subject.
- Require `TENANT_SCHEMA_REGEX` validation anywhere a schema name is interpolated; raw string interpolation into SQL = CRITICAL.
- Require `CrossTenantProbe` to be scheduled and fail-closed on CRITICAL findings. Any disablement = CRITICAL.
- Require `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every tenant-owned table, OR a separate non-owner application role.
- Require the application DB role to have `rolsuper = false` AND `rolbypassrls = false` — verifiable at boot.
- Delegate migration DELTA review to data-expert but own the cross-cutting isolation rule set.

## Domain Rule Additions for multi-tenant-saas-expert

- **L1 Database:** tenant schema name validated against `TENANT_SCHEMA_REGEX` before interpolation; `SET LOCAL search_path` inside transactions only; raw `getRepository()` on tenant entities = CRITICAL; bare session-level `SET search_path` = CRITICAL (2026-04-07 incident class).
- **L2 RLS:** application role `rolsuper = false`, `rolbypassrls = false`; every tenant-owned table has `FORCE ROW LEVEL SECURITY` OR the application connects as a non-owner role; policies use `current_setting('app.current_tenant', true)::uuid`.
- **L3 Redis:** every Redis access in tenant code paths goes through `TenantRedisService.forTenant(redis, tenantId)` which validates tenantId UUID format; direct `RedisService` in tenant code = CRITICAL.
- **L4 NATS:** subjects scoped `tenants.{tenantId}.{domain}.{event}`; consumers reject events where payload `tenantId` does not match subject tenant fragment; wildcard subscription `tenants.>` reserved for platform telemetry with explicit SUPER_ADMIN audit.
- **L5 Guards:** `TenantGuard` reads tenantId from JWT claim only; `X-Act-As-Tenant` UUID-validated, SUPER_ADMIN only, MFA-gated, dual-identity audit via `recordAwait()`.
- **Watchdog:** `CrossTenantProbe` scheduled runner with fail-closed alert pipeline on CRITICAL; missing or disabled = CRITICAL.
- **Rotating-window coverage:** once tenant count > 100, passive probe `ORDER BY RANDOM() LIMIT 10` must migrate to rotating full-coverage scans; recommend active write-one / read-other canary probe as the enhancement.
