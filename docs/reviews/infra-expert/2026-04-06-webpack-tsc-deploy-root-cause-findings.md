# Deploy Pipeline Root Cause Analysis — Findings

**Date:** 2026-04-06
**Reviewer:** infra-expert
**Scope:** Run 24039487488 — admin-api-service PlatformAdminGuard DI failure, gateway health check 5-minute timeout
**Prior Work:** `2026-04-06-webpack-tsc-deploy-root-cause.md` (investigation brief — no prior findings document existed)
**Status:** FIRST ANALYSIS — no prior findings to escalate

---

## Executive Summary

Three independent root causes converge to produce the production DI failure. Each alone is sufficient to break the deploy; all three are present simultaneously. The primary cause is a missing `reflect-metadata` polyfill import in every service `main.ts`. The secondary cause is the NX build cache accepting a stale webpack artifact from before the tsc migration. The tertiary cause is Docker BuildKit serving an old COPY layer despite a fresh artifact being present in the build context.

The symptom — `dependencies: [null, null, null]` in PlatformAdminGuard — is the observable result of cause 1 (or cause 2 if the cache was served). The gateway health check 5-minute timeout is the downstream effect of the service failing to bootstrap.

---

## Finding: INFRA-001

**Severity:** CRITICAL

**Title:** `reflect-metadata` polyfill not imported in any service `main.ts` — production DI silently nullifies all constructor parameter types

**Root Cause:**

`tsconfig.base.json` sets `"importHelpers": true`. This instructs tsc to emit `const tslib_1 = require("tslib")` and replace all helper functions (including `__metadata`) with `tslib_1.__metadata(...)`. The `__metadata` function is the runtime mechanism that records constructor parameter type information via `Reflect.metadata("design:paramtypes", [...])`.

`Reflect.metadata` is not a native JavaScript API. It is provided by the `reflect-metadata` polyfill. If this polyfill is not imported before the first decorated class is evaluated, the `Reflect` global object lacks the `.metadata()` and `.getMetadata()` methods. NestJS DI calls `Reflect.getMetadata("design:paramtypes", target)` to determine constructor dependencies. When the `Reflect` API is absent, the call returns `undefined`, and NestJS maps each dependency slot to `null`.

`apps/admin-api-service/src/main.ts` line 1 imports `@nestjs/common` — not `reflect-metadata`. Every other service `main.ts` follows the same pattern. A search across all 15 `apps/*/src/main.ts` files finds zero occurrences of `import 'reflect-metadata'`. The `libs/backend-common/src/bootstrap/create-service-app.ts` bootstrap factory and `libs/backend-common/src/telemetry/tracing.ts` also do not import it.

Under webpack (the previous build system), this worked by accident: webpack's module bundler evaluates all `import` statements in the bundle before any module code runs, and `@nestjs/common` internally required `reflect-metadata` somewhere in its own module graph at bundle evaluation time. With tsc's CommonJS output, each `require()` executes lazily at the point it appears in the file. `@nestjs/common` does not guarantee it imports `reflect-metadata` — NestJS documents explicitly state that the application entry point must import it first.

**Evidence:**

- `/var/aqua-saas/apps/admin-api-service/src/main.ts` line 1: `import { ValidationPipe, Logger, VersioningType, VERSION_NEUTRAL } from '@nestjs/common';` — no `reflect-metadata` import present anywhere in the file
- `/var/aqua-saas/apps/gateway-api/src/main.ts` line 1: `import { ValidationPipe, Logger } from '@nestjs/common';` — same absence
- Grep across all `apps/*/src/main.ts`: zero matches for `reflect-metadata`
- `reflect-metadata` is correctly listed under `dependencies` (not `devDependencies`) in `package.json` line 153, so `npm ci --omit=dev` installs it — the package is present but never imported
- `tsconfig.base.json` line 36: `"importHelpers": true` — confirms `tslib` helper indirection is in effect
- `package.json` line 159: `"tslib": "^2.6.2"` under `dependencies` — tslib is present

**Fix:** See INFRA-001 in recommendations document.

**Verification:** After fix, run `docker run --rm <image> node -e "require('./dist/main'); process.exit(0)"` — a successful exit without DI errors confirms the polyfill is loaded. For production confirmation, check service startup logs for the absence of `dependencies: [null` patterns.

---

## Finding: INFRA-002

**Severity:** CRITICAL

**Title:** NX build cache does not include `tools/build/build-service.sh` or service-level `tsconfig.build.json` as cache inputs — stale webpack artifact can be promoted to production image

