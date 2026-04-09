# Independent Validation Report: Orchestrator HIGH Findings — Tenant Trust Chain

**Date:** 2026-04-09
**Agent:** security-reviewer
**Scope:** Validate HIGH-001, HIGH-002, HIGH-003 from orchestrator report

---

## SEC-HIGH-001: TenantContextMiddleware accepts X-Tenant-Id header from untrusted sources

**Verdict: PARTIALLY CONFIRMED — Downgrade to MEDIUM**

**File:** `libs/backend-common/src/middleware/tenant-context.middleware.ts`, lines 95-110

The `extractTenantContext()` method has a priority order:
1. `X-Tenant-Id` header (line 97-99) — HIGHEST priority, no validation
2. `req.user.tenantId` from JWT (line 103-104)
3. `tenantId` query parameter (line 108-110)
4. Subdomain extraction (line 114+)

The header source wins over the JWT source. An attacker who sends `X-Tenant-Id: <any-string>` will have that value assigned to `req.tenantId` at line 85, before any guard runs.

**Gateway middleware chain** (`apps/gateway-api/src/app.module.ts`, lines 670-691):
```
MetricsMiddleware -> CorrelationIdMiddleware -> RequestContextMiddleware ->
StripInternalHeadersMiddleware -> CsrfMiddleware -> JwtMiddleware ->
UserContextMiddleware -> TenantContextMiddleware -> RequestLoggingMiddleware
```

**CRITICAL:** `StripInternalHeadersMiddleware` (line 684) only strips `x-user-payload`, `x-user-id`, `x-user-roles`. It does NOT strip `X-Tenant-Id`.

**Mitigating controls:**
1. **TenantIsolationGuard** (global APP_GUARD at line 612) compares `requestedTenantId` against `user.tenantId` from JWT. Cross-tenant access denied unless `platform_admin` / `super_admin`.
2. **TenantGuard** on downstream services uses `user?.tenantId` from JWT ONLY (line 158), ignoring headers entirely.

**Remaining risk:** Between middleware setting `req.tenantId` and guard overriding it, any code reading `req.tenantId` sees spoofed value. `RequestLoggingMiddleware` reads it → log poisoning.

**Severity: MEDIUM** — Data access protected by guards. Risk is log poisoning + defense-in-depth gap.

---

## SEC-HIGH-002: event-store-service reads X-Tenant-Id directly from request headers

**Verdict: CONFIRMED — Severity stays HIGH**

**File:** `apps/event-store-service/src/event-store/event-store.controller.ts`

Every endpoint uses `@Headers('x-tenant-id')`:
- Lines 62, 94, 114, 155, 177, 192, 213, 251, 268, 298, 323 (EventStoreController)
- Lines 59, 71, 87, 101, 115, 129, 143, 158, 174 (ProjectionsController)

**NO TenantGuard, NO JWT verification, NO RolesGuard** on these controllers.

**Mitigating control — InternalApiKeyGuard:**
- Global APP_GUARD (`app.module.ts`, line 79)
- Validates `X-Internal-Api-Key` via timing-safe comparison
- Production: fails closed if `INTERNAL_API_KEY` not set (lines 34-38)
- Development: allows all requests (line 41: `return true`)

**Network isolation:**
- Service NOT in any docker-compose file (not deployed)
- No nginx route, no port mapping
- Internal-only when deployed

**Residual risk:** With valid API key (compromised service), can read/write events for ANY tenant. The `validateTenantId()` (lines 353-368) only checks UUID format, not authorization.

**Severity: HIGH** — Architectural trust boundary violation. No JWT verification + header-only tenant ID + write access.

---

## SEC-HIGH-003: ALLOWED_BASE_DOMAINS fails open in production

**Verdict: CONFIRMED — Severity stays HIGH**

**File:** `libs/backend-common/src/middleware/tenant-context.middleware.ts`, lines 160-179

```typescript
if (!allowedDomainsEnv) {
  // If not configured in production, allow all (backward compatible)
  return true;  // <-- FAIL-OPEN
}
```

Line 168-170: Production + no env var = allow all. Comment says "backward compatible."

**Attack scenario:**
1. Attacker controls `<victim-tenant-uuid>.attacker.com` pointed at production IP
2. Middleware splits: subdomain = `<victim-uuid>`, baseDomain = `attacker.com`
3. UUID validation passes (line 129)
4. `isAllowedBaseDomain('attacker.com')` returns `true`
5. `req.tenantId = <victim-uuid>` with source `subdomain`

**Mitigating controls:**
1. Subdomain must be valid UUID v4
2. TenantGuard/TenantIsolationGuard overwrite with JWT value for authenticated routes
3. `@Public()` routes don't access tenant-scoped data

**Severity: HIGH** — Fail-open violates OWASP A05 Security Misconfiguration. Fix is trivial: `return false`.

---

## Summary

| Finding ID | Verdict | Reassessed Severity | Key Evidence |
|---|---|---|---|
| SEC-HIGH-001 | PARTIALLY CONFIRMED | **MEDIUM** ↓ | Header accepted at priority 1 but guards override before data access |
| SEC-HIGH-002 | CONFIRMED | **HIGH** | 20 endpoints, no JWT, header-only tenant ID, InternalApiKeyGuard only |
| SEC-HIGH-003 | CONFIRMED | **HIGH** | Line 170 `return true` in production, fail-open design |

## Recommendations

**SEC-HIGH-001:** Reorder to prefer JWT over header. Add `x-tenant-id` to `INTERNAL_HEADERS_TO_STRIP`.

**SEC-HIGH-002:** Add `TenantAuthorizationMiddleware` to validate X-Tenant-Id against calling service's authorized scope. Replace with signed tenant claim via `generateServiceIdentityHeaders`.

**SEC-HIGH-003:** Change line 170 to `return false`. Add `ALLOWED_BASE_DOMAINS` to required production env vars. Add startup warning/throw if unset in production.
