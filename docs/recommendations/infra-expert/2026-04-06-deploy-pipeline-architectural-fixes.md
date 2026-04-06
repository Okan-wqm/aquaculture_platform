# Deploy Pipeline — Architectural Fix Recommendations

**Date:** 2026-04-06
**Author:** infra-expert
**Companion Review:** `docs/reviews/infra-expert/2026-04-06-webpack-tsc-deploy-root-cause-findings.md`
**Quality Bar:** Every fix below is an architectural solution, not a patch. Each addresses the root cause mechanism, not the symptom.

---

## Fix INFRA-001 — Import `reflect-metadata` as the first statement in every service entry point

**Severity:** CRITICAL
**Addresses:** Missing Reflect API polyfill that causes tsc-compiled NestJS DI to resolve all constructor parameters as `null`

### Why This Is the Architectural Fix (Not a Patch)

The patch (adding `@Inject()` decorators) works around webpack's behavior by bypassing the `design:paramtypes` metadata mechanism entirely. For a tsc build, `design:paramtypes` is the correct, standard mechanism. The fix is to ensure the runtime environment matches what tsc emits — specifically, that `Reflect.metadata` and `Reflect.getMetadata` exist before any decorated class module is evaluated.

Importing `reflect-metadata` first in each service entry point is the NestJS-documented requirement for tsc projects. It is not defensive coding — it is the correct contract between tsc's `emitDecoratorMetadata` output and the NestJS DI container.

### Change 1: All service `main.ts` files

Add `import 'reflect-metadata';` as the absolute first line, before any other import.

**Files to change (all 15):**
- `apps/admin-api-service/src/main.ts`
- `apps/gateway-api/src/main.ts`
- `apps/auth-service/src/main.ts`
- `apps/farm-service/src/main.ts`
- `apps/sensor-service/src/main.ts`
- `apps/alert-engine/src/main.ts`
- `apps/billing-service/src/main.ts`
- `apps/hr-service/src/main.ts`
- `apps/hydroponics-service/src/main.ts`
- `apps/notification-service/src/main.ts`
- `apps/observability-service/src/main.ts`
- `apps/config-service/src/main.ts`
- `apps/messaging-service/src/main.ts`
- `apps/event-store-service/src/main.ts`
- `apps/ai-service/src/main.ts`

**Exact change for `apps/admin-api-service/src/main.ts`:**

```typescript
// WHY: reflect-metadata must be imported before any NestJS module is loaded.
// tsc with emitDecoratorMetadata=true emits __metadata("design:paramtypes", [...])
// calls that depend on Reflect.metadata() existing at module evaluation time.
// Without this import, Reflect.getMetadata("design:paramtypes", cls) returns
// undefined, and NestJS DI maps every constructor parameter to null.
// This is not defensive — it is the required contract for tsc-compiled NestJS.
import 'reflect-metadata';
import { ValidationPipe, Logger, VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
// ... rest of imports unchanged
```

**Exact change for `apps/gateway-api/src/main.ts`:**

```typescript
// WHY: See admin-api-service/src/main.ts — same requirement for all services.
import 'reflect-metadata';
import { ValidationPipe, Logger } from '@nestjs/common';
// ... rest of imports unchanged
```

Apply the same pattern to every service listed above: `import 'reflect-metadata';` must be line 1, no blank line before it, before all other imports.

### Change 2: Enforce via `libs/backend-common/src/bootstrap/create-service-app.ts`

The shared bootstrap factory should not itself import `reflect-metadata` (a library function cannot guarantee import order relative to its callers), but it should be documented that callers must do so:

Add to the JSDoc block in `create-service-app.ts`:

```typescript
/**
 * ...existing docs...
 *
 * IMPORTANT: The calling module MUST import 'reflect-metadata' as its first
 * statement, before importing this function. The tsc emitDecoratorMetadata
 * compiler option emits Reflect.metadata() calls that require the polyfill
 * to be loaded before any decorated class is evaluated.
 *
 * ```ts
 * import 'reflect-metadata'; // MUST be first
 * import { createServiceApp } from '@aquaculture/backend-common';
 * ```
 */
```

### Change 3: Add lint enforcement (optional but recommended)