**Root Cause:**

NX computes a task hash to determine whether a cached result can be reused. For the `build` target, `nx.json` declares:

```json
"build": {
  "inputs": ["production", "^production"],
  ...
}
```

The `production` namedInput resolves to `default` minus test files. `default` is `["{projectRoot}/**/*", "sharedGlobals"]`. This means NX hashes all files in `apps/admin-api-service/**/*` plus the shared globals.

Three critical gaps exist:

**Gap 1 — `tools/build/build-service.sh` is not hashed.**
The build executor command is `bash tools/build/build-service.sh admin-api-service`. The content of `build-service.sh` determines whether tsc or webpack runs. When the migration from webpack to tsc was committed (changing `build-service.sh`), the NX task hash did NOT change because `tools/build/` is outside `{projectRoot}` and outside `sharedGlobals`. NX served the pre-migration webpack output from cache.

**Gap 2 — `apps/admin-api-service/tsconfig.build.json` IS within `{projectRoot}/**/*`**, so it is hashed. This gap is smaller — tsconfig changes do invalidate.

**Gap 3 — `apps/*/project.json` is within `{projectRoot}/**/*`**, so executor command changes do invalidate — but only if the `project.json` itself changed during the migration. If `project.json` was not touched (only `build-service.sh` changed), no invalidation occurs.

The GitHub Actions NX cache key (`nx-deploy-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}`) is a separate layer. This key changes only when `package-lock.json` changes. A `build-service.sh`-only commit produces a cache HIT — the runner restores `.nx/cache` containing pre-migration webpack bundles, NX detects its own task hash as a hit against that cache, and returns the webpack artifact without running tsc.

The artifact upload then copies this webpack bundle into `dist/`, Docker BuildKit picks it up, and the production image runs webpack-bundled code. Webpack bundles without explicit `reflect-metadata` import at bundle entry exhibit exactly the failure described: DI resolves `dependencies: [null, null, null]`.

**Evidence:**

- `/var/aqua-saas/nx.json` lines 6-19: `namedInputs.sharedGlobals` contains `{workspaceRoot}/libs/*/src/**/*.ts`, `{workspaceRoot}/platform/libs/*/src/**/*.ts`, `{workspaceRoot}/tsconfig.base.json` — no `tools/**` entry
- `/var/aqua-saas/nx.json` lines 22-28: `targetDefaults.build.inputs` is `["production", "^production"]` — no explicit inclusion of the executor script
- `/var/aqua-saas/tools/build/build-service.sh` is the sole difference between webpack and tsc output — it calls `npx tsc` and `npx tsc-alias`
- `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` line 282: NX Actions cache key `nx-deploy-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}` — does not hash `tools/build/**`
- `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` line 385: `NX_NO_CLOUD: 'true'` is set (good — disables remote NX Cloud cache); `NX_SKIP_NX_CACHE` is NOT set, so local `.nx/cache` is still used

**Fix:** See INFRA-002 in recommendations document.

**Verification:** After fix, run two consecutive deploys where only `build-service.sh` changes between them. Confirm the second deploy reports `[nx] CACHE MISS` for all backend build targets.

---

## Finding: INFRA-003

**Severity:** HIGH

**Title:** Docker BuildKit registry cache (`mode=max`) can serve a stale `COPY dist/` layer from a pre-migration image, even when the CI artifact contains fresh tsc output

**Root Cause:**

The `build-backend-images` job uses:

```yaml
cache-from: type=registry,ref=.../admin-api-service:buildcache-main
cache-to: type=registry,ref=.../admin-api-service:buildcache-main,mode=max
```

`mode=max` caches every layer including intermediate layers. The layer produced by:

```dockerfile
COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist
```

is cached by content hash of the files being copied. Docker BuildKit computes this hash from the build context at the time the layer was originally created.

The problem: if INFRA-002 caused NX to return a webpack artifact, Docker correctly cached it. On the next run, even if NX now returns a tsc artifact (e.g., after INFRA-002 is fixed), Docker will compare the new artifact's content hash against the cached layer. If the hashes differ, Docker invalidates the layer — this is CORRECT behavior.

However, if `--ignore-scripts` or a cross-platform node_modules inconsistency causes `npm ci` in Docker to produce a slightly different `node_modules` fingerprint while the `dist/` layer hash also changed in the same run, BuildKit's layer ordering means the `npm ci` layer cache is hit first (it is earlier in the Dockerfile and more stable), and the `COPY dist/` layer correctly invalidates. This path is not a problem.

