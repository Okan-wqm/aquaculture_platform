# Research: Cross-Tenant Access Control and X-Act-As-Tenant Header

**Topic:** Safe X-Act-As-Tenant header implementation, UUID validation, audit with `recordAwait`, role hierarchy enforcement
**Date:** 2026-04-08
**Agent:** admin-expert

## Sources

- [Multi Tenant Security Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
- [Authorization Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [Architectural Considerations for Identity in a Multitenant Solution — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/identity)
- [The Developer's Guide to SaaS Multi-Tenant Architecture — WorkOS](https://workos.com/blog/developers-guide-saas-multi-tenant-architecture)
- [How to Choose the Right Authorization Model for Your Multi-Tenant SaaS Application — Auth0 Blog](https://auth0.com/blog/how-to-choose-the-right-authorization-model-for-your-multi-tenant-saas-application/)
- [NIST SP 800-53 Rev 5 (AC-3, AC-6, AU-2, AU-3, AU-12)](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf)
- [NIST SP 800-162 Attribute-Based Access Control](https://csrc.nist.gov/publications/detail/sp/800-162/final)

## Key Findings

### 1. Never trust a tenant ID from a client header in isolation
OWASP's Multi Tenant Security cheat sheet and Microsoft's guidance both state plainly: tenant IDs from client headers or query parameters must never be trusted as the sole authorization input. The `X-Act-As-Tenant` header is a *request* for elevated cross-tenant scope; the authorization decision must happen server-side based on:
1. The JWT subject's role (SUPER_ADMIN gate).
2. Active impersonation session presence/absence (to avoid conflating impersonation and act-as).
3. Tenant UUID validation against the canonical tenants registry.
4. Rate-limiting per real user (detect enumeration).

### 2. UUID validation is not just format checking
OWASP Authorization cheat sheet emphasizes validating the structure AND existence of the target. For `X-Act-As-Tenant`:
- Regex-validate as a canonical UUID v4 (rejects malformed strings, SQL injection attempts, and path traversal).
- Lookup the UUID in the `tenants` registry; reject if not found or if `status IN ('PURGED')`.
- Reject if the tenant is `ARCHIVED` unless the caller has an explicit "archive access" role beyond SUPER_ADMIN.
- Reject if the tenant is `SUSPENDED` unless the operation is a lifecycle operation (reactivation, billing fix). Read queries against suspended tenants should be allowed for support; writes should require justification.

### 3. The header grants tenant scope, NOT user identity
This is the fundamental distinction the platform must not blur:
- `X-Act-As-Tenant`: "I am SUPER_ADMIN acting with tenant X's data scope. I remain me. My actions are attributed to me."
- Impersonation: "I am SUPER_ADMIN, but downstream code should behave as if I am user Y in tenant X." Requires MFA step-up, session entity, and dual-identity audit.

Conflating these is the single most common multi-tenant SaaS security bug. Reviewers must verify that `X-Act-As-Tenant` code paths do NOT rewrite the authenticated principal or the audit `actor` field.

### 4. Role hierarchy enforcement rules
From the platform's stated hierarchy `SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER`, the cross-tenant semantics are:
- **SUPER_ADMIN** is the only role allowed to use `X-Act-As-Tenant`. Any other role presenting the header gets a 403 + audit row.
- **TENANT_ADMIN** operations are constrained to the tenant ID in the JWT. Any attempt to pass `X-Act-As-Tenant` with a different tenant ID must return 403 without revealing whether that tenant exists (avoid tenant enumeration).
- **MODULE_MANAGER** and **MODULE_USER** never have cross-tenant scope under any circumstances; the header, if present, is ignored for them and logged as a security event.

### 5. Audit every cross-tenant action (append-only, `recordAwait` pattern)
NIST SP 800-53 AU-2/AU-3/AU-12 and OWASP Logging cheat sheet converge on:
- Audit write must happen BEFORE the action completes (so a crash mid-operation still leaves evidence).
- Use the `recordAwait` pattern: the audit append is awaited in the same request lifecycle and its failure blocks the action. Fire-and-forget audit writes are unacceptable for cross-tenant operations.
- Audit fields for every `X-Act-As-Tenant` request:
  - `actor_user_id` (the SUPER_ADMIN — always the JWT subject, never rewritten).
  - `acted_on_tenant_id` (from the validated header).
  - `actor_home_tenant_id` (the SUPER_ADMIN's own tenant, for auditors to see the cross-tenant hop).
  - `endpoint`, `http_method`, `resource_type`, `resource_id`.
  - `justification` (required for write operations).
  - `ip_address`, `user_agent`, `request_id`.
  - `timestamp` (server-side, UTC).
  - `result` (success/denied/error) and `error_detail`.

### 6. Tenant enumeration is a real threat
OWASP Multi Tenant Security cheat sheet warns: differentiated error responses (404 vs 403) between "tenant does not exist" and "tenant exists but you can't access it" let attackers enumerate tenant IDs. For non-SUPER_ADMIN callers, any mismatch on `X-Act-As-Tenant` must return the same 403 regardless of whether the tenant exists.

### 7. Rate-limit + anomaly detection on the header
An attacker with a stolen SUPER_ADMIN token could iterate `X-Act-As-Tenant` across every UUID in the system for exfiltration. Defenses:
- Rate-limit cross-tenant requests per SUPER_ADMIN: e.g., max 10 distinct tenant IDs per minute, configurable.
- Alert when a single SUPER_ADMIN touches more than N tenants in a session.
- CAE-style continuous evaluation: if anomaly detection fires, invalidate the admin's session immediately.

### 8. Tenant context propagation boundaries
When `X-Act-As-Tenant` sets tenant scope, the scope MUST propagate correctly through:
- NestJS request context (CLS / AsyncLocalStorage).
- Database connection scoping (`SET search_path TO '<tenant_schema>'`).
- Outgoing NATS events (tenant_id in event payload).
- Log correlation (tenant_id in structured logs).

And it MUST NOT leak into:
- Background jobs initiated by the request (they must inherit an explicit tenant scope, not the request-level CLS).
- Response caching keys (cached admin responses keyed without tenant ID would cross-tenant-leak on cache hit).
- Prometheus metric labels (using raw tenant UUIDs as labels causes high-cardinality blowup).

## Security Concerns

- **Silent principal rewrite:** if any middleware rewrites `req.user = tenantAdminOf(actAsTenantId)` upon seeing the header, the SUPER_ADMIN's identity vanishes from the audit trail. The header must set a *separate* `req.tenantScope`, never touch `req.user`.
- **Cached permission checks:** if RBAC decisions are cached per user, adding `X-Act-As-Tenant` without invalidating the cache can grant stale permissions. Cache key must include the tenant scope.
- **Background jobs inherit wrong scope:** queueing a job during a cross-tenant request must serialize the tenant scope into the job payload; reading it from CLS in the worker is a cross-tenant leak waiting to happen.
- **Tenant scope leaking to another tenant's data:** if the search_path is set but a query hard-codes `public.*` or another schema prefix, the scope is bypassed. Recent farm-service fixes show this class of bug; admin tools need the same diligence.
- **Audit write failures:** if `recordAwait` is actually `record` (fire and forget), an audit backend outage silently drops cross-tenant evidence. Audit write failures on cross-tenant operations must fail the request with 500 — preferring data safety over availability.
- **JWT replay across tenants:** if a SUPER_ADMIN JWT does not encode the currently active tenant scope, a replay of one request's body with a different `X-Act-As-Tenant` header is equivalent to switching tenants silently. Each cross-tenant response should be bound (signed) to the tenant that served it, enabling client-side detection.
- **Non-SUPER_ADMIN bypass:** if the header check is a simple `if (user.role === 'SUPER_ADMIN')` and the role field is parsed from a mutable claim, a privilege escalation is possible. Role must be read from the JWT's signed claims after full verification.

## Performance Concerns

- Tenant registry lookup on every request is hot-path. Cache the `tenant_id → status` mapping in-memory with short TTL (e.g., 30s) and invalidate on lifecycle events.
- Audit writes on the critical path add latency. Batch audit writes into the outbox table (the platform's existing outbox is ideal) rather than direct inserts that share the request's DB transaction.
- Rate-limit counters per SUPER_ADMIN should live in Redis (or in-process with eviction) — not the primary DB — to avoid hot-key contention.

## Architectural Implications for admin-expert reviews

When reviewing any controller/guard/middleware that honors `X-Act-As-Tenant`, enforce:
1. Header is parsed by a dedicated guard, not in individual controllers.
2. Guard verifies caller is SUPER_ADMIN via JWT-signed claim; no ambient role lookup.
3. Guard regex-validates the header value as a canonical UUID, then does a registry lookup to confirm existence and non-terminal status.
4. Guard writes a `CrossTenantAccess` audit row via an awaited, transactional append (the `recordAwait` pattern) BEFORE the controller runs.
5. Guard sets a distinct `req.tenantScope` field; it NEVER rewrites `req.user`.
6. Non-SUPER_ADMIN callers presenting the header get a 403 and a security-event audit row; the response does not reveal whether the tenant exists.
7. TENANT_ADMIN controllers never read `X-Act-As-Tenant`; they derive the tenant from the JWT.
8. Background job enqueue inside a cross-tenant request must serialize the tenant scope into the job payload.
9. Response cache keys include the tenant scope; cache misses are mandatory across tenant boundaries.
10. Rate-limiter enforces a per-SUPER_ADMIN cap on distinct `X-Act-As-Tenant` values per minute.
11. Prometheus metrics label with `tenant_bucket` (hash bucket), not raw tenant UUID.
12. The list of all cross-tenant accesses is exposable via an admin audit endpoint filterable by actor, tenant, time window, and endpoint.

## Domain Rule Additions for admin-expert

- Only SUPER_ADMIN JWTs may present `X-Act-As-Tenant`; any other role presenting it MUST receive a 403 and emit a security audit row.
- `X-Act-As-Tenant` header parsing MUST live in a dedicated guard/middleware, never inline in controllers.
- Header values MUST be regex-validated as canonical UUIDs AND looked up in the tenants registry; non-existent or PURGED tenants are 403 (not 404, to prevent enumeration).
- `X-Act-As-Tenant` MUST set a distinct `req.tenantScope` field; rewriting `req.user` or `req.principal` based on the header is a CRITICAL finding.
- Cross-tenant audit writes MUST use the awaited `recordAwait` pattern; a failed audit write MUST fail the request (no fire-and-forget).
- Audit rows for cross-tenant actions MUST include: actor_user_id, actor_home_tenant_id, acted_on_tenant_id, endpoint, method, resource_type, resource_id, justification (for writes), ip, user_agent, request_id, result.
- TENANT_ADMIN controllers MUST derive tenant ID from the JWT only; reading `X-Act-As-Tenant` from a TENANT_ADMIN request is a CRITICAL finding.
- Background jobs enqueued during a cross-tenant request MUST serialize tenant scope into the job payload; reading it from CLS in a worker is a CRITICAL finding.
- Rate-limit cross-tenant requests per SUPER_ADMIN per minute; alert when a single SUPER_ADMIN touches more than N distinct tenants in a session.
- Response caches and Prometheus labels MUST NOT use raw tenant UUIDs that would enable cross-tenant cache hits or high-cardinality metric blowup.
- Tenant enumeration via differentiated error responses is a HIGH finding; non-SUPER_ADMIN responses MUST be identical whether the tenant exists or not.
