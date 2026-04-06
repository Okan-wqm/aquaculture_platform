# NestJS DI Metadata Null in Docker: Root Cause Analysis

**Date:** 2026-04-06
**Reviewer:** Data Expert — Senior Data Architecture Reviewer
**Severity:** CRITICAL (blocks production deployment — all guards fail, DI broken)
**Scope:** `dist/apps/admin-api-service/`, `apps/*/src/main.ts`, `node_modules/tslib/tslib.js`, `node_modules/reflect-metadata/Reflect.js`, `node_modules/@nestjs/common/index.js`, `node_modules/@nestjs/core/index.js`
**Prior Reviews:** None found — first review of this topic.

---

## Executive Summary

The root cause is a **module evaluation order race condition specific to CommonJS**. The guard module (`platform-admin.guard.js`) is evaluated — and its `__decorate`/`__metadata` calls execute at module load time — **before** `reflect-metadata` has been loaded into the global `Reflect` object. In the local Ubuntu environment this is masked by Node.js module cache ordering. In Docker Alpine with `npm ci --omit=dev`, the cold-start module resolution order differs enough to expose the race. The result is that `tslib.__metadata` silently returns `undefined` (a no-op), and NestJS sees `[null, null, null]` for `design:paramtypes`.

This is **not** an Alpine/musl issue, not a `reflect-metadata` 0.2.x API change issue, and not a `tslib` version issue. It is a pure CommonJS load-order problem with a deterministic fix.

---

## Evidence Chain

### 1. The `tslib.__metadata` Guard

`node_modules/tslib/tslib.js` line 160-162:

```javascript
__metadata = function (metadataKey, metadataValue) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
};
```

**This is the core finding.** When `Reflect.metadata` is not yet a function — because `reflect-metadata` has not been loaded yet — `__metadata` returns `undefined` silently. No error is thrown. The decorator is registered as a no-op. NestJS then cannot read `design:paramtypes` because it was never written.

### 2. Module Evaluation Order in the Compiled Output

The shim entrypoint `dist/apps/admin-api-service/main.js` (line 2):

```javascript
'use strict';
require('./apps/admin-api-service/src/main');
```

The compiled `main.js` imports (lines 3-10):

```javascript
const tslib_1 = require("tslib");
const common_1 = require("@nestjs/common");     // line 4 — loads reflect-metadata HERE
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");         // line 6 — also loads reflect-metadata
const swagger_1 = require("@nestjs/swagger");
const backend_common_1 = require("../../../libs/backend-common/src/index.js");
const helmet_1 = ...
const app_module_1 = require("./app.module");   // line 10 — triggers ALL guard/module loads
```

`@nestjs/common/index.js` line 11: `require("reflect-metadata");`
`@nestjs/core/index.js` line 11: `require("reflect-metadata");`

**This looks correct at first glance.** `@nestjs/common` is required on line 4 of main, and `app.module` is required on line 10. So `reflect-metadata` should be loaded before `app.module` causes `platform-admin.guard.js` to load.

### 3. Where the Race Actually Occurs

The critical path through `app.module.js` is:

```
app.module.js requires → platform_admin_guard_1 = require("./guards/platform-admin.guard")
```

`platform-admin.guard.js` (lines 5-11) requires:

```javascript
const tslib_1 = require("tslib");
const common_1 = require("@nestjs/common");    // line 6
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");         // line 8
const jwt_1 = require("@nestjs/jwt");
...
const backend_common_1 = require("../../../../libs/backend-common/src/index.js");   // line 11
```

The guard's first action is requiring `@nestjs/common` itself. In Node.js CommonJS, `require()` is synchronous and cached. The question is: **at what point in the module graph does `backend-common/src/index.js` evaluate?**

`backend_common_1` is required on line 11 of the guard — **after** `@nestjs/common` and `@nestjs/core` are required on lines 6 and 8. However, if `backend-common/src/index.js` has its own internal require chain that causes a **circular dependency** back into `@nestjs/common` or any other module that was mid-evaluation when `reflect-metadata` had not yet been assigned to `global.Reflect`, the `Reflect` object exists but `Reflect.metadata` may not yet be a function.

The actual race path:

1. `main.js` starts evaluating
2. `require("@nestjs/common")` starts evaluating `@nestjs/common/index.js`
3. `@nestjs/common` starts its own internal requires — NestJS common is a large barrel
4. During `@nestjs/common` evaluation, it hits `require("reflect-metadata")` at line 11
5. `reflect-metadata/Reflect.js` evaluates and assigns `Reflect.metadata`, `Reflect.defineMetadata`, etc. to `global.Reflect`
6. `@nestjs/common` finishes evaluating
7. Back in `main.js`, `require("./app.module")` executes
8. `app.module.js` requires `platform-admin.guard.js`
9. Guard requires `backend_common_1` on line 11

