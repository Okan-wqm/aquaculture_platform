# webpack-to-tsc Migration Architectural Review

**Date:** 2026-04-06
**Scope:** Commits 8bea09a4..c7914a65 (10 commits, webpack-to-tsc migration + hotfix)
**Reviewer:** Orchestrator deep review
**Deploy Status:** FAILED (commit 76ec5a13), HOTFIXED (commit c7914a65)

---

## Deployment Decision

**PASS WITH CONDITIONS** -- The hotfix c7914a65 correctly addresses the immediate crash, but 4 HIGH and 3 MEDIUM findings remain open.

---

## Executive Summary

The webpack-to-tsc migration is architecturally sound. Direct `tsc` compilation correctly preserves NestJS decorator metadata (`emitDecoratorMetadata`), which webpack's tree-shaking was destroying. The build pipeline (`tsc` -> `tsc-alias` -> entry shim) works.

The deploy failure was caused by **commit 76ec5a13**, which removed `@Inject()` decorators and `useFactory` patterns under the incorrect assumption that `emitDecoratorMetadata` alone would always suffice. While this IS true in the current compiled output (verified), the belt-and-suspenders approach (`@Inject()` + `design:paramtypes`) is the correct NestJS pattern because `design:paramtypes` has known fragility across environments.

The hotfix c7914a65 correctly restored `@Inject()` + `useFactory` for the 6 guards that were modified in 76ec5a13, but **did not address the identical vulnerability in `libs/backend-common` guards** (TenantGuard, RolesGuard, ServiceIdentityGuard) that are used via `useClass` across 10+ services.

---

## Findings

### CRITICAL -- None

No remaining critical findings after hotfix c7914a65.

---

### H-01: libs/backend-common Guards Missing @Inject() (HIGH)

**Files:**
- `/var/aqua-saas/libs/backend-common/src/guards/tenant.guard.ts`
- `/var/aqua-saas/libs/backend-common/src/guards/roles.guard.ts`
- `/var/aqua-saas/libs/backend-common/src/guards/service-identity.guard.ts`

**Problem:** These guards are registered via `useClass` in 10+ services (auth-service, farm-service, hr-service, billing-service, alert-engine, config-service, hydroponics-service, ai-service, gateway-api). None of them have `@Inject()` decorators on constructor parameters. They rely solely on `design:paramtypes` metadata from `emitDecoratorMetadata`.

The exact same vulnerability that crashed admin-api-service's PlatformAdminGuard exists here. If `design:paramtypes` fails for any reason (a risk acknowledged by the hotfix commit message: "may not survive all build/runtime environments"), these guards will receive `undefined` for their dependencies.

**Evidence:** The compiled output at `dist/apps/admin-api-service/libs/backend-common/src/guards/tenant.guard.js` shows only `__metadata("design:paramtypes", ...)` with NO `__param` entries for the non-@Optional parameters.

**WHY this hasn't crashed yet:** `Reflector` (from `@nestjs/core`) and `ConfigService` (from `@nestjs/config`) are very commonly resolved and their class references are unlikely to be `undefined` at module load time. But this is coincidence, not correctness.

**ROOT CAUSE:** Commit 76ec5a13 focused only on the 6 guard files it modified. The same architectural risk exists in all `libs/backend-common` guards that never had `@Inject()` in the first place.

**FIX:**

In `libs/backend-common/src/guards/tenant.guard.ts`:
```typescript
constructor(
    @Inject(Reflector) private reflector: Reflector,
    @Optional() private readonly auditLogService?: AuditLogService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
) {
```

In `libs/backend-common/src/guards/roles.guard.ts`:
```typescript
constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
```

In `libs/backend-common/src/guards/service-identity.guard.ts`:
```typescript
constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
) {
```

---

### H-02: NX Cache Does Not Include Build Tooling (HIGH)

**File:** `/var/aqua-saas/nx.json`

**Problem:** The `sharedGlobals` namedInput includes library source and `tsconfig.base.json`, but does NOT include:
- `{workspaceRoot}/tools/build/**` -- the build script itself
- `{workspaceRoot}/apps/*/tsconfig.build.json` -- per-service build configs

