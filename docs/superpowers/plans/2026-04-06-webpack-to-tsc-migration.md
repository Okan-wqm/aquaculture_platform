# Webpack → tsc Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all 15 backend NestJS services from `@nx/webpack:webpack` to direct `tsc` compilation, fixing the deploy crash-loop caused by webpack breaking decorator metadata.

**Architecture:** Each service gets a `tsconfig.build.json` (rootDir=workspace root, includes lib sources). A shared `tools/build/build-service.sh` runs `tsc` + `tsc-alias` + asset copy + entry shim generation. `nx:run-commands` executor calls the script. Docker CMD unchanged via entry shim.

**Tech Stack:** TypeScript `tsc`, `tsc-alias`, NX `nx:run-commands`, bash

**Spec:** `docs/superpowers/specs/2026-04-06-webpack-to-tsc-migration-design.md`

---

### Task 1: Foundation — Install tsc-alias and Create Build Script

**Files:**
- Modify: `package.json` (add tsc-alias devDependency)
- Create: `tools/build/build-service.sh`

- [ ] **Step 1: Install tsc-alias**

```bash
npm install --save-dev tsc-alias
```

Expected: `tsc-alias` added to `devDependencies` in `package.json`.

- [ ] **Step 2: Create the shared build script**

Create file `tools/build/build-service.sh`:

```bash
#!/bin/bash
# tools/build/build-service.sh — Enterprise build script for NestJS services
# Replaces webpack with direct tsc compilation.
# Usage: bash tools/build/build-service.sh <service-name>
set -euo pipefail

SERVICE_NAME="${1:?Usage: build-service.sh <service-name>}"
DIST_DIR="dist/apps/${SERVICE_NAME}"

# ── Clean ──
rm -rf "${DIST_DIR}"

# ── Compile ──
# WHY: Direct tsc preserves decorator metadata (emitDecoratorMetadata).
# Webpack's module evaluation order breaks this — see design spec.
npx tsc -p "apps/${SERVICE_NAME}/tsconfig.build.json"

# ── Path Resolution ──
# WHY: tsc does NOT rewrite path aliases in emitted JS.
# tsc-alias rewrites @platform/* and @aquaculture/* to relative paths
# so all require() calls resolve within the dist directory.
npx tsc-alias -p "apps/${SERVICE_NAME}/tsconfig.build.json" --outDir "${DIST_DIR}"

# ── Assets ──
if [ -d "apps/${SERVICE_NAME}/src/assets" ]; then
  mkdir -p "${DIST_DIR}/apps/${SERVICE_NAME}/src/assets"
  cp -r "apps/${SERVICE_NAME}/src/assets/." "${DIST_DIR}/apps/${SERVICE_NAME}/src/assets/"
fi

# ── Entry Shim ──
# WHY: With rootDir=workspace-root, tsc outputs to dist/apps/{svc}/apps/{svc}/src/main.js.
# Docker expects `node dist/main.js`. This shim bridges the gap.
cat > "${DIST_DIR}/main.js" << SHIM
'use strict';
require('./apps/${SERVICE_NAME}/src/main');
SHIM

# ── Verify ──
node --check "${DIST_DIR}/main.js"
node --check "${DIST_DIR}/apps/${SERVICE_NAME}/src/main.js"

echo "BUILD OK: ${SERVICE_NAME}"
```

- [ ] **Step 3: Make script executable**

```bash
chmod +x tools/build/build-service.sh
```

- [ ] **Step 4: Commit foundation**

```bash
git add tools/build/build-service.sh package.json package-lock.json
git commit -m "build: add tsc-alias and shared build script for webpack→tsc migration"
```

---

### Task 2: Pilot — Migrate auth-service

**Files:**
- Create: `apps/auth-service/tsconfig.build.json`
- Modify: `apps/auth-service/project.json`

- [ ] **Step 1: Create tsconfig.build.json for auth-service**