Add a custom ESLint rule or import-order configuration that enforces `reflect-metadata` as the first import in files matching `apps/*/src/main.ts`. This prevents regression when new services are added.

In root `.eslintrc.json` or each service's `.eslintrc.json`:

```json
{
  "rules": {
    "import/order": ["error", {
      "groups": [["builtin", "external"]],
      "pathGroupsExcludedImportTypes": [],
      "pathGroups": [
        {
          "pattern": "reflect-metadata",
          "group": "builtin",
          "position": "before"
        }
      ]
    }]
  }
}
```

---

## Fix INFRA-002 — Add `tools/build/**` to NX `sharedGlobals` and update the GitHub Actions NX cache key

**Severity:** CRITICAL
**Addresses:** NX cache serving pre-migration webpack artifacts because the build script is not part of the task hash computation

### Why This Is the Architectural Fix

The architectural contract of a build cache is that ANY change to ANY input that affects the output must invalidate the cache. `tools/build/build-service.sh` determines whether tsc or webpack runs — it is a build input by definition. Its absence from NX's hash computation is a cache correctness bug, not a performance trade-off.

The correct fix has two layers:
1. NX task hash must include `build-service.sh` so the local NX cache invalidates when the script changes
2. The GitHub Actions cache key must include `build-service.sh` so the GitHub cache is not restored with a stale `.nx/cache` that was computed without the script in the hash

### Change 1: `nx.json` — add `tools/build/**` to `sharedGlobals`

```json
// nx.json
{
  "namedInputs": {
    "sharedGlobals": [
      "{workspaceRoot}/libs/*/src/**/*.ts",
      "{workspaceRoot}/platform/libs/*/src/**/*.ts",
      "{workspaceRoot}/tsconfig.base.json",
      // WHY: The build script determines whether tsc or webpack runs.
      // Any change to this script must invalidate all backend build caches.
      // Without this, a webpack→tsc migration commit does not bust the NX cache
      // and the old bundled output is promoted to the Docker image.
      "{workspaceRoot}/tools/build/**"
    ]
  }
}
```

### Change 2: `deploy-digitalocean.yml` — include `tools/build/**` in the NX Actions cache key

In both `build-backend-artifacts` (line 277) and `build-frontend-artifacts` (line 420) jobs, update the cache step:

```yaml
- name: Cache Nx
  uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
  with:
    path: .nx/cache
    # WHY: The NX cache key must hash all build inputs that affect compilation output.
    # tools/build/build-service.sh controls whether tsc or webpack is used — any change
    # to the build script must bust the cache to prevent stale artifacts.
    # package-lock.json hashes dependency versions; tools/build/** hashes build logic.
    key: nx-deploy-${{ runner.os }}-${{ hashFiles('**/package-lock.json', 'tools/build/**') }}
    restore-keys: |
      nx-deploy-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
      nx-deploy-${{ runner.os }}-
```

Note: The restore key intentionally falls back to the lockfile-only key so previous caches are still usable as acceleration (NX will rebuild any tasks whose inputs changed); only tasks that were cached with the old build script are rebuilt.

### Change 3: `deploy-digitalocean.yml` — add each service's `tsconfig.build.json` to the cache key (belt-and-suspenders)

The lockfile + tools key covers the migration case. For defence-in-depth, also hash service tsconfigs:

```yaml
key: nx-deploy-${{ runner.os }}-${{ hashFiles('**/package-lock.json', 'tools/build/**', 'apps/*/tsconfig.build.json') }}
```

This ensures that a change to any service's `tsconfig.build.json` (e.g., adding a new `include` path or changing `target`) also busts the cache.

---

## Fix INFRA-003 — Add an explicit build invalidation argument to `Dockerfile.backend.simple` for registry cache control

**Severity:** HIGH
**Addresses:** Docker BuildKit registry cache serving a stale `COPY dist/` layer from a pre-migration run during the transition window

### Why This Is the Architectural Fix

Docker BuildKit's `type=registry,mode=max` cache is correct by design — it caches layers by content hash. The structural problem is that during the migration window (while INFRA-002 was active), the cached `buildcache-main` tag contained webpack-bundled artifacts. After INFRA-002 is fixed, the next tsc build produces different content and the COPY layer is correctly cache-busted.

