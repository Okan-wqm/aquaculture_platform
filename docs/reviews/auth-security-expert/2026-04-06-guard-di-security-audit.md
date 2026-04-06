# Guard DI Security & Production Reliability Audit

**Date:** 2026-04-06
**Author:** Auth & Security Expert
**Scope:** All APP_GUARD registrations across 14 services, backend-common guard library, Dockerfile, deploy workflow rollback
**Prior Reviews:** None (first auth-security-expert review)

---

## EXECUTIVE SUMMARY

This audit assesses the security impact of NestJS Dependency Injection failures in Docker production. The investigation reveals a **mixed state**: some guards use `useFactory` (safe against DI metadata loss), while the majority use `useClass` (vulnerable). The critical question -- "does DI failure cause a crash or a bypass?" -- depends on whether the guard's constructor dependencies resolve. If `design:paramtypes` metadata is lost, NestJS receives `[null, null, null]` for constructor parameters of `useClass` guards, which causes `NestFactory.create()` to throw during module initialization. Combined with the `process.exit(1)` in every service's `bootstrap()`, this means **the service crashes rather than running unprotected**. This is the correct fail-closed behavior.

However, this crash-based safety net is **fragile and undocumented**. A single code change (e.g., making all constructor params `@Optional()`, or catching the DI error) could silently convert the crash into a bypass. The architectural solution must make guard DI resilient to metadata loss, not depend on crash behavior.

---

## FINDING SEC-G-01: NestJS DI Failure Mode Analysis

**Severity:** HIGH (not CRITICAL -- see rationale)
**Status:** Crash-safe TODAY, but fragile

### What Happens When `design:paramtypes` Metadata Is Lost

When tsc's `emitDecoratorMetadata: true` output is present, a constructor like:

```typescript
constructor(private reflector: Reflector, private configService: ConfigService) {}
```

emits `__metadata("design:paramtypes", [Reflector, ConfigService])` via tslib helpers. NestJS reads this via `Reflect.getMetadata('design:paramtypes', TargetClass)` to resolve constructor dependencies.

When this metadata is absent (webpack stripping, missing tslib, missing reflect-metadata), NestJS sees `undefined` or `[null, null]`. For `useClass` providers, NestJS calls `Injector.resolveConstructorParams()` which throws:

```
Nest can't resolve dependencies of the ServiceIdentityGuard (?, ?).
Please make sure that the argument at index [0] is available in the RootModule context.
```

This error is thrown during `NestFactory.create()` -- BEFORE the HTTP server starts listening. The bootstrap `try/catch` in every service catches this and calls `process.exit(1)`.

### Evidence: admin-api-service/src/main.ts (lines 23-39)

```typescript
try {
  app = await NestFactory.create(AppModule, { logger: structuredLogger });
} catch (err: unknown) {
  // ... log fatal ...
  process.exit(1);
}
```

### Why This Is HIGH, Not CRITICAL

The service crashes before it can serve any request. No endpoint is exposed without guards. The fail-closed behavior is correct.

**However**, this is HIGH because:
1. The crash gives NO indication of WHICH guard failed -- the NestJS error only says "argument at index [0]"
2. The rollback mechanism is broken (see SEC-G-07), so a crash means extended downtime
3. The safety depends on `process.exit(1)` being present and not caught -- a fragile invariant
4. If someone wraps `NestFactory.create()` in a retry loop, the guard-less state could transiently exist

---

## FINDING SEC-G-02: Complete Guard Registration Inventory

### Summary Table: All APP_GUARD Registrations