Create file `apps/auth-service/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "../../dist/apps/auth-service",
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

- [ ] **Step 2: Update auth-service project.json build target**

In `apps/auth-service/project.json`, replace the entire `build` target:

**Old:**
```json
    "build": {
      "executor": "@nx/webpack:webpack",
      "outputs": ["{options.outputPath}"],
      "defaultConfiguration": "production",
      "options": {
        "target": "node",
        "compiler": "tsc",
        "outputPath": "dist/apps/auth-service",
        "main": "apps/auth-service/src/main.ts",
        "tsConfig": "apps/auth-service/tsconfig.app.json",
        "assets": ["apps/auth-service/src/assets"],
        "generatePackageJson": true,
        "webpackConfig": "apps/auth-service/webpack.config.js"
      },
      "configurations": {
        "development": {
          "optimization": false,
          "sourceMap": true
        },
        "production": {
          "optimization": true,
          "extractLicenses": true,
          "inspect": false,
          "sourceMap": false
        }
      }
    },
```

**New:**
```json
    "build": {
      "executor": "nx:run-commands",
      "outputs": ["{workspaceRoot}/dist/apps/auth-service"],
      "defaultConfiguration": "production",
      "options": {
        "command": "bash tools/build/build-service.sh auth-service"
      },
      "configurations": {
        "development": {},
        "production": {}
      }
    },
```

- [ ] **Step 3: Build auth-service and verify**

```bash
rm -rf dist/apps/auth-service
bash tools/build/build-service.sh auth-service
```

Expected output: `BUILD OK: auth-service`

Verify output structure:
```bash
ls dist/apps/auth-service/main.js
ls dist/apps/auth-service/apps/auth-service/src/main.js
```

Verify no unresolved @platform imports:
```bash
grep -r "@platform/" dist/apps/auth-service/ --include="*.js" | head -5
```

Expected: zero matches (all rewritten to relative paths by tsc-alias).

- [ ] **Step 4: Commit pilot**

```bash
git add apps/auth-service/tsconfig.build.json apps/auth-service/project.json
git commit -m "build(auth-service): migrate from webpack to tsc — pilot service"
```

---

### Task 3: Migrate Remaining 14 Services

**Files (create):**
- `apps/admin-api-service/tsconfig.build.json`
- `apps/gateway-api/tsconfig.build.json`
- `apps/config-service/tsconfig.build.json`
- `apps/sensor-service/tsconfig.build.json`
- `apps/event-store-service/tsconfig.build.json`
- `apps/farm-service/tsconfig.build.json`
- `apps/billing-service/tsconfig.build.json`
- `apps/hr-service/tsconfig.build.json`
- `apps/notification-service/tsconfig.build.json`
- `apps/messaging-service/tsconfig.build.json`
- `apps/observability-service/tsconfig.build.json`
- `apps/alert-engine/tsconfig.build.json`
- `apps/hydroponics-service/tsconfig.build.json`
- `apps/ai-service/tsconfig.build.json`

**Files (modify):**
- `apps/admin-api-service/project.json`
- `apps/gateway-api/project.json`
- `apps/config-service/project.json`
- `apps/sensor-service/project.json`
- `apps/event-store-service/project.json`
- `apps/farm-service/project.json`
- `apps/billing-service/project.json`
- `apps/hr-service/project.json`
- `apps/notification-service/project.json`
- `apps/messaging-service/project.json`
- `apps/observability-service/project.json`
- `apps/alert-engine/project.json`
- `apps/hydroponics-service/project.json`
- `apps/ai-service/project.json`

- [ ] **Step 1: Create tsconfig.build.json for all 14 services**

Each file is identical except the `outDir`. Create each one:

**Template** (replace `{SERVICE}` with service name):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "../../dist/apps/{SERVICE}",
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

Create for each: `admin-api-service`, `gateway-api`, `config-service`, `sensor-service`, `event-store-service`, `farm-service`, `billing-service`, `hr-service`, `notification-service`, `messaging-service`, `observability-service`, `alert-engine`, `hydroponics-service`, `ai-service`.

- [ ] **Step 2: Update project.json for all 14 services**

For each service, replace the `build` target. The pattern varies slightly between services — here are the exact edits grouped by pattern.

**Group A — Standard services (11 services):** `gateway-api`, `farm-service`, `billing-service`, `hr-service`, `notification-service`, `messaging-service`, `alert-engine`, `hydroponics-service`, `ai-service`, `sensor-service`, `config-service`

These all have the same build target structure. Replace the entire `"build": {...}` block.

**Old (standard pattern):**
```json
    "build": {
      "executor": "@nx/webpack:webpack",
      "outputs": ["{options.outputPath}"],
      "defaultConfiguration": "production",
      "options": {
        "target": "node",
        "compiler": "tsc",
        "outputPath": "dist/apps/{SERVICE}",
        "main": "apps/{SERVICE}/src/main.ts",
        "tsConfig": "apps/{SERVICE}/tsconfig.app.json",
        "assets": ["apps/{SERVICE}/src/assets"],
        "generatePackageJson": true,
        "webpackConfig": "apps/{SERVICE}/webpack.config.js"
      },
      "configurations": {
        "development": {
          "optimization": false,
          "sourceMap": true
        },
        "production": {
          "optimization": true,
          "extractLicenses": true,
          "inspect": false,
          "sourceMap": false
        }
      }
    },