This means modifying `tools/build/build-service.sh` (e.g., changing tsc-alias flags, adding a new post-build step) will NOT invalidate the NX cache. Services will serve stale cached artifacts until someone manually clears `.nx/cache` or a source file changes.

Similarly, changes to individual `tsconfig.build.json` files (like the `strictPropertyInitialization` change in commit 35b8e957) are NOT in `sharedGlobals`. They ARE covered by the `{projectRoot}/**/*` pattern in the `default` namedInput, so project-level cache is invalidated, but only for that specific project -- not for other projects that depend on it.

**ROOT CAUSE:** Commit 6c7c4863 added library inputs to `sharedGlobals` but missed the build tooling.

**FIX:** Add to `nx.json` `sharedGlobals`:
```json
"sharedGlobals": [
    "{workspaceRoot}/libs/*/src/**/*.ts",
    "{workspaceRoot}/platform/libs/*/src/**/*.ts",
    "{workspaceRoot}/tsconfig.base.json",
    "{workspaceRoot}/tools/build/**"
]
```

---

### H-03: `node --check` Provides False Confidence (HIGH)

**File:** `/var/aqua-saas/tools/build/build-service.sh` (lines 39-40)

**Problem:** The build script's verification step uses `node --check` which only verifies JavaScript syntax (parsability). It does NOT:
- Execute the code
- Verify module resolution (`require()` paths resolve)
- Verify `reflect-metadata` is loaded
- Verify NestJS DI container can resolve dependencies
- Verify `tsc-alias` rewrote all paths correctly

The deploy failure (commit 76ec5a13) passed `node --check` successfully because the JS was syntactically valid -- the DI failure only manifested at NestJS bootstrap time inside Docker with `--omit=dev`.

**ROOT CAUSE:** `node --check` is equivalent to `node --syntax-check`. It's useful for catching tsc-alias rewrite errors that produce invalid JS, but it cannot catch runtime dependency resolution failures.

**FIX:** Add a module resolution verification step to the build script:
```bash
# ── Verify ──
# Syntax check
node --check "${DIST_DIR}/main.js"
node --check "${DIST_DIR}/apps/${SERVICE_NAME}/src/main.js"

# Module resolution check (verifies all require() paths resolve)
# WHY: node --check only validates syntax, not that imports actually exist.
node -e "try { require('./${DIST_DIR}/apps/${SERVICE_NAME}/src/main.js') } catch(e) { if (e.code === 'MODULE_NOT_FOUND') { console.error(e.message); process.exit(1); } }"
```

Note: This will attempt to actually load the module, which may fail if environment variables or network services are missing. A more targeted approach would be to use a Node.js script that does `require.resolve()` on all `require()` targets without executing them.

---

### H-04: Commit 76ec5a13 Removed useFactory Without Understanding the Root Issue (HIGH -- Already Fixed)

**Files:**
- `/var/aqua-saas/apps/admin-api-service/src/app.module.ts`
- `/var/aqua-saas/apps/auth-service/src/app.module.ts`

**Problem:** Commit 76ec5a13 changed `useFactory` + `inject` back to `useClass` for `APP_GUARD` registrations, based on the assumption "tsc preserves decorator metadata." While tsc DOES emit `design:paramtypes`, there are edge cases where this metadata can fail:

1. **Circular module dependencies** -- if module A imports module B which imports module A, class references in `design:paramtypes` can be `undefined` at decoration time.
2. **Module load order** -- in CommonJS, if a decorated class is evaluated before its parameter types are fully loaded, `design:paramtypes` will contain `undefined` values.
3. **Alpine/musl libc differences** -- while unlikely to affect V8's metadata handling, the deployment environment adds an untested variable.

The `useFactory` + `inject` pattern is fundamentally more reliable because it provides DI tokens EXPLICITLY, bypassing `design:paramtypes` entirely. NestJS core team recommends this for complex guard registrations.

**STATUS:** Fixed in c7914a65. The `useFactory` pattern is restored for admin-api-service and auth-service.

---

### M-01: .dockerignore Does NOT Exclude top-level dist/ (MEDIUM)

**File:** `/var/aqua-saas/.dockerignore`

