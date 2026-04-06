# Webpack → tsc Migration Design

**Date:** 2026-04-06
**Status:** Draft
**Priority:** P0 — Platform offline since 2026-04-05

## Problem

All 15 backend NestJS services use `@nx/webpack:webpack` executor. Webpack's module evaluation order breaks TypeScript's `design:paramtypes` decorator metadata — NestJS sees `[null, null, null]` instead of actual class references and crashes at startup. 4 different webpack config fixes (concatenateModules, usedExports, @Inject, useFactory) all failed. The root cause is architectural: webpack is a frontend bundler being misused for Node.js backend services.

## Decision

Replace `@nx/webpack:webpack` with direct `tsc` compilation via `nx:run-commands` executor. Use `tsc-alias` for compile-time path alias resolution. Remove all webpack infrastructure. Each service's dist output is fully self-contained with compiled libs inlined.

## Why Not Other Approaches

| Alternative | Why Rejected |
|---|---|
| `@nx/js:tsc` executor | Conflicts with rootDir when including non-buildable libs. NX's mainOutputPath calculation mismatches when rootDir = workspace root. Adds an abstraction layer we can't control. |
| Buildable libs (project.json per lib) | Correct long-term architecture, but 11+ new project configs + Docker pipeline changes for `file:` protocol resolution. Phase 2 candidate. |
| `tsconfig-paths/register` runtime | Runtime dependency, startup latency, debugging opacity. Enterprise services must resolve all imports at compile time. |
| TypeScript project references (`tsc -b`) | ~25 new tsconfig files, custom package.json generation, custom asset pipeline. Unnecessary complexity. |
| `@nx/js:tsc` + tsc-alias | NX overrides rootDir/outDir internally, causing conflicts with inline lib compilation. Direct `tsc` gives full control. |

## Architecture

### Build Pipeline (per service)

```
apps/{service}/src/**/*.ts + libs/**/src/**/*.ts + platform/libs/**/src/**/*.ts
  ─── tsc (compile, rootDir=workspace root) ───►
    dist/apps/{service}/ (monorepo structure preserved, @platform/* unresolved in JS)
      ─── tsc-alias (rewrite @platform/* to relative paths) ───►
        dist/apps/{service}/ (all imports resolved, self-contained)
          ─── asset copy ───►
            ─── entry shim (main.js) ───►
              ─── build verify (syntax + file existence) ───►
                Ready for Docker
```

### Shared Build Script

**File:** `tools/build/build-service.sh`

Single shared script for all 15 services. NX calls it via `nx:run-commands`.

```bash
#!/bin/bash
# tools/build/build-service.sh — Enterprise build script for NestJS services
# Replaces webpack with direct tsc compilation
set -euo pipefail

SERVICE_NAME="${1:?Usage: build-service.sh <service-name>}"
DIST_DIR="dist/apps/${SERVICE_NAME}"

# ── Clean ──
rm -rf "${DIST_DIR}"

# ── Compile ──
# Direct tsc: no webpack, no NX abstraction. Decorator metadata preserved.
tsc -p "apps/${SERVICE_NAME}/tsconfig.build.json"

# ── Path Resolution ──
# Rewrite @platform/* and @aquaculture/* imports to relative paths.
# All imports resolve within dist directory — fully self-contained.
npx tsc-alias -p "apps/${SERVICE_NAME}/tsconfig.build.json" --outDir "${DIST_DIR}"

# ── Assets ──
if [ -d "apps/${SERVICE_NAME}/src/assets" ]; then
  mkdir -p "${DIST_DIR}/apps/${SERVICE_NAME}/src/assets"
  cp -r "apps/${SERVICE_NAME}/src/assets/." "${DIST_DIR}/apps/${SERVICE_NAME}/src/assets/"
fi

# ── Entry Shim ──
# Docker expects `node dist/main.js`. With rootDir=workspace-root the real
# entry is at dist/apps/{service}/src/main.js. This shim bridges the gap
# so Dockerfile CMD stays unchanged.
cat > "${DIST_DIR}/main.js" << SHIM
'use strict';
// WHY: tsc with rootDir=workspace-root produces nested output.
// This shim preserves Docker CMD ["node", "dist/main.js"] compatibility.
require('./apps/${SERVICE_NAME}/src/main');
SHIM

# ── Verify ──
node --check "${DIST_DIR}/main.js"
node --check "${DIST_DIR}/apps/${SERVICE_NAME}/src/main.js"

echo "BUILD OK: ${SERVICE_NAME}"
```