```

**New (for each service, replace `{SERVICE}`):**
```json
    "build": {
      "executor": "nx:run-commands",
      "outputs": ["{workspaceRoot}/dist/apps/{SERVICE}"],
      "defaultConfiguration": "production",
      "options": {
        "command": "bash tools/build/build-service.sh {SERVICE}"
      },
      "configurations": {
        "development": {},
        "production": {}
      }
    },
```

**Group B — admin-api-service** (no `assets` field, different option ordering):

**Old:**
```json
    "build": {
      "executor": "@nx/webpack:webpack",
      "outputs": ["{options.outputPath}"],
      "defaultConfiguration": "production",
      "options": {
        "target": "node",
        "compiler": "tsc",
        "outputPath": "dist/apps/admin-api-service",
        "main": "apps/admin-api-service/src/main.ts",
        "tsConfig": "apps/admin-api-service/tsconfig.app.json",
        "webpackConfig": "apps/admin-api-service/webpack.config.js",
        "generatePackageJson": true
      },
      "configurations": {
        "development": {
          "optimization": false,
          "sourceMap": true
        },
        "production": {
          "optimization": true,
          "sourceMap": false,
          "extractLicenses": true
        }
      }
    },
```

**New:**
```json
    "build": {
      "executor": "nx:run-commands",
      "outputs": ["{workspaceRoot}/dist/apps/admin-api-service"],
      "defaultConfiguration": "production",
      "options": {
        "command": "bash tools/build/build-service.sh admin-api-service"
      },
      "configurations": {
        "development": {},
        "production": {}
      }
    },
```

**Group C — observability-service** (different option ordering, no `assets`):

**Old:**
```json
    "build": {
      "executor": "@nx/webpack:webpack",
      "outputs": ["{options.outputPath}"],
      "defaultConfiguration": "production",
      "options": {
        "target": "node",
        "compiler": "tsc",
        "outputPath": "dist/apps/observability-service",
        "main": "apps/observability-service/src/main.ts",
        "tsConfig": "apps/observability-service/tsconfig.app.json",
        "webpackConfig": "apps/observability-service/webpack.config.js",
        "generatePackageJson": true
      },
      "configurations": {
        "development": {
          "optimization": false,
          "sourceMap": true
        },
        "production": {
          "optimization": true,
          "sourceMap": false,
          "extractLicenses": true
        }
      }
    },
```

**New:**
```json
    "build": {
      "executor": "nx:run-commands",
      "outputs": ["{workspaceRoot}/dist/apps/observability-service"],
      "defaultConfiguration": "production",
      "options": {
        "command": "bash tools/build/build-service.sh observability-service"
      },
      "configurations": {
        "development": {},
        "production": {}
      }
    },
```

**Group D — event-store-service** (has `isolatedConfig: true`, no `generatePackageJson`):

**Old:**
```json
    "build": {
      "executor": "@nx/webpack:webpack",
      "outputs": ["{options.outputPath}"],
      "defaultConfiguration": "production",
      "options": {
        "target": "node",
        "compiler": "tsc",
        "outputPath": "dist/apps/event-store-service",
        "main": "apps/event-store-service/src/main.ts",
        "tsConfig": "apps/event-store-service/tsconfig.app.json",
        "assets": ["apps/event-store-service/src/assets"],
        "isolatedConfig": true,
        "webpackConfig": "apps/event-store-service/webpack.config.js"
      },
      "configurations": {
        "development": {
          "optimization": false,
          "sourceMap": true
        },
        "production": {
          "optimization": true,
          "extractLicenses": true,
          "inspect": false,
          "sourceMap": false
        }
      }
    },