| Service | Guard | Pattern | Has @Inject() | DI-Safe? |
|---------|-------|---------|--------------|----------|
| **admin-api-service** | PlatformAdminGuard | `useFactory` | Yes (explicit) | YES |
| **auth-service** | ServiceIdentityGuard | `useClass` | No (relies on metadata) | NO |
| **auth-service** | JwtAuthGuard | `useFactory` | Yes (explicit) | YES |
| **auth-service** | TenantGuard | `useClass` | No (relies on metadata) | NO |
| **auth-service** | RolesGuard | `useClass` | No (relies on metadata) | NO |
| **gateway-api** | AuthGuard | `useFactory` | Yes (explicit) | YES |
| **gateway-api** | TenantIsolationGuard | `useClass` | Yes (@Inject on Reflector) | YES |
| **gateway-api** | RateLimitGuard | `useClass` | Yes (@Inject on all) | YES |
| **gateway-api** | MutationRateLimitGuard | `useClass` | N/A (no constructor deps) | YES |
| **farm-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **farm-service** | TenantGuard | `useClass` | No | NO |
| **farm-service** | RolesGuard | `useClass` | No | NO |
| **hr-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **hr-service** | TenantGuard | `useClass` | No | NO |
| **hr-service** | RolesGuard | `useClass` | No | NO |
| **observability-service** | InternalApiGuard | `useClass` | Yes (@Inject on all) | YES |
| **sensor-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **sensor-service** | TenantGuard | `useClass` | No | NO |
| **sensor-service** | RolesGuard | `useClass` | No | NO |
| **billing-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **billing-service** | JwtAuthGuard | `useClass` | No | NO |
| **billing-service** | TenantGuard | `useClass` | No | NO |
| **billing-service** | RolesGuard | `useClass` | No | NO |
| **alert-engine** | ServiceIdentityGuard | `useClass` | No | NO |
| **alert-engine** | TenantGuard | `useClass` | No | NO |
| **alert-engine** | RolesGuard | `useClass` | No | NO |
| **config-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **config-service** | TenantGuard | `useClass` | No | NO |
| **config-service** | RolesGuard | `useClass` | No | NO |
| **notification-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **notification-service** | TenantGuard | `useClass` | No | NO |
| **notification-service** | RolesGuard | `useClass` | No | NO |
| **messaging-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **messaging-service** | TenantGuard | `useClass` | No | NO |
| **messaging-service** | RolesGuard | `useClass` | No | NO |
| **messaging-service** | ThrottlerGuard | `useClass` | No | NO |
| **hydroponics-service** | ServiceIdentityGuard | `useClass` | No | NO |
| **hydroponics-service** | TenantGuard | `useClass` | No | NO |
| **hydroponics-service** | RolesGuard | `useClass` | No | NO |
| **hydroponics-service** | ThrottlerGuard | `useClass` | No | NO |
| **ai-service** | TenantGuard | `useClass` | No | NO |
| **ai-service** | RolesGuard | `useClass` | No | NO |
| **ai-service** | ThrottlerGuard | `useClass` | No | NO |
| **event-store-service** | InternalApiKeyGuard | `useClass` | N/A (no constructor deps) | YES |

### Statistics

- **Total APP_GUARD registrations:** 43
- **DI-Safe (useFactory or @Inject() or no deps):** 10
- **Vulnerable to metadata loss:** 33
- **Percentage vulnerable:** 76.7%

---

## FINDING SEC-G-03: backend-common Guards Constructor Analysis

**Severity:** HIGH
**Files:**
- `/var/aqua-saas/libs/backend-common/src/guards/service-identity.guard.ts`
- `/var/aqua-saas/libs/backend-common/src/guards/tenant.guard.ts`
- `/var/aqua-saas/libs/backend-common/src/guards/roles.guard.ts`

### ServiceIdentityGuard (line 40-43)

```typescript
constructor(
  private readonly configService: ConfigService,          // NO @Inject()
  @Optional() private readonly securityEventService?: SecurityEventService,
)
```

**Issue:** `configService` has no `@Inject()` decorator. Relies entirely on `design:paramtypes` metadata. If metadata is lost, NestJS cannot resolve `ConfigService` and the constructor receives `null`. The `@Optional()` on `securityEventService` is a red herring -- it is the non-optional `configService` that fails.

### TenantGuard (line 61-65)

```typescript
constructor(
  private reflector: Reflector,                           // NO @Inject()
  @Optional() private readonly auditLogService?: AuditLogService,
  @Optional() private readonly configService?: ConfigService,
)
```

**Issue:** `reflector` has no `@Inject()`. Both optional deps would resolve to `undefined` (acceptable), but `reflector` as `null` causes `this.reflector.getAllAndOverride()` to throw `TypeError: Cannot read properties of null` at request time -- AFTER the service starts. This is a **different failure mode**: the service starts but every request that hits TenantGuard crashes.