**Problem:** The `.dockerignore` excludes `apps/*/dist`, `libs/*/dist`, and `platform/*/dist` but does NOT exclude the top-level `dist/` directory. When using `Dockerfile.backend` (multi-stage, builds inside Docker), the entire host `dist/` directory (if it exists from local builds) is sent to the Docker daemon as part of the build context.

For `Dockerfile.backend.simple` (used in CI), the dist IS needed (it copies `dist/apps/${SERVICE_NAME}`), so this is by-design for that Dockerfile. But for `Dockerfile.backend`, the `dist/` is rebuilt inside Docker and the host `dist/` is wasted context.

**Impact:** Increased Docker build context size (can be hundreds of MB with 15 compiled services). Slows down `docker build` for the multi-stage path.

**FIX:** Since both Dockerfiles are in play, the safest approach is to NOT exclude `dist/` globally but document the expected behavior. Alternatively, exclude `dist/` and have `Dockerfile.backend.simple` explicitly note that it requires host-built artifacts.

---

### M-02: Missing ai-service and event-store-service from Deploy Matrix (MEDIUM)

**File:** `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` (line 90)

**Problem:** The `ALL_BACKEND` array in the deploy workflow lists 13 services:
```
gateway-api auth-service farm-service sensor-service admin-api-service alert-engine
billing-service hr-service hydroponics-service notification-service observability-service
config-service messaging-service
```

But `build:backend` in `package.json` includes 15 services (adds `ai-service` and `event-store-service`). These two services:
- Have `project.json` with `build-service.sh` executor
- Have `tsconfig.build.json`
- Are NOT in `docker-compose.droplet.yml`
- Are NOT deployed

**Impact:** Not an immediate issue since they're not in docker-compose either. But if someone adds them to docker-compose without updating the deploy workflow, they won't be detected by the affected-services logic and won't be deployed.

**FIX:** Either:
1. Add `ai-service` and `event-store-service` to `ALL_BACKEND` AND `docker-compose.droplet.yml` when ready for deployment
2. Remove them from `build:backend` if they're not meant to be deployed

---

### M-03: tsconfig.build.json Overrides strictPropertyInitialization Globally (MEDIUM)

**Files:** All 15 `apps/*/tsconfig.build.json` files

**Problem:** Commit 35b8e957 disabled `strictPropertyInitialization` in ALL service tsconfig.build.json files because TypeORM entities define properties via decorators. This is a valid workaround for TypeORM, but it also disables the check for ALL source files in each service, not just entities.

This means a developer can write:
```typescript
class MyService {
    private connection: DatabaseConnection; // No error! Could be undefined.
}
```

The `tsconfig.base.json` still has `strictPropertyInitialization: true`, so IDE type-checking catches this. But the production build silently accepts it.

**ROOT CAUSE:** TypeORM's decorator-based property definition is incompatible with `strictPropertyInitialization`. The correct fix would be to use `!` (definite assignment assertion) on entity properties:
```typescript
@Column()
name!: string;
```

But that requires modifying every entity across all services, which is a larger refactor.

**FIX:** This is acceptable as a transitional measure. Track as tech debt: add `!` assertions to all TypeORM entity properties and re-enable `strictPropertyInitialization`.

---

## Architecture Assessment

### What Works Well

1. **Build script design** (`tools/build/build-service.sh`) -- Clean 4-step pipeline: clean -> tsc -> tsc-alias -> entry shim. The entry shim elegantly bridges the `rootDir=../..` output path structure.

2. **tsc-alias path rewriting** -- Correctly rewrites `@platform/*` and `@aquaculture/*` path aliases to relative paths. Verified in compiled output: `require("../../../libs/backend-common/src/index.js")`.

3. **dist/ output structure** -- `rootDir: "../.."` means tsc outputs to `dist/apps/{svc}/apps/{svc}/src/` with `dist/apps/{svc}/libs/` alongside. All relative paths resolve correctly within the self-contained dist directory.

4. **Dual Dockerfile strategy** -- `Dockerfile.backend` (multi-stage, builds inside Docker) for reproducibility; `Dockerfile.backend.simple` (pre-built artifacts) for CI speed. Both use identical runtime stages.

5. **NX cache configuration** -- Commit 6c7c4863 correctly added library source files to `sharedGlobals`, ensuring library changes invalidate all downstream builds.