```

**New:**
```json
    "build": {
      "executor": "nx:run-commands",
      "outputs": ["{workspaceRoot}/dist/apps/event-store-service"],
      "defaultConfiguration": "production",
      "options": {
        "command": "bash tools/build/build-service.sh event-store-service"
      },
      "configurations": {
        "development": {},
        "production": {}
      }
    },
```

- [ ] **Step 3: Build all 14 services and verify**

Build each service one at a time and verify:

```bash
for svc in admin-api-service gateway-api config-service sensor-service event-store-service farm-service billing-service hr-service notification-service messaging-service observability-service alert-engine hydroponics-service ai-service; do
  echo "=== Building $svc ==="
  bash tools/build/build-service.sh "$svc"
  echo ""
done
```

Expected: `BUILD OK: {service}` for all 14 services.

Verify no unresolved @platform imports across all dist:
```bash
grep -r "@platform/\|@aquaculture/" dist/apps/ --include="*.js" | head -10
```

Expected: zero matches.

- [ ] **Step 4: Commit batch migration**

```bash
git add apps/*/tsconfig.build.json apps/*/project.json
git commit -m "build: migrate all 15 backend services from webpack to tsc"
```

---

### Task 4: Revert Webpack Workarounds

**Files:**
- Modify: `apps/admin-api-service/src/guards/platform-admin.guard.ts`
- Modify: `apps/admin-api-service/src/app.module.ts`
- Modify: `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts`
- Modify: `apps/auth-service/src/app.module.ts`
- Modify: `apps/farm-service/src/common/guards/gql-auth.guard.ts`
- Modify: `apps/hr-service/src/common/guards/gql-auth.guard.ts`
- Modify: `apps/observability-service/src/guards/internal-api.guard.ts`
- Modify: `apps/gateway-api/src/guards/tenant-isolation.guard.ts`

- [ ] **Step 1: Revert admin-api-service PlatformAdminGuard @Inject()**

In `apps/admin-api-service/src/guards/platform-admin.guard.ts`, replace:

**Old:**
```typescript
  // IMPORTANT: Explicit @Inject() decorators required for webpack compatibility.
  // Webpack's tree-shaking can strip TypeScript's design:paramtypes metadata,
  // causing NestJS DI to see [null, null, null] instead of actual class refs.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {
```

**New:**
```typescript
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
```

Also remove the `@Inject` import if it's only used here. Check if `Inject` is used elsewhere in the file — if not, remove it from the import statement.

- [ ] **Step 2: Revert admin-api-service app.module.ts useFactory**

In `apps/admin-api-service/src/app.module.ts`, replace:

**Old:**
```typescript
    // IMPORTANT: useFactory + inject bypasses webpack's broken design:paramtypes
    // metadata. useClass relies on decorator metadata which webpack can strip.
    // This pattern matches gateway-api's AuthGuard registration.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService, jwtService: JwtService) =>
        new PlatformAdminGuard(reflector, configService, jwtService),
      inject: [Reflector, ConfigService, JwtService],
    },
```

**New:**
```typescript
    {
      provide: APP_GUARD,
      useClass: PlatformAdminGuard,
    },
```

Also clean up unused imports: remove `Reflector`, `ConfigService`, `JwtService` from the module's import statements **only if** they are no longer referenced in `app.module.ts`. Check before removing.

- [ ] **Step 3: Revert auth-service JwtAuthGuard @Inject()**

In `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts`, replace:

**Old:**
```typescript
  // IMPORTANT: Explicit @Inject() for webpack compatibility (design:paramtypes strip).
  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
  ) {
```

**New:**
```typescript
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
  ) {
```

Note: `@Optional() @Inject(TOKEN_BLACKLIST)` stays — this is NOT a webpack workaround. `TOKEN_BLACKLIST` is a custom injection token (not a class), so `@Inject()` is required for NestJS to resolve it. Only remove `@Inject()` from class-based dependencies (JwtService, Reflector, ConfigService).

- [ ] **Step 4: Revert auth-service app.module.ts useFactory**

In `apps/auth-service/src/app.module.ts`, replace:

**Old:**
```typescript
    // SECURITY: Global JWT auth guard — useFactory bypasses webpack metadata stripping.
    // useClass relies on design:paramtypes which webpack can strip during bundling.
    {
      provide: APP_GUARD,
      useFactory: (jwtService: JwtService, reflector: Reflector, configService: ConfigService, tokenBlacklist?: ITokenBlacklist) =>
        new JwtAuthGuard(jwtService, reflector, configService, tokenBlacklist),
      inject: [JwtService, Reflector, ConfigService, { token: TOKEN_BLACKLIST, optional: true }],
    },
```

**New:**
```typescript
    // SECURITY: Global JWT auth guard
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
```

Clean up unused imports from the module file (JwtService, Reflector, ConfigService, TOKEN_BLACKLIST, ITokenBlacklist) **only if** they are no longer referenced elsewhere in `app.module.ts`.

- [ ] **Step 5: Revert farm-service GqlAuthGuard @Inject()**

In `apps/farm-service/src/common/guards/gql-auth.guard.ts`, replace:

**Old:**
```typescript
  // IMPORTANT: Explicit @Inject() for webpack compatibility (design:paramtypes strip).
  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
```

**New:**
```typescript
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}
```

- [ ] **Step 6: Revert hr-service GqlAuthGuard @Inject()**

In `apps/hr-service/src/common/guards/gql-auth.guard.ts`, replace:

**Old:**
```typescript
  // IMPORTANT: Explicit @Inject() for webpack compatibility (design:paramtypes strip).
  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