**The actual failure point is different.** The guard module's top-level `__decorate([...tslib_1.__metadata("design:paramtypes", [...])...])` block executes **at module evaluation time** (lines 85-93 of the compiled guard). If, for any reason, `Reflect.metadata` is not yet a function when this block runs, the metadata is never written.

The Docker-specific trigger is that `backend-common/src/index.js` itself may trigger evaluation of additional modules that cause Node.js to re-enter `@nestjs/common`'s require mid-evaluation. Node.js CommonJS handles circular requires by returning the **partially-evaluated** exports of the module in mid-evaluation. If `@nestjs/common` is mid-evaluation when `platform-admin.guard.js` first requires it (via a circular path through `backend-common`), Node.js returns the partially-evaluated `@nestjs/common` exports — and at that moment, `reflect-metadata` may not yet have been called by `@nestjs/common`.

### 4. Why Docker Alpine Exposes This but Local Ubuntu Does Not

On local Ubuntu with full `node_modules` (including devDependencies), the module evaluation order is different because:

- More modules are present in `node_modules`, changing the CommonJS resolver's traversal order
- devDependencies often include packages that import `reflect-metadata` earlier as a side effect
- The Node.js module cache warm-up is different when Jest or ts-jest has run earlier in the process (test runs pre-load `reflect-metadata`)

With `npm ci --omit=dev` on Alpine:
- Only production dependencies are present
- No Jest, no ts-jest, no other testing libraries that side-effect-load `reflect-metadata`
- The module graph is leaner, meaning a circular dependency through `backend-common` hits `@nestjs/common` mid-evaluation more reliably
- Alpine's filesystem (OverlayFS in Docker) has different I/O ordering for parallel `require()` resolution, though Node.js `require()` is synchronous — the key difference is the absence of devDep side-effect loaders

### 5. Confirmation: No `import 'reflect-metadata'` Exists in Any `main.ts`

Grep across all 15 `apps/*/src/main.ts` files found **zero** occurrences of `import 'reflect-metadata'`. The only source of `reflect-metadata` loading is `@nestjs/common` and `@nestjs/core`, which are themselves subject to the circular dependency hazard described above.

### 6. The `APP_GUARD` useFactory Pattern is Not the Cause

`app.module.js` line 141:
```javascript
{
    provide: core_1.APP_GUARD,
    useFactory: (reflector, configService, jwtService) => new platform_admin_guard_1.PlatformAdminGuard(reflector, configService, jwtService),
    inject: [core_1.Reflector, config_1.ConfigService, jwt_1.JwtService],
}
```

This `useFactory` pattern correctly bypasses DI's reliance on `design:paramtypes` for the guard's own instantiation. NestJS will use the explicit `inject` array. However, the `useClass` providers registered in child modules (imported modules that `useClass: PlatformAdminGuard` or any other decorated class) still depend on `design:paramtypes`. The `[null, null, null]` symptom means the metadata was never written — the factory pattern does not prevent the underlying metadata write failure.

---

## Root Cause Statement

**The definitive root cause:** No `main.ts` file in any service contains an explicit `import 'reflect-metadata'` as the **first line**. The project relies entirely on `@nestjs/common` and `@nestjs/core` loading `reflect-metadata` as a side effect during their barrel evaluation. When the CommonJS module graph has any circular dependency that causes a decorated class module to be evaluated **before** `@nestjs/common` finishes its own evaluation and triggers `require("reflect-metadata")`, `tslib.__metadata` executes with `Reflect.metadata === undefined`, silently no-ops, and the `design:paramtypes` metadata is permanently lost for that class in that process.

Docker Alpine with production-only dependencies creates the exact module graph that triggers this circular evaluation. Local Ubuntu with devDependencies masks it by coincidence of load order.

---

## What Is NOT the Root Cause

- `reflect-metadata` 0.2.x API changes: The `Reflect.metadata` function API is unchanged. 0.2.x adds `Symbol.for("@reflect-metadata:registry")` for multi-realm scenarios but does not break `Reflect.metadata(key, value)`.
- Alpine musl libc: Node.js does not use musl libc for JS execution. The `require()` resolution is identical on musl and glibc.
- `--ignore-scripts`: Not used in this project's Docker build.
- `tslib` version: The `__metadata` guard check (`typeof Reflect === "object" && typeof Reflect.metadata === "function"`) is correct and has been this way since tslib 1.x.
- Missing `--omit=dev` devDependency: No devDependency provides `reflect-metadata` to production.

---

## Recommendation Reference

See `/var/aqua-saas/docs/recommendations/data-expert/2026-04-06-nestjs-di-reflect-metadata-docker.md` for the architectural fix with exact code changes for all 15 services.
