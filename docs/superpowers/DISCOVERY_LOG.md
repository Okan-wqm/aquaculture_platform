# Gateway Security Discovery Log

## Agent 4: Gateway Security Architect
Date: 2026-03-22

### MED — TenantContextInterceptor accepts tenantId from query parameter
**File:** `apps/gateway-api/src/interceptors/tenant-context.interceptor.ts:199`
**Issue:** `extractTenantId()` accepts tenantId from query parameters (Priority 3) and path parameters (Priority 4) without extra validation. An attacker could supply `?tenantId=<victim>` on public-ish endpoints. The JWT tenantId (Priority 2) should always take precedence and query/path extraction should be restricted to webhook endpoints only.
**Severity:** MED

### LOW — InMemoryRateLimitStore cleanup interval not .unref()'d
**File:** `apps/gateway-api/src/guards/rate-limit.guard.ts:89`
**Issue:** The `setInterval` for cleanup in `InMemoryRateLimitStore` does not call `.unref()`, which can prevent Node.js from shutting down gracefully in tests and one-shot scripts. The `destroy()` method is only called from `RateLimitGuard.onModuleDestroy`.
**Severity:** LOW

### LOW — TenantContextInterceptor cache has no size bound
**File:** `apps/gateway-api/src/interceptors/tenant-context.interceptor.ts:105-106`
**Issue:** `tenantCache` grows unbounded — cleanup runs on each cache miss but only prunes by time. A system with many ephemeral tenants could accumulate entries indefinitely. Consider adding a max size with LRU eviction.
**Severity:** LOW

### MED — NATS bridge emoji in production log
**File:** `apps/gateway-api/src/websocket/nats-bridge.service.ts:100`
**Issue:** Logger uses emoji character in production warning about TLS being disabled. This can cause encoding issues in structured log aggregators (Datadog, ELK). Replace with plain text marker like `[SECURITY]`.
**Severity:** LOW (cosmetic)

### FIXED — Pre-existing test failure in global-exception.filter.spec.ts
**File:** `apps/gateway-api/src/filters/__tests__/global-exception.filter.spec.ts`
**Issue:** Test expected `error: 'Bad Request'` but HttpStatus[400] returns `'BAD_REQUEST'`. Fixed during this session.
**Severity:** LOW (test-only)

### FIXED — Pre-existing TS2532 in http-exception.filter.spec.ts
**File:** `apps/gateway-api/src/filters/__tests__/http-exception.filter.spec.ts:133`
**Issue:** `calls[calls.length - 1]` could be undefined under strict TypeScript. Fixed to use optional chaining.
**Severity:** LOW (test-only)