The architectural improvement is to eliminate the silent "same content = cached layer" ambiguity by making the layer explicitly invalidatable from the CI layer without touching Dockerfile content. This also provides a clean migration escape hatch: when a build system changes, the cache tag can be rotated.

### Change 1: Rename `buildcache-main` to include a build-system version suffix

In `deploy-digitalocean.yml`, the `build-backend-images` job (and `build-frontend-images`):

```yaml
- name: Build and push ${{ matrix.service }}
  uses: docker/build-push-action@471d1dc4e07e5cdedd4c2171150001c434f0b7a4 # v6.15.0
  with:
    context: .
    file: infrastructure/docker/Dockerfile.backend.simple
    push: true
    tags: |
      ${{ needs.prepare.outputs.image_prefix }}/${{ matrix.service }}:${{ env.TAG }}
      ${{ needs.prepare.outputs.image_prefix }}/${{ matrix.service }}:latest
    build-args: |
      SERVICE_NAME=${{ matrix.service }}
    # WHY: buildcache-main-v2 is a new cache namespace.
    # Rotating the cache tag forces BuildKit to rebuild all layers from scratch
    # on the first run with the new tag, eliminating any poisoned cache entries
    # from the webpack→tsc migration period. The -v2 suffix should be incremented
    # whenever a structural change to the build pipeline (different compiler, different
    # Dockerfile structure) makes old cached layers invalid.
    cache-from: type=registry,ref=${{ needs.prepare.outputs.image_prefix }}/${{ matrix.service }}:buildcache-main-v2
    cache-to: type=registry,ref=${{ needs.prepare.outputs.image_prefix }}/${{ matrix.service }}:buildcache-main-v2,mode=max
```

### Change 2: After applying Change 1, manually delete the old `buildcache-main` tags from GHCR

This is a one-time operational step. The old tags will naturally become unreferenced and subject to GHCR's cleanup policy, but explicit deletion prevents any accidental cache-from reference.

---

## Fix INFRA-004 — Make the entry shim path a verified contract in `build-service.sh`

**Severity:** HIGH
**Addresses:** Fragile implicit dependency between `rootDir: ../..` in `tsconfig.build.json` and the hard-coded shim path

### Why This Is the Architectural Fix

The shim is the coupling point between tsc's output layout and the Dockerfile's CMD. Making the shim path a computed value (derived from actual tsc output rather than assumed) eliminates the silent-breakage risk.

### Change: `tools/build/build-service.sh` — verify shim target exists after build

```bash
# ── Entry Shim ──
# WHY: With rootDir=workspace-root, tsc outputs to dist/apps/{svc}/apps/{svc}/src/main.js.
# Docker expects `node dist/main.js`. This shim bridges the gap without modifying
# Dockerfile or CMD.
# WHY verify: If any service's tsconfig.build.json uses a different rootDir, the emitted
# path changes and the shim points to a non-existent file. node --check catches this
# before the Docker image is built rather than after the container fails to start.
SHIM_TARGET="${DIST_DIR}/apps/${SERVICE_NAME}/src/main.js"

if [ ! -f "${SHIM_TARGET}" ]; then
  echo "::error::BUILD FAILED: tsc did not emit expected entry point at ${SHIM_TARGET}"
  echo "::error::Check that apps/${SERVICE_NAME}/tsconfig.build.json has rootDir=../.. (workspace root)"
  echo "::error::Actual tsc output:"
  find "${DIST_DIR}" -name "main.js" | head -5 || echo "  (no main.js found)"
  exit 1
fi

cat > "${DIST_DIR}/main.js" << SHIM
'use strict';
// WHY: rootDir=workspace-root means tsc emits to dist/apps/{svc}/apps/{svc}/src/.
// This shim is the container entry point (CMD: node dist/main.js).
// It delegates to the actual service entry point at the tsc-emitted path.
require('./apps/${SERVICE_NAME}/src/main');
SHIM
```

This replaces the current unconditional `cat > ...` with a pre-check that fails fast with a diagnostic message if the emitted path diverges from expectations.

---

