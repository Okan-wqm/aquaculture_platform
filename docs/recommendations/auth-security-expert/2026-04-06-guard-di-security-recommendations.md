# Guard DI Security -- Architectural Recommendations

**Date:** 2026-04-06
**Author:** Auth & Security Expert
**Related Review:** `docs/reviews/auth-security-expert/2026-04-06-guard-di-security-audit.md`
**Priority:** HIGH -- implement this sprint

---

## 1. IMMEDIATE: Fix backend-common Guard @Inject() Decorators

### Why This Is the Correct Architectural Fix

The `@Inject()` decorator calls `Reflect.defineMetadata('self:paramtypes', ...)` at **decoration time** (when the module is loaded). This is fundamentally different from `design:paramtypes` which is emitted by tsc's `__metadata()` helper at **compile time** via tslib.

The distinction matters: `@Inject()` metadata survives any build pipeline change because it is set by runtime JavaScript code, not by compiler-emitted metadata calls. It does not depend on:
- `emitDecoratorMetadata` tsconfig flag
- `importHelpers` / tslib
- NX cache correctness
- Bundler preservation of metadata

This is NOT a "patch" or "webpack workaround" -- it is the NestJS-designed mechanism for explicit DI token binding. The NestJS documentation recommends `@Inject()` for all providers where the DI token may differ from the TypeScript type.

### Files to Change

| File | Constructor Params Needing @Inject() |
|------|--------------------------------------|
| `libs/backend-common/src/guards/service-identity.guard.ts` | `configService: ConfigService` |
| `libs/backend-common/src/guards/tenant.guard.ts` | `reflector: Reflector` |
| `libs/backend-common/src/guards/roles.guard.ts` | `reflector: Reflector` |
| `libs/backend-common/src/security/throttler/throttler.guard.ts` | `reflector: Reflector`, `configService: ConfigService`, `rateLimiter: SlidingWindowStrategy` |

### Verification

After applying changes, run the NestJS test suite to confirm DI resolves correctly:

```bash
npm run test -- --projects=backend-common
```

Then build and verify in Docker:

```bash
npx nx build auth-service
docker build -f infrastructure/docker/Dockerfile.backend.simple --build-arg SERVICE_NAME=auth-service -t test-auth .
docker run --rm -e NODE_ENV=development -e JWT_SECRET=test-secret-at-least-32-chars-long -e ALLOW_DEV_JWT_SECRET=true -e DEV_JWT_SECRET=test-secret-at-least-32-chars-long test-auth
# Should NOT see "dependencies: [null, null, null]" errors
```

---

## 2. IMMEDIATE: Dockerfile reflect-metadata Pre-load

### Change

In `infrastructure/docker/Dockerfile.backend.simple`, line 59:

```dockerfile
CMD ["node", "-r", "reflect-metadata", "dist/main.js"]
```

### Why Not Just main.ts?

The Dockerfile CMD `-r` flag is a Node.js-level guarantee that runs before ANY application code, including module-level decorator evaluations. A `main.ts` import runs after all `import` statements at the top of the file are resolved, which means decorators in imported modules execute before `import 'reflect-metadata'` in main.ts actually runs (CommonJS `require` is synchronous, but import hoisting means side effects of imported modules run first).

The `-r` flag bypasses this ordering issue entirely.

---

## 3. THIS SPRINT: Fix Rollback Mechanism

### Current State

The rollback captures only the gateway image digest and fails on first deploy or after `docker compose down`.

### Recommended Architecture

Store image digests for ALL services BEFORE any deployment action:

```bash
# Capture phase (before docker compose pull)
ROLLBACK_FILE="/tmp/rollback-digests-$(date +%s).txt"
for svc in $(docker compose -f docker-compose.droplet.yml config --services); do
  DIGEST=$(docker inspect --format='{{.Image}}' "aqua-saas-${svc}-1" 2>/dev/null || echo "")
  if [ -n "$DIGEST" ]; then
    echo "${svc}=${DIGEST}" >> "$ROLLBACK_FILE"
  fi
done

# Rollback phase
if [ "$HEALTHY" != "true" ] && [ -f "$ROLLBACK_FILE" ]; then
  echo "::error::Rolling back all services..."
  while IFS='=' read -r svc digest; do
    CURRENT_IMAGE=$(docker compose -f docker-compose.droplet.yml config | \
      grep -A1 "${svc}:" | grep 'image:' | awk '{print $2}')
    if [ -n "$CURRENT_IMAGE" ] && [ -n "$digest" ]; then
      docker tag "$digest" "$CURRENT_IMAGE" 2>/dev/null || true
    fi
  done < "$ROLLBACK_FILE"
  docker compose -f docker-compose.droplet.yml up -d --no-build --remove-orphans
fi
```

### Health Check Enhancement

Check subgraph health, not just gateway:

```bash
# After gateway is healthy, check critical subgraphs
for svc_port in "auth-service:3001" "farm-service:3002"; do
  svc="${svc_port%%:*}"
  port="${svc_port##*:}"
  HTTP_CODE=$(curl -o /dev/null -w "%{http_code}" -s --max-time 5 \
    "http://localhost:${port}/health/live" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" != "200" ]; then
    echo "::warning::Subgraph ${svc} health check failed (HTTP ${HTTP_CODE})"
  fi
done
```

---

## 4. NEXT SPRINT: Standardize Guard DI Pattern

### Decision Record

All APP_GUARD registrations SHOULD use `useClass` with `@Inject()` on every non-optional constructor parameter. The `useFactory` pattern should be reserved for cases where:
- The DI token differs from the TypeScript type (e.g., `TOKEN_BLACKLIST` injection token)
- Conditional logic is needed to select the implementation
- Optional dependencies with custom fallback logic

### Guards That Already Comply

- gateway-api AuthGuard (useFactory -- correct, has TOKEN_BLACKLIST_STORE optional)
- gateway-api TenantIsolationGuard (useClass + @Inject -- correct)
- gateway-api RateLimitGuard (useClass + @Inject -- correct)
- gateway-api MutationRateLimitGuard (useClass, no deps -- correct)
- admin-api PlatformAdminGuard (useFactory -- correct, has explicit token deps)
- auth-service JwtAuthGuard (useFactory -- correct, has TOKEN_BLACKLIST optional)
- observability InternalApiGuard (useClass + @Inject -- correct)
- event-store InternalApiKeyGuard (useClass, no deps -- correct)

### Guards That Need @Inject() Added (backend-common source)

After fixing backend-common guards (Section 1), ALL consuming services automatically inherit the fix because they import from `@aquaculture/backend-common`. No changes needed in:
- farm-service, hr-service, sensor-service, billing-service
- alert-engine, config-service, notification-service
- messaging-service, hydroponics-service, ai-service

### billing-service JwtAuthGuard

This guard at `apps/billing-service/src/common/guards/jwt-auth.guard.ts` has:

```typescript
constructor(private reflector: Reflector) {}
```

Needs `@Inject(Reflector)`. This is a service-local guard, not from backend-common.

---

## 5. CROSS-DOMAIN NOTIFICATIONS

### For infra-expert

- The Dockerfile CMD change (`-r reflect-metadata`) requires all Docker images to be rebuilt
- The rollback mechanism rewrite should be coordinated with deploy workflow changes

### For all domain experts

- The `@Inject()` changes in backend-common affect all services that import these guards
- No API or behavior changes -- purely DI metadata hardening
- All services should be retested after the change

### For orchestrator

- If the root cause investigation (infra-expert task) identifies NX cache staleness as the issue, a full cache bust (`NX_SKIP_NX_CACHE=true`) should be done for the next deploy
- The `@Inject()` fix and the root cause fix are complementary, not alternatives
