# Research: Tenant Isolation — Database, Redis, NATS, Guards, IDOR Prevention

**Topic:** Defense-in-depth tenant isolation: DB search_path + RLS + explicit WHERE, Redis tenant prefix, NATS subject scoping, TenantGuard enforcement, IDOR prevention patterns
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP Top 10 — A01:2021 Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/)
- [OWASP API Security Top 10 — A1 Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)
- [OWASP API Security Top 10 — A5 Broken Function Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/)
- [OWASP Cheat Sheet — Multi-Tenant Web Application Architecture](https://cheatsheetseries.owasp.org/cheatsheets/Multi-Factor_Authentication_Cheat_Sheet.html)
- [PostgreSQL Documentation — Row Security Policies](https://www.postgresql.org/docs/15/ddl-rowsecurity.html)
- [PostgreSQL Documentation — search_path and Schema Security](https://www.postgresql.org/docs/15/ddl-schemas.html#DDL-SCHEMAS-PATH)
- [AWS — SaaS Tenant Isolation Strategies (Whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/saas-tenant-isolation-strategies.html)
- [Microsoft — Multi-Tenant SaaS Architecture Patterns](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/overview)
- [Google Cloud — Tenancy Models for SaaS Applications](https://cloud.google.com/architecture/saas-architecture-tenancy-models)
- [NATS — Subject-Based Authorization](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/authorization)
- [NATS — Multi-Tenancy with Accounts](https://docs.nats.io/running-a-nats-service/configuration/sys_accounts)
- [Redis — ACL and Key Patterns](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)
- [PortSwigger Web Security — Access Control Vulnerabilities (IDOR)](https://portswigger.net/web-security/access-control)
- [CWE-639 — Authorization Bypass Through User-Controlled Key](https://cwe.mitre.org/data/definitions/639.html)
- [CWE-284 — Improper Access Control](https://cwe.mitre.org/data/definitions/284.html)

## Key Findings

### 1. Defense in depth is mandatory — single isolation layer is a single point of failure
AWS SaaS Tenant Isolation Strategies stresses: every tenant data access MUST be protected by AT LEAST TWO independent isolation mechanisms, so a single missing check does not become a breach. For aqua-saas, the layered model:

| Layer | Mechanism | Failure mode if alone |
|-------|-----------|----------------------|
| 1 | TenantGuard at controller (verifies JWT.tenantId matches resource) | Can be bypassed by missing decorator |
| 2 | TypeORM `search_path` set per request | Can be bypassed by raw SQL or wrong schema name |
| 3 | Postgres RLS policy on every tenant table | Catches bypass of layers 1 and 2 |
| 4 | Explicit `WHERE tenant_id = $1` in service repository | Catches bypass of layer 3 if RLS disabled |
| 5 | CrossTenantProbe watchdog (continuous integration check) | Detects layer 4 misconfig in production |

A single missing layer = HIGH. Two missing layers on the same request path = CRITICAL.

### 2. PostgreSQL `search_path` is fast but fragile — RLS is the safety net
`search_path` schema isolation has the lowest overhead (no per-query filter), but every failure mode is silent and catastrophic:
- Forgetting to set `search_path` falls back to `public` (which may contain another tenant's data).
- A pooled connection inherits the previous tenant's `search_path` until reset.
- A migration that creates a table in `public` instead of the tenant schema becomes a permanent leak.
- Functions defined in `public` execute with the search_path of the caller — SET search_path inside the function is mandatory.

Mitigation discipline:
- **Re-assert `SET search_path = tenant_X, public` before EVERY query** in a pooled connection (the platform's recent farm-service runner fix).
- **Enable RLS on every tenant table** as defense in depth: `ALTER TABLE foo ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON foo USING (tenant_id = current_setting('app.current_tenant_id')::uuid);`
- **Application sets `app.current_tenant_id` per query** via `SET LOCAL` in the same transaction. RLS filters automatically.
- **CrossTenantProbe** writes a canary row in tenant A then attempts to read it from tenant B's session — if the read succeeds, isolation is broken and the probe alerts.

### 3. RLS is non-trivial — common pitfalls
PostgreSQL RLS is well-known but has subtle pitfalls:
- **Bypass by superuser:** `BYPASSRLS` attribute on the role disables RLS. Application user MUST NOT have `BYPASSRLS`. Migration user may have it but only for migration sessions.
- **Bypass by `SECURITY DEFINER` functions:** functions owned by a `BYPASSRLS` role bypass RLS unless explicit check is added.
- **Bypass by ROW EXCLUSIVE locks:** some lock acquisition paths may execute before policy check.
- **Subquery vs join performance:** RLS as a USING clause becomes part of every query plan; complex policies can balloon query cost. Use indexed `tenant_id` columns and benchmark.
- **Partition pruning:** RLS policies on partitioned tables must be defined per-partition or on the parent; the planner does not always prune correctly.

For aqua-saas: enable RLS on every tenant table, application user has NO `BYPASSRLS`, all `SECURITY DEFINER` functions explicitly check tenant context.

### 4. Redis tenant isolation requires prefix discipline AND key validation
Redis has no native multi-tenancy. Isolation is application-enforced via key prefix:
```
tenant:{uuid}:user:{userId}:session
tenant:{uuid}:cache:{key}
```
Failure modes:
- **Missing prefix:** key like `user:123:session` is global — every tenant reads/writes the same key.
- **Wrong prefix:** key like `tenant:wrong-uuid:foo` reads another tenant's data.
- **`KEYS *` or `SCAN match=*`:** enumerates all tenants in one call — use `SCAN match=tenant:{uuid}:*` only.
- **`FLUSHDB` / `FLUSHALL`:** wipes all tenants. Production application user MUST NOT have these commands (use Redis ACL).
- **Lua scripts:** can access any key — must be reviewed for tenant scope.
- **Pub/sub channels:** `PUBLISH` and `SUBSCRIBE` must follow the same prefix.

Mitigation: a `TenantRedisService` wrapper that:
- Validates `tenantId` is a UUID before constructing the key.
- Prepends `tenant:{uuid}:` to every key.
- Refuses unprefixed operations.
- `deletePattern()` is scoped to the tenant prefix.
- Uses Redis ACL to restrict the application user from `FLUSHDB`, `FLUSHALL`, `KEYS`, `CONFIG`, `DEBUG`, `SCRIPT FLUSH`.

### 5. NATS multi-tenancy: subject scoping AND account isolation
NATS provides two layers of isolation:
- **Subject scoping** (lightweight): subjects include `tenant.{uuid}.event-name`. Subscribers filter by subject. Subject-level ACLs in NATS config restrict who can publish/subscribe.
- **Accounts** (strong): NATS Accounts are completely isolated namespaces. Cross-account messaging requires explicit Export/Import declarations. For SaaS, one account per "tier" (or per very-large tenant) is a viable model.

For aqua-saas with 11 subgraphs sharing one NATS cluster, subject scoping is the practical choice:
- Every event subject MUST contain the tenant UUID.
- Every event payload MUST contain the tenant UUID (defense in depth — subscriber re-validates).
- Wildcard subscriptions (`tenant.*.event-name`) MUST be guarded — only services that legitimately need cross-tenant aggregation (e.g., billing, audit) may use wildcards, AND those services MUST explicitly handle tenant routing on receipt.
- JetStream consumers MUST scope filter subjects to a tenant prefix when consuming tenant-bound streams.

### 6. TenantGuard MUST trust ONLY the JWT — never headers or body
The single most common multi-tenant breach: trusting client-supplied tenant_id.
- `Authorization: Bearer <jwt>` — JWT.tenantId is signed by the issuer, cannot be forged by the client.
- `X-Tenant-Id: <uuid>` — client-supplied, MUST be ignored for regular users.
- Body field `{tenantId: "..."}` — client-supplied, MUST be ignored for regular users.
- URL parameter `/tenants/:tenantId/users` — client-supplied, MUST match `JWT.tenantId` (else 403).

Exception: SUPER_ADMIN impersonation via `X-Act-As-Tenant`. Even here:
- The header MUST be UUID-validated.
- An active ImpersonationSession MUST exist for the (admin, target_tenant) pair.
- Every request MUST be audited with dual-identity (real_admin + acted_tenant).
- Regular users (non-SUPER_ADMIN) sending `X-Act-As-Tenant` get 403 + security event.

### 7. IDOR — the silent killer
ID0R (Insecure Direct Object Reference, OWASP API #1) is the most-overlooked tenant breach. Pattern:
- `/orders/123` — does the order belong to the requesting user / tenant? Naive code: `SELECT * FROM orders WHERE id = $1` — leaks any order to anyone.
- Correct: `SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 AND (user_id = $3 OR EXISTS (...permission check...))`.
- Better: query through a tenant-scoped repository that automatically applies the tenant filter.
- Best: use unguessable IDs (UUID v4 or UUID v7) so brute-force enumeration is impossible — but unguessable IDs are NOT a substitute for the WHERE clause. They are defense in depth.

Mitigation pattern:
- Every `/resource/:id` route MUST verify ownership via guard or repository scope.
- IDs in URLs SHOULD be UUIDs (not auto-incrementing integers).
- Object-level authorization MUST be a centralized mechanism, not per-controller ad-hoc.

### 8. Tenant isolation findings are ALWAYS at least HIGH — usually CRITICAL
Per OWASP API #1 and the AWS SaaS isolation whitepaper: a tenant isolation failure is the worst-case multi-tenant SaaS bug. It is:
- Hard to detect (no error, no log entry, just wrong data returned).
- Hard to remediate after exploitation (the leaked data is gone).
- Impossible to undo trust damage (customers leave).

Severity rule:
- Demonstrable cross-tenant read OR write = CRITICAL.
- Code path that *could* cause cross-tenant access (missing guard, missing WHERE) = HIGH minimum, escalates to CRITICAL if no other layer catches it.
- Missing defense-in-depth layer (e.g., RLS not enabled even though search_path is correct) = HIGH.

## Security Concerns

- **Missing TenantGuard on a controller = CRITICAL** if no other layer catches it; HIGH if RLS or scoped repository catches it.
- **Raw SQL with interpolated schema name = CRITICAL** (search_path injection / DDL injection).
- **Raw SQL with interpolated tenant_id = CRITICAL** (SQL injection + IDOR).
- **`getRepository()` instead of `getScopedRepository()` = HIGH** (tenant-scoped methods bypassed).
- **Connection pool not re-asserting `search_path` per query = CRITICAL** (cross-tenant read on pooled connection).
- **Application Postgres user has `BYPASSRLS` = CRITICAL** (RLS disabled at the role level).
- **`SECURITY DEFINER` function without explicit tenant check = CRITICAL**.
- **Redis key without `tenant:{uuid}:` prefix = CRITICAL**.
- **Redis ACL allows `FLUSHDB` / `FLUSHALL` / `KEYS` / `CONFIG` to application user = HIGH**.
- **NATS subject without tenant UUID = HIGH** (CRITICAL if event payload also lacks tenant_id).
- **NATS wildcard subscription without explicit tenant routing on receipt = HIGH**.
- **`X-Tenant-Id` or body `tenantId` honored for non-SUPER_ADMIN = CRITICAL**.
- **`X-Act-As-Tenant` accepted without active ImpersonationSession = CRITICAL**.
- **Auto-incrementing integer IDs in URLs without object-level auth = HIGH** (IDOR enumeration).
- **Object-level authorization scattered across controllers (no central mechanism) = HIGH** (brittle, will be missed on next endpoint).
- **`CrossTenantProbe` watchdog not scheduled OR not alerting = HIGH** (no canary, breaches are silent).

## Performance Concerns

- RLS adds a USING clause to every query — `tenant_id` MUST be indexed (composite index leading with `tenant_id` for queries that filter by it).
- `search_path` reset per query is O(1) but visible in trace logs; trace volume can balloon.
- Redis SCAN with large `count` blocks the event loop; tenant-scoped pattern delete should use small batches.
- NATS wildcard subscriptions are N×M — N tenants × M subjects — can saturate consumer.
- `CrossTenantProbe` should be lightweight (single canary row, single read attempt) — not a full table scan.

## Architectural Implications for security-reviewer

When reviewing any change touching tenant data, the agent MUST verify ALL of:
1. TenantGuard decorator on the controller / resolver.
2. JWT.tenantId is the source of truth — no `X-Tenant-Id` / body `tenantId` accepted for regular users.
3. SUPER_ADMIN impersonation requires `X-Act-As-Tenant` UUID-validated AND active ImpersonationSession.
4. TypeORM `search_path` is set per request and re-asserted before every query in pooled connections.
5. Postgres RLS is enabled on every tenant table; application user has NO `BYPASSRLS`.
6. Repository is `getScopedRepository()` (or equivalent), not `getRepository()`.
7. Raw SQL (if any) uses parameterized schema names validated against `TENANT_SCHEMA_REGEX`.
8. Redis keys go through `TenantRedisService` with prefix discipline.
9. NATS event subjects AND payloads contain tenant_id; consumers re-validate.
10. Object-level authorization is enforced on every fetch-by-ID path via central mechanism.
11. `CrossTenantProbe` watchdog is scheduled and alerting.
12. Audit log captures every cross-tenant access attempt as a security event.

## Domain Rule Additions for security-reviewer

- Tenant isolation findings are ALWAYS at least HIGH; demonstrable cross-tenant access = CRITICAL.
- Defense in depth requires AT LEAST TWO of: TenantGuard, search_path, RLS, scoped repository, explicit WHERE. Single-layer isolation = HIGH (CRITICAL if that layer can be bypassed by another code path).
- Postgres application user with `BYPASSRLS` attribute = CRITICAL.
- `SECURITY DEFINER` function without explicit tenant context check = CRITICAL.
- Connection pool not re-asserting `search_path` before every query = CRITICAL.
- Raw SQL with interpolated schema name = CRITICAL (validate via `TENANT_SCHEMA_REGEX`).
- `getRepository()` instead of `getScopedRepository()` on tenant data = HIGH.
- Redis key without `tenant:{uuid}:` prefix on tenant data = CRITICAL.
- Redis ACL allowing `FLUSHDB`/`FLUSHALL`/`KEYS`/`CONFIG`/`DEBUG`/`SCRIPT FLUSH` to application user = HIGH.
- NATS subject without tenant UUID on tenant-bound events = HIGH (CRITICAL if payload also lacks).
- NATS wildcard subscription without explicit tenant routing on receipt = HIGH.
- `X-Tenant-Id` or body `tenantId` accepted for regular users = CRITICAL.
- `X-Act-As-Tenant` accepted without matching active ImpersonationSession = CRITICAL.
- Object-level authorization scattered across controllers (no central mechanism) = HIGH.
- `CrossTenantProbe` watchdog not scheduled / not alerting = HIGH.
- Auto-incrementing integer IDs in URLs without object-level auth = HIGH (IDOR).
