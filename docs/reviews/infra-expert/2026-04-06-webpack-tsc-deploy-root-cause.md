---
name: infra-expert
description: Root-cause investigation of decorator metadata failure in Docker production after webpack→tsc migration
model: sonnet
effort: max
---

# CI/CD & Docker Root Cause Audit — Decorator Metadata Failure in Production

You are investigating a critical deploy failure. NestJS Dependency Injection produces
`dependencies: [null, null, null]` for guards in Docker production (Alpine, `npm ci --omit=dev`)
but works correctly in the CI build runner (Ubuntu glibc, full `node_modules`).
The webpack→tsc migration is the boundary commit. Your mandate is to find the ROOT CAUSE
— not to add `@Inject()` decorators, but to understand why `design:paramtypes` metadata
that is correctly emitted by tsc is not surviving into the production container.

## Operating Mode

REVIEWER ONLY. Do not edit files. Do not commit.

Output: `docs/reviews/infra-expert/2026-04-06-webpack-tsc-deploy-root-cause-findings.md`

## What Is Already Known

1. `tsc` with `emitDecoratorMetadata: true` correctly emits `__metadata("design:paramtypes", [...])` — verified in compiled JS on the CI runner.
2. Locally (Ubuntu glibc, full `node_modules`) the service starts without DI errors.
3. In Docker production (Alpine musl, `npm ci --omit=dev --ignore-scripts`, `node:22.12.0-alpine3.20`) guards fail with `dependencies: [null, null, null]`.
4. A PATCH was applied (commit after `14a09c60`): `@Inject()` decorators added back to guard constructors, `useClass` changed to `useFactory+inject` for APP_GUARD registrations. This treats the symptom only.

The PATCH comment in `apps/gateway-api/src/app.module.ts` currently reads:
> "useFactory with explicit inject array bypasses webpack's stripping of TypeScript emitDecoratorMetadata. This is the NestJS-recommended pattern for webpack-bundled production builds where design:paramtypes metadata is unavailable at runtime."

This comment is factually wrong for the tsc build — tsc does not strip metadata. The comment describes the old webpack problem. If the PATCH is working, something in the pipeline IS silently stripping metadata. Find it.

## Investigation Scope

### 1. The Build Pipeline Artifact Path

Trace the exact chain from tsc source code to running container byte-for-byte:

- `/var/aqua-saas/tools/build/build-service.sh` — the tsc build script
- `apps/gateway-api/project.json` — NX build target (executor: `nx:run-commands`)
- `.github/workflows/deploy-digitalocean.yml` — `build-backend-artifacts` job
- `infrastructure/docker/Dockerfile.backend.simple` — the production image

Answer these questions:

**Q1. tsc-alias and metadata strips.**
`build-service.sh` runs `tsc` then `tsc-alias`. Does `tsc-alias` rewrite `__metadata(...)` calls? Specifically: does it touch any `Reflect.metadata` or `__metadata` lines while rewriting path aliases? Check the tsc-alias source or documentation for known edge cases with decorator metadata.

**Q2. The entry shim and rootDir layout.**
The script creates a shim `dist/main.js` → `require('./apps/{svc}/src/main')`. With `rootDir: ../..` (workspace root), tsc emits to `dist/apps/{svc}/apps/{svc}/src/`. Verify the shim path in `build-service.sh` line 35 resolves correctly for every service. A wrong shim that loads a different copy of the service would silently bypass all correctly emitted metadata.

**Q3. NX cache correctness.**
The NX cache key is `nx-deploy-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}`. The `namedInputs.sharedGlobals` in `nx.json` includes `libs/*/src/**/*.ts` and `platform/libs/*/src/**/*.ts` but NOT `tsconfig.base.json` — wait, it does include `tsconfig.base.json`. But does it include `tools/build/build-service.sh` or `apps/*/tsconfig.build.json`?

If the NX cache serves a pre-tsc-migration artifact (built with webpack) because the cache key did not include the `project.json` build command or `tsconfig.build.json`, then the Docker image is built from a webpack bundle. Webpack bundles do not preserve `__metadata` calls by default unless babel-plugin-transform-typescript with specific options is used.

Verify: does NX `build` cache invalidate when `project.json` changes? Does it invalidate when `tsconfig.build.json` changes? Does it invalidate when `build-service.sh` changes?

Check `nx.json` `targetDefaults.build.inputs` — it uses `["production", "^production"]`. Check what `production` namedInput includes. Does it include `{projectRoot}/project.json`? Does it include `tools/build/**`?

**Q4. GitHub Actions NX cache vs. Docker BuildKit cache.**
Two independent caches exist:
- GitHub Actions `actions/cache` for `.nx/cache` (key: `nx-deploy-Linux-{lockfile-hash}`)
- Docker BuildKit registry cache (`mode=max`, `type=registry`)

The Docker BuildKit cache caches Docker layers — including the `COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist` layer. If the NX build correctly rebuilds but the Docker layer cache serves the OLD dist from before the migration, the container runs the old webpack bundle.

Analyze the cache-from/cache-to strategy for `build-backend-images` job. When does the `COPY dist/...` layer invalidate? What is the cache key for that layer? If the pre-built artifacts are copied after `npm ci` (which has its own stable cache), does Docker correctly bust the artifact layer when the dist content changes?