## Fix INFRA-005 — Correct the `.dockerignore` backend dist exclusion pattern

**Severity:** MEDIUM
**Addresses:** `.dockerignore` exclusion `apps/*/dist` never fires because NX outputs to `dist/apps/*` (workspace root), not within service directories

### Change: `.dockerignore` lines 11-13

```
# Build outputs
# NOTE: dist/ (workspace root) is intentionally NOT excluded here — backend services
# need dist/apps/*  included in the build context (it is the pre-built artifact).
# However, we exclude any per-service dist/ directories (legacy paths, not used by NX).
# WHY: NX outputs to {workspaceRoot}/dist/apps/{service}/, not apps/{service}/dist/.
# The previous comment and pattern were wrong — the old pattern `apps/*/dist` matched
# nothing and provided no protection. This comment documents the correct understanding.
libs/*/dist
platform/*/dist
build
**/build
```

Note: `dist/apps/*/` must remain included in the Docker build context because `Dockerfile.backend.simple` line 39 does `COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist`. The file must be present in context. Do not add `dist/` to `.dockerignore`.

---

## Fix INFRA-006 — Replace `npm install` with `npm ci` in the CI build artifact jobs

**Severity:** MEDIUM
**Addresses:** Non-deterministic dependency resolution in CI that can diverge from the production Docker image

### Change: `deploy-digitalocean.yml` line 287 (build-backend-artifacts) and line 430 (build-frontend-artifacts)

```yaml
- name: Install dependencies
  # WHY: npm ci reads package-lock.json exactly — same versions every run, matching
  # the production Dockerfile which also uses npm ci. npm install would write back
  # to package-lock.json when cross-platform optional deps are missing, silently
  # changing the resolved package graph between CI and production.
  run: npm ci --legacy-peer-deps --ignore-scripts --no-audit
```

The cross-platform binary issue (Windows-generated lockfile missing Linux binaries) is already handled by the explicit `install_pkg` function that runs immediately after. Using `npm ci` here ensures the base dependency graph is deterministic before the platform-specific binaries are injected.

---

## Implementation Order

Apply fixes in this order to minimize risk and confirm each fix independently:

1. **INFRA-001** — Add `import 'reflect-metadata'` to all service `main.ts` files. This is the primary production fix. Deploy immediately.
2. **INFRA-003** — Rotate `buildcache-main` to `buildcache-main-v2` in the workflow. This purges the poisoned Docker layer cache. Apply in the same commit as INFRA-001 or the next commit.
3. **INFRA-002** — Update `nx.json` sharedGlobals and the Actions cache key. This prevents the same NX cache poisoning from recurring on future build-script changes.
4. **INFRA-004** — Add the shim verification to `build-service.sh`. Low risk, immediate safety improvement.
5. **INFRA-006** — Switch CI `npm install` to `npm ci`. Low risk, correctness improvement.
6. **INFRA-005** — Fix `.dockerignore` comment and pattern. Documentation/correctness fix, no runtime impact.

After applying INFRA-001 and INFRA-003, trigger `workflow_dispatch` with `services: all` to perform a full rebuild that bypasses all caches and confirms the production DI fix.

---

## Verification Plan

### For INFRA-001

```bash
# After deploying the fixed image, check container logs for the absence of DI errors:
docker logs aqua-admin-api-service 2>&1 | grep -E "null|dependencies:\s*\[null" || echo "CLEAN — no DI null dependencies"

# Confirm reflect-metadata is loaded at process start:
docker run --rm ghcr.io/<repo>/admin-api-service:<sha> \
  node -e "require('/app/dist/main.js'); setTimeout(() => process.exit(0), 5000)" \
  2>&1 | head -20
```

### For INFRA-002

```bash
# After applying nx.json change, make a change to build-service.sh (add a comment),
# commit, push. In CI logs, verify:
#   [nx] CACHE MISS: admin-api-service:build
# not:
#   [nx] cache hit for admin-api-service:build
```

### For INFRA-003

```bash
# In the build-backend-images job logs, verify the COPY layer shows:
#   #17 COPY dist/apps/admin-api-service ./dist   0.3s   (not "CACHED")
# on the first run after rotating to buildcache-main-v2
```