### File Changes

#### 1. New: `tsconfig.build.json` per service (x15)

Each service gets a dedicated build tsconfig that includes workspace lib sources.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "../../dist/apps/{service}",
    "rootDir": "../..",
    "module": "commonjs",
    "target": "ES2021",
    "types": ["node"],
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "removeComments": true
  },
  "include": [
    "src/**/*.ts",
    "../../libs/*/src/**/*.ts",
    "../../platform/libs/*/src/**/*.ts"
  ],
  "exclude": [
    "**/*.spec.ts",
    "**/*.test.ts",
    "**/*.e2e-spec.ts",
    "jest.config.ts",
    "../../libs/testing/**"
  ]
}
```

**Key decisions:**
- `rootDir: "../.."` (workspace root) — allows lib sources to compile alongside service. Output preserves monorepo directory structure.
- `declaration: false` — production build doesn't need `.d.ts` files.
- `sourceMap: false` — production builds. Development uses `nx serve` with ts-node.
- Libs included via `../../libs/*/src/**/*.ts` — each service compiles its own copy of needed libs. This makes each service's dist fully self-contained.
- `../../libs/testing/**` excluded — test utilities not needed in production.

**Existing `tsconfig.app.json` is NOT modified** — it continues to be used by `nx serve` (development) and IDE tooling. The new `tsconfig.build.json` is production-only.

#### 2. Modified: `project.json` per service (x15)

```json
{
  "build": {
    "executor": "nx:run-commands",
    "outputs": ["{workspaceRoot}/dist/apps/{service}"],
    "defaultConfiguration": "production",
    "options": {
      "command": "bash tools/build/build-service.sh {service}",
      "cwd": "{workspaceRoot}"
    },
    "configurations": {
      "development": {},
      "production": {}
    }
  }
}
```

**What stays:** `serve`, `lint`, `test` targets unchanged.

**What's removed:** `target`, `compiler`, `webpackConfig`, `optimization`, `extractLicenses`, `inspect`, `generatePackageJson`, `assets`, `main`, `tsConfig` (all managed by tsconfig.build.json + build script now).

#### 3. Modified: `nx.json`

Add `post-build` and `verify` target defaults (not strictly needed since build script is monolithic, but useful for future decomposition):

```json
{
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["production", "^production"],
      "outputs": ["{workspaceRoot}/dist/{projectRoot}"],
      "cache": true
    }
  }
}
```

NX caching works because `outputs` is declared. `nx affected --target=build` only rebuilds changed services.

#### 4. Modified: Dockerfiles

**`infrastructure/docker/Dockerfile.backend` — NO CHANGES to CMD.**

The entry shim at `dist/apps/{service}/main.js` means Docker's `CMD ["node", "dist/main.js"]` works as-is.

The only change is in the builder stage — replace `npx nx build` with the direct command:

```dockerfile
# Stage 3: Builder (line 62-63)
# BEFORE:
RUN --mount=type=cache,target=/app/.nx/cache,sharing=shared \
    npx nx build ${SERVICE_NAME}

# AFTER:
COPY tools/ ./tools/
RUN --mount=type=cache,target=/app/.nx/cache,sharing=shared \
    bash tools/build/build-service.sh ${SERVICE_NAME}
```

**Why call build script directly instead of `npx nx build`?**
In Docker, each service builds in isolation — no NX cache benefit. Direct script call is faster (no NX daemon startup) and more transparent.

**`infrastructure/docker/Dockerfile.backend.simple`** — No changes. It copies pre-built `dist/` from host. The shim makes it compatible.

#### 5. Webpack Cleanup

**17 files to delete:**

| File | Reason |
|---|---|
| `tools/webpack/nestjs-base.config.js` | Shared webpack base config |
| `apps/auth-service/webpack.config.js` | Per-service webpack config |
| `apps/admin-api-service/webpack.config.js` | Per-service webpack config |
| `apps/billing-service/webpack.config.js` | Per-service webpack config |
| `apps/notification-service/webpack.config.js` | Per-service webpack config |
| `apps/messaging-service/webpack.config.js` | Per-service webpack config |
| `apps/observability-service/webpack.config.js` | Per-service webpack config |
| `apps/gateway-api/webpack.config.js` | Per-service webpack config |
| `apps/sensor-service/webpack.config.js` | Per-service webpack config |
| `apps/farm-service/webpack.config.js` | Per-service webpack config |
| `apps/event-store-service/webpack.config.js` | Per-service webpack config |
| `apps/alert-engine/webpack.config.js` | Per-service webpack config |
| `apps/config-service/webpack.config.js` | Per-service webpack config |
| `apps/hydroponics-service/webpack.config.js` | Per-service webpack config |
| `apps/ai-service/webpack.config.js` | Per-service webpack config |
| `apps/hr-service/webpack.config.js` | Per-service webpack config |

**If `tools/webpack/` directory becomes empty, delete the directory.**

**package.json dependency changes:**
- Remove: `@nx/webpack` (devDependency)
- Remove: `tsconfig-paths-webpack-plugin` (if present in devDependencies)
- Add: `tsc-alias` (devDependency)

#### 6. Revert Previous Workarounds

Commits `fb4980e4` and `0aa467f0` added `useFactory` + `@Inject()` workarounds to bypass webpack's broken metadata. With tsc, decorator metadata works correctly — revert these:

| File | Revert |
|---|---|
| `apps/admin-api-service/src/guards/platform-admin.guard.ts` | Remove explicit `@Inject()` decorators on constructor params |
| `apps/admin-api-service/src/app.module.ts` | Remove `useFactory` provider for PlatformAdminGuard, use standard provider |
| `apps/auth-service/src/app.module.ts` | Remove `useFactory` provider for JwtAuthGuard, use standard provider |
| `apps/farm-service/src/**/*guard*` | Remove explicit `@Inject()` if added |
| `apps/hr-service/src/**/*guard*` | Remove explicit `@Inject()` if added |
| `apps/observability-service/src/**/*guard*` | Remove explicit `@Inject()` if added |

**Note:** The `@Inject()` decorators are not harmful — they're just unnecessary noise. The `useFactory` patterns are more important to revert as they add complexity and hide the real provider registration.

#### 7. package.json Build Scripts

```json
{
  "build:backend": "nx run-many --target=build --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,billing-service,hr-service,hydroponics-service,notification-service,admin-api-service,config-service,event-store-service,observability-service,messaging-service,ai-service",
  "docker:fast": "npm run build:backend && docker buildx bake backend-simple --load --parallel"
}
```

No changes needed — same NX commands, just executor changed internally.

### Output Directory Structure

```
dist/apps/auth-service/
├── main.js                              ← entry shim (require → real entry)
├── apps/
│   └── auth-service/
│       └── src/
│           ├── main.js                  ← real NestJS bootstrap
│           ├── app.module.js
│           ├── auth/
│           │   ├── auth.controller.js
│           │   ├── auth.service.js
│           │   └── guards/
│           │       └── jwt-auth.guard.js
│           ├── database/
│           │   └── seed.service.js
│           └── assets/                  ← copied by build script
├── libs/
│   ├── backend-common/
│   │   └── src/
│   │       ├── index.js
│   │       ├── database/
│   │       ├── guards/
│   │       └── ...
│   ├── event-contracts/
│   │   └── src/
│   │       └── index.js
│   └── shared/
│       └── src/
│           └── index.js
└── platform/
    └── libs/
        ├── event-bus/
        │   └── src/index.js
        ├── cqrs/
        │   └── src/index.js
        └── ...