```

**New:**
```typescript
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}
```

- [ ] **Step 7: Revert observability-service InternalApiGuard @Inject()**

In `apps/observability-service/src/guards/internal-api.guard.ts`, replace:

**Old:**
```typescript
  // IMPORTANT: Explicit @Inject() for webpack compatibility (design:paramtypes strip).
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
```

**New:**
```typescript
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {
```

- [ ] **Step 8: Revert gateway-api TenantIsolationGuard @Inject()**

In `apps/gateway-api/src/guards/tenant-isolation.guard.ts`, replace:

**Old:**
```typescript
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
```

**New:**
```typescript
  constructor(private readonly reflector: Reflector) {}
```

Also replace the class-level comment:

**Old:**
```typescript
 * NOTE: Explicit @Inject() decorators are required because Nx webpack (SWC loader)
 * strips TypeScript emitDecoratorMetadata (design:paramtypes) during bundling.
```

**New:**
```typescript
 * Enforces strict tenant isolation across all requests.
```

- [ ] **Step 9: Rebuild all services and verify**

```bash
for svc in auth-service admin-api-service gateway-api farm-service hr-service observability-service; do
  echo "=== Rebuilding $svc ==="
  bash tools/build/build-service.sh "$svc"
done
```

Expected: `BUILD OK` for all 6 modified services.

- [ ] **Step 10: Commit workaround reverts**

```bash
git add apps/admin-api-service/src/guards/platform-admin.guard.ts \
        apps/admin-api-service/src/app.module.ts \
        apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts \
        apps/auth-service/src/app.module.ts \
        apps/farm-service/src/common/guards/gql-auth.guard.ts \
        apps/hr-service/src/common/guards/gql-auth.guard.ts \
        apps/observability-service/src/guards/internal-api.guard.ts \
        apps/gateway-api/src/guards/tenant-isolation.guard.ts
git commit -m "fix: revert webpack DI workarounds — tsc preserves decorator metadata"
```

---

### Task 5: Update Dockerfile

**Files:**
- Modify: `infrastructure/docker/Dockerfile.backend`

- [ ] **Step 1: Update builder stage to use build script directly**

In `infrastructure/docker/Dockerfile.backend`, replace:

**Old (lines 47-63):**
```dockerfile
COPY apps/ ./apps/
COPY libs/ ./libs/
COPY platform/ ./platform/

# Build argument for service name
ARG SERVICE_NAME

# Build the specific service using NX
# Increase Node memory limit for large builds (sensor-service has 1.4MB bundle)
# Use NX cache mount for incremental builds
# Disable NX Cloud in Docker to prevent connection timeouts that hang builds
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV NX_NO_CLOUD=true
ENV NX_CLOUD_ACCESS_TOKEN=""
ENV NX_DAEMON=false
RUN --mount=type=cache,target=/app/.nx/cache,sharing=shared \
    npx nx build ${SERVICE_NAME}
```

**New:**
```dockerfile
COPY apps/ ./apps/
COPY libs/ ./libs/
COPY platform/ ./platform/
COPY tools/ ./tools/

# Build argument for service name
ARG SERVICE_NAME

# Build the specific service using direct tsc compilation
# WHY: Webpack breaks NestJS decorator metadata. Direct tsc is correct and faster.
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN bash tools/build/build-service.sh ${SERVICE_NAME}
```

- [ ] **Step 2: Verify Dockerfile.backend.simple needs no changes**

Read `infrastructure/docker/Dockerfile.backend.simple` and confirm:
- Line 39: `COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist` — copies pre-built output
- Line 59: `CMD ["node", "dist/main.js"]` — entry shim makes this work

No changes needed for the simple Dockerfile.

- [ ] **Step 3: Update nx.json build inputs to include lib sources**

With tsc, each service compiles its lib dependencies inline. NX needs to know about lib source files for correct cache invalidation — otherwise a lib change won't trigger service rebuilds.

In `nx.json`, replace:

**Old:**
```json
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
      "!{projectRoot}/tsconfig.spec.json",
      "!{projectRoot}/jest.config.[jt]s",
      "!{projectRoot}/.eslintrc.json",
      "!{projectRoot}/src/test-setup.[jt]s"
    ],
    "sharedGlobals": []
  },