6. **Webpack removal** (commit 811d90b1) -- Clean deletion of all 15 webpack.config.js files and the shared `tools/webpack/nestjs-base.config.js`. No orphaned references.

### What Needs Improvement

1. **Guard DI consistency** -- The platform has two patterns coexisting: `@Inject()` + `useFactory` (for guards modified in 76ec5a13/c7914a65) and bare `design:paramtypes` only (for all other guards). This inconsistency will confuse future developers.

2. **Build verification** -- `node --check` is insufficient for catching DI failures. Need a smoke test that at least verifies module resolution.

3. **NX cache inputs** -- Build tooling not included in cache invalidation.

---

## Deploy Failure Root Cause Analysis

### Timeline
1. Commit 76ec5a13 removed `@Inject()` and `useFactory` from 6 guard files
2. Commit builds pass locally and in CI (tsc correctly emits `design:paramtypes`)
3. Docker image built with `Dockerfile.backend.simple` (pre-built artifacts)
4. admin-api-service starts in Docker with `npm ci --omit=dev` (prod-only deps)
5. PlatformAdminGuard receives `[null, null, null]` for `design:paramtypes`
6. NestJS DI cannot resolve Reflector, ConfigService, JwtService
7. admin-api-service crashes on bootstrap
8. gateway-api's Apollo Gateway cannot reach admin-api-service's GraphQL endpoint
9. gateway-api health check fails for 5 minutes
10. Deploy rollback triggers

### Why design:paramtypes Resolved to [null, null, null]

The commit message of c7914a65 states this happened in "Docker production (Alpine musl, prod-only deps)." The most likely cause is **module loading order**: in the Docker container, with only production dependencies installed and a different filesystem (overlay2 + Alpine), the order in which Node.js resolves `require()` calls may differ from the development environment.

When `tslib_1.__metadata("design:paramtypes", [core_1.Reflector, config_1.ConfigService, jwt_1.JwtService])` executes, if any of these module exports are not yet fully resolved (due to a subtle circular require chain involving the guard file), the values will be `undefined`.

The `@Inject()` decorator bypasses this entirely because NestJS stores the injection token in parameter metadata (`__param`), which uses string/symbol tokens rather than class references. This is fundamentally more robust.

### Why It Worked Locally

Local development uses `npm install` (all dependencies), runs on macOS/Linux with a different filesystem, and may have a warm module cache from previous runs. The module loading order happens to resolve correctly in this environment.

---

## Commit-by-Commit Assessment

| Commit | Assessment | Notes |
|--------|-----------|-------|
| 8bea09a4 (docs: design spec) | OK | Good architectural documentation |
| 451218da (docs: impl plan) | OK | Clear task breakdown |
| c06a9a7d (tsc-alias + build script) | OK | Clean implementation |
| 9ca55cea (auth-service pilot) | OK | Good incremental approach |
| 34743a6d (all 15 services) | OK | Consistent migration, correct tsconfig |
| **76ec5a13 (remove @Inject)** | **FAILED** | Incorrect assumption about design:paramtypes reliability |
| 6c7c4863 (Docker + NX cache) | GOOD with gaps | Missing tools/ in NX cache inputs |
| 811d90b1 (remove webpack) | OK | Clean removal |
| 35b8e957 (strictPropertyInit) | ACCEPTABLE | Correct workaround for TypeORM, tracked as tech debt |
| 14a09c60 (deploy timeout) | OK | Correct operational fix |
| **c7914a65 (restore @Inject)** | **GOOD** | Correct fix, but incomplete scope |

---

## Action Items

| Priority | Finding | Action |
|----------|---------|--------|
| HIGH | H-01 | Add `@Inject()` to all `libs/backend-common` guard constructor parameters |
| HIGH | H-02 | Add `tools/build/**` to NX `sharedGlobals` |
| HIGH | H-03 | Replace or supplement `node --check` with module resolution verification |
| MEDIUM | M-02 | Sync ALL_BACKEND list with actual deployable services |
| MEDIUM | M-03 | Track strictPropertyInitialization re-enablement as tech debt |
| LOW | M-01 | Document .dockerignore dist/ behavior |