```

**tsc-alias path rewriting example:**

```javascript
// File: dist/apps/auth-service/apps/auth-service/src/auth/auth.service.js

// BEFORE tsc-alias:
const backend_common_1 = require("@platform/backend-common");

// AFTER tsc-alias (4 levels up from auth/ to dist root, then into libs/):
const backend_common_1 = require("../../../../libs/backend-common/src/index");
```

Path trace: `apps/auth-service/src/auth/` → `../../../..` → dist root → `libs/backend-common/src/index` ✓

### Special Service Handling

| Service | Concern | Resolution |
|---|---|---|
| `sensor-service` | Piscina `st-worker.ts` needs separate entry point | tsc preserves directory structure. `st-worker-pool.service.ts:61` uses `join(__dirname, 'st-worker.js')` — resolves correctly because `st-worker.ts` compiles to `st-worker.js` in same relative directory. No special handling needed. |
| `event-store-service` | Had `isolatedConfig: true`, missing `generatePackageJson` | Both were webpack-specific. Neither exists in new build pipeline. Clean slate. |
| `config-service` | Had `TsconfigPathsPlugin` in webpack config | tsconfig paths are resolved by tsc-alias at compile time. Plugin unnecessary. |
| `ai-service` / `messaging-service` | May have large dependency trees | tsc compiles all included sources. Build time may increase but NX caching mitigates. |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| tsc-alias misses a path alias pattern | Low | High — MODULE_NOT_FOUND at runtime | Build script runs `node --check` on entry. CI smoke test. All 20 path aliases in tsconfig.base.json are standard `@platform/*` / `@aquaculture/*` patterns. |
| Lib source includes pull in unwanted files | Medium | Low — larger dist, slower build | Explicit exclude patterns in tsconfig.build.json. `libs/testing/**` already excluded. |
| `nx serve` breaks for local development | Low | Medium — developer friction | `serve` target unchanged — still uses `@nx/js:node` with `buildTarget` pointing to build. If `nx:run-commands` build doesn't integrate with `@nx/js:node` watch mode, developers can use `ts-node -r tsconfig-paths/register apps/{service}/src/main.ts`. |
| NX caching doesn't work with `nx:run-commands` | Low | Low — slower CI, no correctness issue | `outputs` declared in project.json. NX hashes inputs (source files) and checks outputs exist. Caching works for `nx:run-commands` with declared outputs. |
| Some `.ts` files import non-TS assets (e.g., `.json`) | Low | Medium — compile error | `resolveJsonModule: true` already in tsconfig.base.json. JSON files compile fine. Other asset types (.html, .graphql) would need separate handling — check during migration. |

### Rollback Strategy

1. `git revert` the migration commit
2. All webpack configs restored, project.json reverts to `@nx/webpack:webpack`
3. Build and deploy from reverted commit
4. Zero data loss — migration only touches build config and workaround code

### Success Criteria

1. `npm run build:backend` completes for all 15 services
2. Each service's `dist/apps/{service}/main.js` entry shim loads without error
3. `tsc-alias` rewrites all `@platform/*` and `@aquaculture/*` imports to relative paths (zero unresolved aliases in `dist/`)
4. Docker images build and start without DI `[null, null, null]` crashes
5. All 17 webpack config files deleted
6. `@nx/webpack` removed from devDependencies
7. `tsc-alias` added to devDependencies
8. sensor-service's piscina worker pool initializes correctly
9. auth-service's SeedService.onModuleInit() runs without crash

### Migration Order

Migrate and verify one service at a time. Start with the two crashing services:

1. **auth-service** — currently crash-looping, highest priority
2. **admin-api-service** — currently crash-looping, has guard workarounds
3. **gateway-api** — API gateway, validates full request pipeline
4. **config-service** — had custom webpack (TsconfigPathsPlugin)
5. **sensor-service** — has piscina worker entry point
6. **event-store-service** — had isolatedConfig
7. Remaining 9 services in parallel (all vanilla, no special handling)