```

**New:**
```json
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
      "!{projectRoot}/tsconfig.spec.json",
      "!{projectRoot}/jest.config.[jt]s",
      "!{projectRoot}/.eslintrc.json",
      "!{projectRoot}/src/test-setup.[jt]s"
    ],
    "sharedGlobals": [
      "{workspaceRoot}/libs/*/src/**/*.ts",
      "{workspaceRoot}/platform/libs/*/src/**/*.ts",
      "{workspaceRoot}/tsconfig.base.json"
    ]
  },
```

This adds lib source files and `tsconfig.base.json` to `sharedGlobals`, which is included in every project's `default` input. When any lib source changes, all dependent service builds are invalidated.

- [ ] **Step 4: Commit Dockerfile + nx.json updates**

```bash
git add infrastructure/docker/Dockerfile.backend nx.json
git commit -m "build(docker,nx): tsc build script in Docker + lib inputs for NX cache"
```

---

### Task 6: Delete Webpack Infrastructure

**Files to delete:**
- `tools/webpack/nestjs-base.config.js`
- `apps/auth-service/webpack.config.js`
- `apps/admin-api-service/webpack.config.js`
- `apps/gateway-api/webpack.config.js`
- `apps/config-service/webpack.config.js`
- `apps/sensor-service/webpack.config.js`
- `apps/event-store-service/webpack.config.js`
- `apps/farm-service/webpack.config.js`
- `apps/billing-service/webpack.config.js`
- `apps/hr-service/webpack.config.js`
- `apps/notification-service/webpack.config.js`
- `apps/messaging-service/webpack.config.js`
- `apps/observability-service/webpack.config.js`
- `apps/alert-engine/webpack.config.js`
- `apps/hydroponics-service/webpack.config.js`
- `apps/ai-service/webpack.config.js`

**Modify:** `package.json` (remove `@nx/webpack`, `tsconfig-paths-webpack-plugin`)

- [ ] **Step 1: Delete all webpack config files**

```bash
rm apps/auth-service/webpack.config.js \
   apps/admin-api-service/webpack.config.js \
   apps/gateway-api/webpack.config.js \
   apps/config-service/webpack.config.js \
   apps/sensor-service/webpack.config.js \
   apps/event-store-service/webpack.config.js \
   apps/farm-service/webpack.config.js \
   apps/billing-service/webpack.config.js \
   apps/hr-service/webpack.config.js \
   apps/notification-service/webpack.config.js \
   apps/messaging-service/webpack.config.js \
   apps/observability-service/webpack.config.js \
   apps/alert-engine/webpack.config.js \
   apps/hydroponics-service/webpack.config.js \
   apps/ai-service/webpack.config.js

rm tools/webpack/nestjs-base.config.js
rmdir tools/webpack
```

- [ ] **Step 2: Remove @nx/webpack from devDependencies**

```bash
npm uninstall @nx/webpack
```

Check if `tsconfig-paths-webpack-plugin` is installed and remove it:
```bash
npm ls tsconfig-paths-webpack-plugin 2>/dev/null && npm uninstall tsconfig-paths-webpack-plugin || echo "not installed"
```

- [ ] **Step 3: Verify no webpack references remain**

```bash
grep -r "webpack" apps/*/project.json
grep -r "webpack" tools/
```

Expected: zero matches for both.

- [ ] **Step 4: Commit webpack cleanup**

```bash
git add -A apps/*/webpack.config.js tools/webpack/ package.json package-lock.json
git commit -m "build: remove all webpack infrastructure — tsc migration complete"
```

---

### Task 7: Update package.json Build Scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add missing services to build:backend**

In `package.json`, the `build:backend` script is missing `messaging-service` and `ai-service`. Replace:

**Old:**
```json
    "build:backend": "nx run-many --target=build --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,billing-service,hr-service,hydroponics-service,notification-service,admin-api-service,config-service,event-store-service,observability-service",