The actual risk scenario: if run 24039487488 specifically involved the transition commit where `build-service.sh` changed but NX served cache (INFRA-002), the Docker `COPY dist/` layer fingerprint from the previous webpack bundle was stored in `buildcache-main`. On the next run, if NX NOW correctly builds via tsc (because the cache was cleared), Docker's COPY layer hash changes and BuildKit will NOT serve the old cached layer — it will use the new artifact. This means INFRA-003 is a contributing factor during the specific window between when INFRA-002 first poisoned the BuildKit cache and when it was cleared.

The structural risk that remains: `mode=max` means ANY layer change before `COPY dist/` (e.g., a base image update, an `apk add` change) would not cascade to invalidate the dist layer if BuildKit serves the dist layer from cache independently. This is BuildKit's correct behavior, but it means the `dist/` layer must always have a unique content hash relative to its prior version to invalidate cleanly. Given that `dist/apps/${SERVICE_NAME}` content changes with every build, this invalidates correctly under normal conditions.

The secondary risk: the Dockerfile does not include a build argument that could force-invalidate all layers (e.g., `ARG BUILD_TIMESTAMP`). If two commits produce identical compiled output (e.g., a pure documentation commit triggers a rebuild), BuildKit correctly serves the cached layer. This is correct behavior, not a bug.

**Evidence:**

- `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` lines 627-628: `cache-from`/`cache-to` with `mode=max`
- `/var/aqua-saas/infrastructure/docker/Dockerfile.backend.simple` line 39: `COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist` — this layer's cache key is the content hash of `dist/apps/${SERVICE_NAME}/**`
- If INFRA-002 caused NX to emit a webpack bundle, Docker cached that webpack bundle's content hash. On the next CI run with NX cache cleared, Docker correctly invalidates and uses fresh tsc output — so INFRA-003 self-heals after INFRA-002 is fixed

**Fix:** See INFRA-003 in recommendations document.

---

## Finding: INFRA-004

**Severity:** HIGH

**Title:** `tools/build/build-service.sh` entry shim path is structurally correct but fragile — the `rootDir: ../..` tsc layout produces a deeply nested path that diverges from container CMD expectations if any service changes its tsconfig structure

**Root Cause:**

`build-service.sh` lines 33-36 create:

```
dist/apps/${SERVICE_NAME}/main.js   →  require('./apps/${SERVICE_NAME}/src/main')
```

With `rootDir: ../..` (workspace root) and `outDir: ../../dist/apps/${SERVICE_NAME}`, tsc emits:

```
dist/apps/admin-api-service/apps/admin-api-service/src/main.js
dist/apps/admin-api-service/apps/admin-api-service/src/app.module.js
... (all source files replicated under apps/admin-api-service/ subtree)
```

The shim at `dist/apps/admin-api-service/main.js` does `require('./apps/admin-api-service/src/main')` which resolves to `dist/apps/admin-api-service/apps/admin-api-service/src/main.js`. This is correct.

The Dockerfile copies `dist/apps/${SERVICE_NAME}` to `./dist`, so in the container:

```
/app/dist/main.js           → require('./apps/admin-api-service/src/main')
/app/dist/apps/admin-api-service/src/main.js  → actual entry point
```

`CMD ["node", "dist/main.js"]` in the Dockerfile resolves to `/app/dist/main.js` — which loads `/app/dist/apps/admin-api-service/src/main.js`. This is correct.

The fragility: this layout depends on every service having `rootDir: ../..` in its `tsconfig.build.json`. If any service sets a different `rootDir`, the emitted path changes and the shim breaks silently (node exits with MODULE_NOT_FOUND, container exits with code 1, health check fails with a 5-minute timeout — exactly the failure described).

A service with `rootDir: .` (relative to service directory) would emit to `dist/apps/${SERVICE_NAME}/src/main.js` directly, and the shim's `require('./apps/${SERVICE_NAME}/src/main')` would resolve incorrectly.

**Evidence:**

- `/var/aqua-saas/apps/admin-api-service/tsconfig.build.json` line 6: `"rootDir": "../.."` — workspace root, correct for current shim
- `/var/aqua-saas/tools/build/build-service.sh` lines 33-36: shim generation hard-codes `./apps/${SERVICE_NAME}/src/main` as the require target
- `/var/aqua-saas/infrastructure/docker/Dockerfile.backend.simple` line 59: `CMD ["node", "dist/main.js"]` — loads the shim

**Fix:** See INFRA-004 in recommendations document.

---