**Q5. `--omit=dev` and `reflect-metadata`.**
The Dockerfile runs `npm ci --omit=dev`. The `reflect-metadata` package is required at runtime for `Reflect.metadata()` and `Reflect.getMetadata()` to exist. Verify: is `reflect-metadata` in `dependencies` (not `devDependencies`) in `package.json`? If it is in `devDependencies`, it is excluded by `--omit=dev` and the production container will silently swallow metadata calls without error.

Run: check `package.json` for `reflect-metadata` under `dependencies` vs. `devDependencies`.

Also check: does `apps/{svc}/src/main.ts` (or the shared bootstrap) import `reflect-metadata` before any NestJS module is loaded? With tsc's CommonJS output, import order matters. If the shim `dist/main.js` requires `./apps/{svc}/src/main` and that file does not start with `import 'reflect-metadata'`, metadata calls may fail silently.

**Q6. Alpine musl vs. glibc — `tslib` and helper injection.**
`tsconfig.base.json` has `"importHelpers": true`. This means tsc emits `const tslib_1 = require("tslib")` instead of inlining `__decorate` and `__metadata`. Verify: is `tslib` in `dependencies` (not `devDependencies`)? If it is a devDependency, `--omit=dev` removes it and every `__metadata` call silently becomes a no-op (because `tslib_1.__metadata` is undefined — no error thrown, DI just receives `null`).

This is the most likely root cause. Check `package.json` for `tslib` classification.

**Q7. `--ignore-scripts` and native modules.**
The Dockerfile uses `--ignore-scripts`. Some packages that NestJS guards depend on (e.g., `bcrypt`, `argon2`) require native node addons compiled via `node-gyp`. If `--ignore-scripts` skips compilation and the Alpine musl libc ABI is incompatible with pre-compiled glibc binaries (from the CI runner artifact), the module fails to load at require time. Would a failed require of a guard's constructor dependency cause NestJS DI to resolve it as `null`?

### 2. The Dockerfile

Read `infrastructure/docker/Dockerfile.backend.simple` in full.

- Line 35: `npm ci --legacy-peer-deps --omit=dev --ignore-scripts --no-audit` — confirm `--omit=dev` is present.
- Line 39: `COPY --chown=nestjs:nodejs dist/apps/${SERVICE_NAME} ./dist` — note the target is `./dist` (not `./dist/apps/...`). The build shim expects `node dist/main.js`. But the shim in dist root requires `./apps/${SERVICE_NAME}/src/main`. If the COPY puts things at `./dist/apps/gateway-api/src/...` then `./dist/main.js` → `require('./apps/gateway-api/src/main')` resolves to `./dist/apps/gateway-api/src/main.js`. This is correct IF the shim is at `./dist/main.js`. Verify the shim is indeed in `dist/apps/{svc}/main.js` (copied to `./dist/main.js` in the container), not at `dist/apps/{svc}/apps/{svc}/src/main.js`. Trace the full path.

### 3. The NX Cache Configuration

Read `nx.json` in full.

- `namedInputs.sharedGlobals` includes `{workspaceRoot}/tsconfig.base.json` — good.
- Does `namedInputs.production` include `{projectRoot}/project.json`? If not, changing the build executor command in `project.json` (switching from webpack to tsc via `build-service.sh`) does NOT invalidate the NX cache. A cached webpack artifact gets promoted to the Docker image.
- Does `sharedGlobals` include `tools/build/build-service.sh`? If not, changing the build script doesn't bust the cache.

### 4. The Deploy Script

Read `.github/workflows/deploy-digitalocean.yml` `build-backend-artifacts` job (lines 258–397).

- Line 381: `npx nx run-many -t build --projects="${PROJECTS}" --parallel=3` — this is the build command. Verify NX_NO_CLOUD=true and NX_DAEMON=false are set (they are). But is `NX_SKIP_NX_CACHE` set? If not, NX may use a stale cache.
- Confirm the artifact upload at line 392 uploads `dist/` — does this include `dist/apps/*/main.js` (the shim)? The shim is generated by the build script inside `dist/apps/{svc}/main.js`. Does the GitHub Actions artifact upload include it?

## Required Findings Format

For each finding:

```
ID: INFRA-{N}
Severity: CRITICAL | HIGH | MEDIUM | LOW
Title: One-line description
Root Cause: Exact mechanism — why this causes null dependencies in Docker production
Evidence: File path + line number + content
Fix: Architectural solution (not a patch):
  - What to change
  - Where
  - Why this is the correct fix, not a workaround
Verification: How to confirm the fix works in Docker production (not just locally)
```

## Definition of "Architectural Solution"

An architectural solution for this class of problem means:

1. The tsc build emits `__metadata` correctly AND
2. All runtime packages required for metadata reflection (`reflect-metadata`, `tslib`) are in `dependencies` (not `devDependencies`) AND
3. `reflect-metadata` is imported before any NestJS bootstrap code in every service entry point AND
4. The NX cache correctly invalidates when any build input changes (tsconfig, build script, project.json) AND
5. The Docker BuildKit cache correctly busts when the compiled artifacts change

**NOT an architectural solution:**
- Adding `@Inject()` to every constructor (this is a workaround for webpack, not needed for tsc)
- Using `useFactory+inject` instead of `useClass` for APP_GUARD (same — webpack workaround)
- Disabling NX cache entirely (performance regression, not root cause fix)

## Cross-Domain Handoff

If you find that the root cause is in application-level code (e.g., `reflect-metadata` import missing from `main.ts` files), flag for `auth-security-expert` (guards) and the relevant domain agents. If the root cause is in NX cache inputs, flag for the orchestrator to trigger a cache-busting strategy.