```

**New:**
```json
    "build:backend": "nx run-many --target=build --projects=gateway-api,auth-service,farm-service,sensor-service,alert-engine,billing-service,hr-service,hydroponics-service,notification-service,admin-api-service,config-service,event-store-service,observability-service,messaging-service,ai-service",
```

- [ ] **Step 2: Commit script update**

```bash
git add package.json
git commit -m "build: add messaging-service and ai-service to build:backend script"
```

---

### Task 8: Full Build and Docker Verification

- [ ] **Step 1: Clean all dist and rebuild everything**

```bash
rm -rf dist/apps/
npm run build:backend
```

Expected: all 15 services build successfully with `BUILD OK` messages.

- [ ] **Step 2: Verify zero unresolved path aliases**

```bash
grep -r "@platform/\|@aquaculture/" dist/apps/ --include="*.js" | wc -l
```

Expected: `0`

- [ ] **Step 3: Verify all entry shims exist**

```bash
for svc in gateway-api auth-service farm-service sensor-service alert-engine billing-service hr-service hydroponics-service notification-service admin-api-service config-service event-store-service observability-service messaging-service ai-service; do
  if [ -f "dist/apps/$svc/main.js" ]; then
    echo "OK: $svc"
  else
    echo "MISSING: $svc"
  fi
done
```

Expected: `OK` for all 15 services.

- [ ] **Step 4: Docker build test (one service)**

```bash
DOCKER_BUILDKIT=1 docker build \
  -f infrastructure/docker/Dockerfile.backend \
  --build-arg SERVICE_NAME=auth-service \
  -t aqua-auth-service:tsc-test \
  .
```

Expected: build succeeds.

```bash
docker run --rm aqua-auth-service:tsc-test ls -la dist/main.js
```

Expected: `main.js` entry shim exists.

```bash
docker run --rm aqua-auth-service:tsc-test node --check dist/main.js
```

Expected: syntax check passes (exit code 0).

- [ ] **Step 5: Docker simple build test**

```bash
DOCKER_BUILDKIT=1 docker build \
  -f infrastructure/docker/Dockerfile.backend.simple \
  --build-arg SERVICE_NAME=auth-service \
  -t aqua-auth-service:simple-test \
  .
```

Expected: build succeeds. `CMD ["node", "dist/main.js"]` will work because entry shim exists at `dist/main.js`.

- [ ] **Step 6: Commit verification (no file changes — this is a check step)**

If all checks pass, no commit needed. If any service failed, fix and rebuild before proceeding.

---

### Task 9: Final Commit and Push

- [ ] **Step 1: Verify git status is clean**

```bash
git status
git log --oneline -5
```

Expected commits (newest first):
1. `build: add messaging-service and ai-service to build:backend script`
2. `build: remove all webpack infrastructure — tsc migration complete`
3. `build(docker): use direct tsc build script instead of nx+webpack`
4. `fix: revert webpack DI workarounds — tsc preserves decorator metadata`
5. `build: migrate all 15 backend services from webpack to tsc`

- [ ] **Step 2: Push to current branch**

```bash
git push
```

---

## File Inventory

| Action | Count | Files |
|--------|-------|-------|
| Create | 16 | `tools/build/build-service.sh` + 15x `apps/*/tsconfig.build.json` |
| Modify | 24 | 15x `apps/*/project.json` + 6 guard files + 2 app.module files + `Dockerfile.backend` + `package.json` |
| Delete | 17 | 15x `apps/*/webpack.config.js` + `tools/webpack/nestjs-base.config.js` + `tools/webpack/` dir |

## Dependency Changes

| Action | Package | Type |
|--------|---------|------|
| Add | `tsc-alias` | devDependency |
| Remove | `@nx/webpack` | devDependency |
| Remove | `tsconfig-paths-webpack-plugin` | devDependency (if present) |