**CRITICAL NUANCE:** Because `reflector` does not have `@Inject()` AND is not `@Optional()`, NestJS will still throw during module init if metadata is lost (it tries to resolve the first param as token `null` which is not in the DI container). So this is also a crash-at-startup case. But if someone adds `@Optional()` to reflector in the future, it would silently become a runtime bypass.

### RolesGuard (line 39)

```typescript
constructor(private readonly reflector: Reflector) {}
```

**Issue:** Single dependency, no `@Inject()`. Same metadata dependency as above.

### ThrottlerGuard (backend-common, lines 54-58)

```typescript
constructor(
  private readonly reflector: Reflector,                  // NO @Inject()
  private readonly configService: ConfigService,          // NO @Inject()
  private readonly rateLimiter: SlidingWindowStrategy,    // NO @Inject()
  @Optional() @Inject(IP_VALIDATOR) private readonly ipValidator?: IIpValidator,
)
```

**Issue:** Three non-optional deps without `@Inject()`. Fails on metadata loss. Used by messaging-service, hydroponics-service, ai-service.

---

## FINDING SEC-G-04: Inconsistent DI Patterns Across Services

**Severity:** MEDIUM

The codebase exhibits three distinct DI patterns for APP_GUARD registration:

**Pattern A: useFactory (fully safe)**
Used by: admin-api PlatformAdminGuard, auth-service JwtAuthGuard, gateway-api AuthGuard

```typescript
{
  provide: APP_GUARD,
  useFactory: (reflector: Reflector, config: ConfigService, jwt: JwtService) =>
    new PlatformAdminGuard(reflector, config, jwt),
  inject: [Reflector, ConfigService, JwtService],
}
```

**Pattern B: useClass + @Inject() (safe)**
Used by: gateway-api TenantIsolationGuard, RateLimitGuard, observability InternalApiGuard

```typescript
constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
```

**Pattern C: useClass without @Inject() (vulnerable)**
Used by: ALL backend-common guards (ServiceIdentityGuard, TenantGuard, RolesGuard, ThrottlerGuard) across 10+ services

```typescript
constructor(private readonly reflector: Reflector) {}
```

The comment in `gateway-api/src/app.module.ts` (line 575-577) explicitly states:
> "useFactory with explicit inject array bypasses webpack's stripping of TypeScript emitDecoratorMetadata."

