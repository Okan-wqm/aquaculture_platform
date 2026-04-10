# Auth & Security Expert Review
**Date:** 2026-04-10
**Scope:** `apps/auth-service/**`, `apps/gateway-api/**`, `libs/backend-common/src/auth/**`, `libs/backend-common/src/guards/**`, `libs/backend-common/src/security/**`, `libs/backend-common/src/middleware/**`, `libs/backend-common/src/audit/**`

## Deployment Decision
**BLOCK**

No CRITICAL auth issue surfaced, but one HIGH production-blocking failure and one MEDIUM trust-boundary regression are present.

## Findings

### HIGH-001: Gateway production tenant resolution fails closed because the lookup dependency is never registered
**Files:** [`/var/aqua-saas/apps/gateway-api/src/middleware/tenant-context.middleware.ts:423`](/var/aqua-saas/apps/gateway-api/src/middleware/tenant-context.middleware.ts#L423) and [`/var/aqua-saas/apps/gateway-api/src/app.module.ts:560`](/var/aqua-saas/apps/gateway-api/src/app.module.ts#L560)

`TenantContextMiddleware` requires `TenantLookupService` in production and returns `null` when it is missing. The gateway `AppModule` provider list registers guards, stores, and interceptors, but not `TenantLookupService`, so the production path logs the missing provider and then throws `TENANT_NOT_FOUND` / `TENANT_RESOLUTION_FAILED` for non-public requests.

This is a deployment blocker because authenticated and tenant-scoped traffic cannot resolve tenant context in production.

Remediation: register `TenantLookupService` in the gateway module and make the production tenant-resolution contract explicit. If the service is intentionally optional, the middleware should not hard-fail every non-public request when it is absent.

### MEDIUM-001: `validateToken()` is a token oracle and bypasses the platform JWT verification contract
**Files:** [`/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts:737`](/var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts#L737), [`/var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:268`](/var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts#L268), [`/var/aqua-saas/libs/backend-common/src/index.ts:21`](/var/aqua-saas/libs/backend-common/src/index.ts#L21), [`/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts:17`](/var/aqua-saas/libs/backend-common/src/auth/jwt-verification.utils.ts#L17)

`AuthResolver.validateToken()` exposes `AuthenticationService.validateToken()` behind `@SkipTenantGuard()`. That helper calls `jwtService.verifyAsync(token)` with no shared `getJwtVerifyOptions()` and no `enforceAccessTokenType()`, so it is looser than the rest of the platform contract. The endpoint returns `userId`, `tenantId`, `role`, and `expiresAt` for any JWT that passes the raw verify call, which makes it a token-validity oracle and a weaker trust boundary than the gateway and shared backend-common guards.

Remediation: move this logic to the shared JWT verification helper, enforce access-token type before returning payload data, and restrict or remove the endpoint if it is only needed for internal diagnostics.

## Cross-Domain Dependencies

| From | To | Issue | Status |
|---|---|---|---|
| `gateway-api` tenant context middleware | gateway module wiring / tenant lookup provider | Production tenant resolution depends on a provider that is not registered | Open |
| `auth-service` token validation resolver | `libs/backend-common` JWT contract | Validation path bypasses shared issuer/audience/type enforcement | Open |

## Summary

The repo is mostly aligned on JWT hardening, but the gateway has a production wiring gap that breaks tenant-scoped access, and the auth-service still exposes a weaker token-validation path than the shared platform contract.