## Finding: INFRA-005

**Severity:** MEDIUM

**Title:** `.dockerignore` excludes `dist/apps/*/dist` (line 13) but the pattern `apps/*/dist` does not match the NX workspace output path `dist/apps/*` — backend artifacts are included in build context but the exclusion pattern is never applied

**Root Cause:**

`.dockerignore` line 13: `apps/*/dist`

This pattern matches `apps/admin-api-service/dist` — a path that does not exist. NX outputs to `dist/apps/admin-api-service/` (workspace root `dist/`, not inside the service directory). The intended exclusion (preventing stale local build artifacts from contaminating the Docker build context) never fires.

In CI this is harmless because the runner has a fresh checkout and no local `dist/`. In local developer builds, if a developer runs `docker build` without the CI artifact download step, Docker includes whatever is in the local `dist/apps/*/` tree — which may be a local webpack build or a previous tsc build with wrong content.

The comment on line 11-12 reads: `NOTE: Only exclude backend dist (apps/*/dist) to reduce context` — this is factually wrong; the exclusion does nothing.

**Evidence:**

- `/var/aqua-saas/.dockerignore` lines 11-13: the exclusion comment refers to a pattern that does not match the actual output path
- `/var/aqua-saas/apps/admin-api-service/project.json` line 14: `"outputs": ["{workspaceRoot}/dist/apps/admin-api-service"]` — confirms the output is at workspace root `dist/`, not within the service directory

**Fix:** See INFRA-005 in recommendations document.

---

## Finding: INFRA-006

**Severity:** MEDIUM

**Title:** `build-backend-artifacts` job uses `npm install` (not `npm ci`) — allows lockfile divergence and enables post-install scripts despite the `--ignore-scripts` flag

**Root Cause:**

`deploy-digitalocean.yml` line 287: `npm install --legacy-peer-deps --ignore-scripts --no-audit`

`npm install` writes back to `package-lock.json` if the lockfile is out of sync. This means:
1. If the lockfile generated on Windows (as the comments acknowledge) is missing Linux-specific optional dependencies, `npm install` may add or update entries, silently changing the resolved dependency graph between runs.
2. `npm install` resolves to the latest compatible versions within semver ranges (e.g., `"tslib": "^2.6.2"` could resolve to `2.7.x` in CI vs. `2.6.2` locally), producing non-deterministic builds.
3. The Dockerfile uses `npm ci` (line 35) — this creates a divergence between the build runner's `node_modules` (non-deterministic) and the production container's `node_modules` (deterministic from lockfile).

The `--ignore-scripts` flag is correct for the CI build runner. The divergence concern is real: if `tslib` resolves to different versions between CI build runner and Docker production image, and if the tsc-emitted code uses a tslib helper API that differs across versions, the behavior will differ between build and runtime environments.

**Evidence:**

- `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` line 287: `npm install --legacy-peer-deps --ignore-scripts --no-audit`
- `/var/aqua-saas/infrastructure/docker/Dockerfile.backend.simple` line 35: `npm ci --legacy-peer-deps --omit=dev --ignore-scripts --no-audit`
- `/var/aqua-saas/package.json` line 159: `"tslib": "^2.6.2"` — range spec, not pinned

**Fix:** See INFRA-006 in recommendations document.

---

## Summary Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| INFRA-001 | CRITICAL | `reflect-metadata` not imported in any service `main.ts` | New |
| INFRA-002 | CRITICAL | NX cache missing `tools/build/**` as input — stale webpack artifact | New |
| INFRA-003 | HIGH | Docker BuildKit registry cache poisons COPY dist layer during migration window | New |
| INFRA-004 | HIGH | Entry shim path is fragile — breaks silently if any service changes rootDir | New |
| INFRA-005 | MEDIUM | `.dockerignore` exclusion pattern wrong — `apps/*/dist` never matches | New |
| INFRA-006 | MEDIUM | CI uses `npm install` instead of `npm ci` — non-deterministic dependency resolution | New |

---

## Cross-Domain Handoffs

- **INFRA-001** affects all 15 backend services. Domain experts for auth-service, farm-service, sensor-service, admin-api-service should verify their guards/interceptors/filters after the fix is applied.
- **INFRA-002** is a build pipeline concern. The orchestrator should trigger a full cache-busting deploy (workflow_dispatch "all") after the NX input fix lands.
- **INFRA-004** should be validated by checking all `apps/*/tsconfig.build.json` files have `"rootDir": "../.."`. This is a data-expert concern for any migration service that deviates.