This comment acknowledges the problem exists but attributes it to webpack. The real root cause (per infra-expert's investigation brief) may be `importHelpers: true` + tslib interaction, NX cache staleness, or missing reflect-metadata import. Regardless of root cause, Pattern C is architecturally fragile.

---

## FINDING SEC-G-05: billing-service JwtAuthGuard Has No JWT Verification

**Severity:** HIGH
**File:** `/var/aqua-saas/apps/billing-service/src/common/guards/jwt-auth.guard.ts`

```typescript
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // ... checks @Public() ...
    const user = request.user;
    if (!user || !user.sub) {
      throw new UnauthorizedException('Authentication required');
    }
    return true;
  }
}
```

**Issue:** This guard only checks if `request.user` exists -- it does NOT verify any JWT. It trusts that upstream middleware or the gateway has set `request.user`. While this is acceptable in a federated architecture where the gateway verifies JWTs, it means:

1. If the billing-service is directly accessible (bypassing gateway), any request with a crafted `x-user-payload` header passes authentication
2. The ServiceIdentityGuard (registered before this guard) should prevent direct access, but it too uses `useClass` without `@Inject()` and is vulnerable to DI failure

**Mitigating factor:** The `ServiceIdentityGuard` would crash the service on DI failure before this becomes exploitable.

---

## FINDING SEC-G-06: event-store-service InternalApiKeyGuard Reads API Key from process.env

**Severity:** LOW
**File:** `/var/aqua-saas/apps/event-store-service/src/guards/internal-api-key.guard.ts` (line 30)

```typescript
const apiKey = process.env['INTERNAL_API_KEY'];
```

This guard reads the API key from `process.env` on every request instead of caching it at construction time (like `InternalApiGuard` in observability-service does). This is not a security vulnerability (the value is the same), but it is inconsistent with the observability-service pattern and means the guard has no constructor dependencies -- making it naturally immune to DI metadata loss.

---

## FINDING SEC-G-07: Rollback Mechanism Is Fundamentally Broken

**Severity:** HIGH
**File:** `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` (lines 776-954)

### Root Cause: PREV_GATEWAY Is Empty on First Deploy

```bash
# Line 778
PREV_GATEWAY=$(docker inspect --format='{{.Image}}' aqua-saas-gateway-api-1 2>/dev/null || echo "")
```

**Issue 1:** On first deploy or after `docker compose down --remove-orphans`, the container `aqua-saas-gateway-api-1` does not exist. `docker inspect` fails, and `PREV_GATEWAY` is set to empty string. The rollback block (line 946) checks `if [ -n "$PREV_GATEWAY" ]` and falls through to "manual intervention required."

**Issue 2:** Even when `PREV_GATEWAY` captures a valid image digest, the rollback logic is flawed:

```bash
# Line 948
docker tag "${PREV_GATEWAY}" $(docker compose -f docker-compose.droplet.yml config | grep 'image:.*gateway-api' | awk '{print $2}' | head -1) 2>/dev/null || true
```

This attempts to tag the old image digest as the new image name. But `docker compose down` (line 790) already ran, removing containers and potentially allowing image pruning. The old image may no longer exist.

**Issue 3:** The rollback only covers the gateway. If auth-service or farm-service fails, there is no rollback mechanism at all.

**Issue 4:** The 5-minute health check window (30 attempts x 10 seconds) only checks the gateway. A subgraph service (auth, farm, hr) could crash due to guard DI failure and the gateway health check would still pass (gateway serves 502/503 from Apollo, but the /health/live endpoint on the gateway itself returns 200).

### Security Implication

A failed deploy leaves the platform in an undefined state with no automated recovery. Combined with guard DI failures that crash services, this means extended downtime where:
- The gateway may be up but subgraphs are down
- All GraphQL queries return errors
- No auth verification is happening (because auth-service crashed)

---

## FINDING SEC-G-08: Dockerfile CMD Does Not Pre-load reflect-metadata

**Severity:** MEDIUM
**File:** `/var/aqua-saas/infrastructure/docker/Dockerfile.backend.simple` (line 59)

```dockerfile
CMD ["node", "dist/main.js"]
```

No service's `main.ts` imports `reflect-metadata`. The `reflect-metadata` package IS in `dependencies` (line 153 of package.json: `"reflect-metadata": "^0.2.2"`), so it is installed by `npm ci --omit=dev`. However, it is never explicitly loaded.

NestJS `@nestjs/core` internally imports `reflect-metadata` in its bootstrap. This means:
- If NestJS's internal import runs before any decorator metadata is evaluated, reflection works
- This is currently true but is an **implicit dependency on NestJS's internal implementation**

The `tsconfig.base.json` sets `importHelpers: true` (line 35), which means tsc emits `const tslib_1 = require("tslib")` and calls `tslib_1.__metadata(...)` instead of inlining the helper. `tslib` IS in `dependencies` (line 159: `"tslib": "^2.6.2"`), so this is safe.

**However:** The combination of `importHelpers: true` + no explicit `import 'reflect-metadata'` in main.ts means the metadata registration depends on:
1. tslib being present (it is)
2. reflect-metadata being loaded before tslib's `__metadata` calls `Reflect.metadata` (which is loaded by NestJS core)

This works today but is fragile. If any code evaluates decorators before NestJS's import of reflect-metadata, metadata silently becomes no-ops.

---

## ARCHITECTURAL SOLUTION OPTIONS

### Option A: Add `import 'reflect-metadata'` to All main.ts Files

**Pros:** Explicit, follows NestJS documentation, guarantees reflect-metadata is loaded first
**Cons:** Must be maintained in every service; does not fix the useClass metadata dependency

**Verdict:** Necessary but not sufficient. This prevents the silent metadata loss scenario but does not make guards resilient if metadata is lost for other reasons (bundler, cache staleness).

### Option B: Dockerfile CMD `-r reflect-metadata`

```dockerfile
CMD ["node", "-r", "reflect-metadata", "dist/main.js"]
```

**Pros:** Single change, applies to all services, loaded before any application code
**Cons:** Dockerfile change requires rebuild of all images; does not fix useClass pattern

**Verdict:** Equivalent to Option A but at the infrastructure level. Slightly better because it cannot be forgotten in a new service.

### Option C: Convert All useClass Guards to useFactory+inject

Convert every `{ provide: APP_GUARD, useClass: SomeGuard }` to the explicit factory pattern:

```typescript
{
  provide: APP_GUARD,
  useFactory: (configService: ConfigService, reflector: Reflector, ...) =>
    new SomeGuard(configService, reflector, ...),
  inject: [ConfigService, Reflector, ...],
}
```

**Pros:** Completely eliminates dependency on `design:paramtypes` metadata. DI tokens are explicitly listed in `inject[]`. Works regardless of tsconfig, bundler, or reflect-metadata state.
**Cons:** Verbose; must be maintained in 10+ app.module.ts files; constructor signature changes require updating both the guard and every app.module.ts that registers it.

**Verdict:** This is the only pattern that is truly resilient to ALL metadata loss scenarios. It is the NestJS-recommended approach for guards registered as APP_GUARD.

### Option D: Add @Inject() to All Guard Constructors (backend-common)

Add explicit `@Inject(Token)` decorators to every constructor parameter in the shared guards:

```typescript
constructor(
  @Inject(ConfigService) private readonly configService: ConfigService,
  @Optional() private readonly securityEventService?: SecurityEventService,
) {}
```

**Pros:** Fix at the source (backend-common); all consuming services inherit the fix. Less verbose than Option C.
**Cons:** `@Inject()` decorators ALSO rely on decorator metadata processing. If `experimentalDecorators` or `emitDecoratorMetadata` is disabled, `@Inject()` itself does not work. However, `@Inject()` uses `Reflect.defineMetadata` directly at decoration time, not `design:paramtypes`, so it works independently of tslib's `__metadata` helper.

**Verdict:** Good defense-in-depth. `@Inject()` stores tokens via `Reflect.defineMetadata('self:paramtypes', ...)` which is separate from tsc's `design:paramtypes`. This means even if `importHelpers` fails, `@Inject()` tokens survive because they are registered by NestJS's `@Inject` decorator at import time using the already-loaded reflect-metadata polyfill.

### RECOMMENDED SOLUTION: Option B + Option D (belt and suspenders)

1. **Option B** (Dockerfile CMD `-r reflect-metadata`): Guarantees the polyfill is loaded before anything else. Single infrastructure-level change.

2. **Option D** (Add `@Inject()` to backend-common guards): Makes the 4 shared guards (ServiceIdentityGuard, TenantGuard, RolesGuard, ThrottlerGuard) resilient regardless of how they are registered (`useClass` or `useFactory`).

3. **DO NOT** convert all `useClass` to `useFactory` across 10+ services -- that is the webpack-era workaround. With tsc builds and proper `@Inject()` decorators, `useClass` works correctly.

4. **Add `import 'reflect-metadata'` to the first line of every main.ts** as a code-level safety net (Option A), ensuring no dependency on NestJS's internal import ordering.

---

## ROLLBACK MECHANISM FIX

### Problem

`PREV_GATEWAY` is captured from a running container that may not exist. It only covers the gateway. Image pruning can delete the rollback target.

### Recommended Architecture

```bash
# Before pulling new images, tag ALL current images with a rollback label
for svc in $(docker compose -f docker-compose.droplet.yml config --services); do
  CURRENT_IMAGE=$(docker compose -f docker-compose.droplet.yml images "$svc" --format '{{.Image}}:{{.Tag}}' 2>/dev/null | head -1)
  if [ -n "$CURRENT_IMAGE" ]; then
    docker tag "$CURRENT_IMAGE" "${CURRENT_IMAGE}-rollback" 2>/dev/null || true
  fi
done

# On rollback: restore ALL services, not just gateway
if [ "$HEALTHY" != "true" ]; then
  for svc in $(docker compose -f docker-compose.droplet.yml config --services); do
    ROLLBACK_IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "${svc}.*-rollback" | head -1)
    if [ -n "$ROLLBACK_IMAGE" ]; then
      ORIGINAL_TAG="${ROLLBACK_IMAGE%-rollback}"
      docker tag "$ROLLBACK_IMAGE" "$ORIGINAL_TAG" 2>/dev/null || true
    fi
  done
  docker compose -f docker-compose.droplet.yml up -d --no-build --remove-orphans
fi
```

### Health Check Improvements

1. Check ALL subgraph services, not just gateway
2. Reduce initial check interval to 5 seconds for faster fail detection
3. Add a "partial health" mode: if gateway is up but subgraphs are down, log which specific service failed
4. Total timeout should be 3 minutes (18 attempts x 10s), not 5 minutes

---

## CONCRETE CODE CHANGES REQUIRED

### Change 1: backend-common ServiceIdentityGuard -- Add @Inject()

**File:** `libs/backend-common/src/guards/service-identity.guard.ts`
**Lines:** 40-43

```typescript
// BEFORE:
constructor(
  private readonly configService: ConfigService,
  @Optional() private readonly securityEventService?: SecurityEventService,
)

// AFTER:
// WHY: Explicit @Inject() ensures DI resolution does not depend on
// design:paramtypes metadata from tsc emitDecoratorMetadata. This makes
// the guard resilient to build pipeline changes (bundlers, cache staleness,
// missing tslib). @Inject() registers tokens via Reflect.defineMetadata
// at decoration time, independently of tsc's __metadata helper.
constructor(
  @Inject(ConfigService) private readonly configService: ConfigService,
  @Optional() private readonly securityEventService?: SecurityEventService,
)
```

### Change 2: backend-common TenantGuard -- Add @Inject()

**File:** `libs/backend-common/src/guards/tenant.guard.ts`
**Lines:** 61-65

```typescript
// BEFORE:
constructor(
  private reflector: Reflector,
  @Optional() private readonly auditLogService?: AuditLogService,
  @Optional() private readonly configService?: ConfigService,
)

// AFTER:
// WHY: Reflector is the critical non-optional dependency. Without @Inject(),
// metadata loss causes NestJS to resolve it as null. Every request would crash
// at this.reflector.getAllAndOverride() with a TypeError.
constructor(
  @Inject(Reflector) private reflector: Reflector,
  @Optional() private readonly auditLogService?: AuditLogService,
  @Optional() private readonly configService?: ConfigService,
)
```

### Change 3: backend-common RolesGuard -- Add @Inject()

**File:** `libs/backend-common/src/guards/roles.guard.ts`
**Line:** 39

```typescript
// BEFORE:
constructor(private readonly reflector: Reflector) {}

// AFTER:
// WHY: Same rationale as TenantGuard. Reflector is the sole dependency.
constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
```

Note: Add `Inject` to the import from `@nestjs/common` on line 1-7.

### Change 4: backend-common ThrottlerGuard -- Add @Inject()

**File:** `libs/backend-common/src/security/throttler/throttler.guard.ts`
**Lines:** 54-58

```typescript
// BEFORE:
constructor(
  private readonly reflector: Reflector,
  private readonly configService: ConfigService,
  private readonly rateLimiter: SlidingWindowStrategy,
  @Optional() @Inject(IP_VALIDATOR) private readonly ipValidator?: IIpValidator,
)

// AFTER:
// WHY: Three non-optional deps without @Inject(). Used by messaging,
// hydroponics, and ai-service. All three would crash on metadata loss.
constructor(
  @Inject(Reflector) private readonly reflector: Reflector,
  @Inject(ConfigService) private readonly configService: ConfigService,
  @Inject(SlidingWindowStrategy) private readonly rateLimiter: SlidingWindowStrategy,
  @Optional() @Inject(IP_VALIDATOR) private readonly ipValidator?: IIpValidator,
)
```

### Change 5: Dockerfile -- Pre-load reflect-metadata

**File:** `infrastructure/docker/Dockerfile.backend.simple`
**Line:** 59

```dockerfile
# BEFORE:
CMD ["node", "dist/main.js"]

# AFTER:
# WHY: Ensures reflect-metadata polyfill is loaded before any application
# code. This guarantees Reflect.metadata() and Reflect.getMetadata() are
# available when tsc-emitted __metadata() helpers execute. Without this,
# metadata registration depends on NestJS's internal import ordering --
# an implicit invariant that can break silently.
CMD ["node", "-r", "reflect-metadata", "dist/main.js"]
```

### Change 6: All main.ts files -- Add reflect-metadata import

Add to the FIRST LINE of every service's main.ts:

```typescript
import 'reflect-metadata';
```

**Files affected:**
- `apps/admin-api-service/src/main.ts`
- `apps/auth-service/src/main.ts`
- `apps/farm-service/src/main.ts`
- `apps/gateway-api/src/main.ts`
- `apps/hr-service/src/main.ts`
- `apps/observability-service/src/main.ts`
- `apps/sensor-service/src/main.ts`
- `apps/billing-service/src/main.ts`
- `apps/alert-engine/src/main.ts`
- `apps/config-service/src/main.ts`
- `apps/notification-service/src/main.ts`
- `apps/messaging-service/src/main.ts`
- `apps/hydroponics-service/src/main.ts`
- `apps/ai-service/src/main.ts`
- `apps/event-store-service/src/main.ts`

**WHY:** Belt-and-suspenders. The Dockerfile `-r reflect-metadata` handles the runtime guarantee. The source-level import handles the case where someone runs the service outside Docker (development, CI tests).

---

## ADDITIONAL SECURITY OBSERVATIONS

### SEC-G-09: TenantIsolationGuard Accepts tenantId from Headers, Body, and Query Params

**Severity:** MEDIUM (gateway-level only, mitigated by JWT tenantId priority)
**File:** `/var/aqua-saas/apps/gateway-api/src/guards/tenant-isolation.guard.ts` (lines 162-221)

The `extractRequestedTenantId()` method reads tenant ID from:
1. `x-tenant-id` header (highest priority)
2. URL parameter `/:tenantId/`
3. Query parameter `?tenantId=`
4. Request body `{ tenantId: "..." }`
5. GraphQL variables `{ variables: { tenantId: "..." } }`

While the guard does validate that `requestedTenantId === userTenantId` (line 128), accepting tenant ID from so many sources increases the attack surface. The backend-common `TenantGuard` correctly uses ONLY `req.user.tenantId` from the JWT. The gateway's `TenantIsolationGuard` is weaker in this regard.

**Mitigating factor:** Cross-tenant access check (line 128-133) prevents actual data leak. The user can only access their own tenant's data regardless of what header they send.

### SEC-G-10: MutationRateLimitGuard Has No Constructor Dependencies

**Severity:** INFO (positive finding)
**File:** `/var/aqua-saas/apps/gateway-api/src/guards/mutation-rate-limit.guard.ts`

This guard has an empty constructor (uses `setInterval` directly). It is naturally immune to DI metadata loss. Good.

### SEC-G-11: InternalApiKeyGuard (event-store-service) Has No Constructor Dependencies

**Severity:** INFO (positive finding)
**File:** `/var/aqua-saas/apps/event-store-service/src/guards/internal-api-key.guard.ts`

No constructor dependencies. Reads API key from `process.env` per-request. Naturally immune to DI metadata loss.

---

## RISK MATRIX

| Scenario | Impact | Likelihood | Risk |
|----------|--------|------------|------|
| DI metadata lost + useClass guard | Service crash (fail-closed) | Medium (depends on root cause fix) | HIGH |
| DI metadata lost + someone adds @Optional() to guard deps | Silent guard bypass | Low (requires code change) | CRITICAL |
| Rollback fails after bad deploy | Extended downtime | High (PREV_GATEWAY is empty) | HIGH |
| billing-service directly accessible | Auth bypass | Low (requires network access) | MEDIUM |

---

## DEPLOYMENT GATE

**CRITICAL findings that block deployment:** None active. The current crash behavior is fail-closed.

**HIGH findings that must be fixed this sprint:**
1. SEC-G-02/G-03: Add `@Inject()` to backend-common guards (Changes 1-4)
2. SEC-G-07: Fix rollback mechanism
3. SEC-G-08: Add `-r reflect-metadata` to Dockerfile CMD (Change 5)

**MEDIUM findings for next sprint:**
4. SEC-G-04: Standardize DI pattern across all services
5. SEC-G-09: Review TenantIsolationGuard tenantId source priority
6. Add `import 'reflect-metadata'` to all main.ts (Change 6)
