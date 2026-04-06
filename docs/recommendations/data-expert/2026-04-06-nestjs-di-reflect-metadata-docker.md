# Recommendation: Explicit reflect-metadata Bootstrap for All Services

**Date:** 2026-04-06
**Author:** Data Expert — Senior Data Architecture Reviewer
**Severity:** CRITICAL
**Linked Review:** `/var/aqua-saas/docs/reviews/data-expert/2026-04-06-nestjs-di-reflect-metadata-docker.md`

---

## Problem Restatement

Every NestJS service's `main.ts` relies on `@nestjs/common` or `@nestjs/core` side-effect-loading `reflect-metadata` during their barrel module evaluation. When the CommonJS module graph produces a circular dependency that causes a decorated class to evaluate before `@nestjs/common` finishes its own evaluation, `tslib.__metadata` finds `Reflect.metadata` undefined, silently no-ops, and `design:paramtypes` metadata is never written. Docker production environments expose this race; local development with devDependencies masks it.

---

## Architectural Fix

### Principle

`reflect-metadata` must be the **absolute first import** in every service entrypoint. This is a TypeScript/NestJS ecosystem requirement documented in the NestJS bootstrapping docs and the `reflect-metadata` package README. It must precede any import that could transitively touch a decorated class. There is no other reliable mechanism.

Relying on `@nestjs/common`'s internal `require("reflect-metadata")` is an implementation detail of NestJS that can and does break when module evaluation order is not deterministic — which it is not in large CommonJS graphs with circular dependencies.

### Change Required in Every `main.ts`

Add `import 'reflect-metadata';` as the first line, before all other imports. The `// WHY:` comment is mandatory per project standards.

The pattern for every service is:

```typescript
// WHY: reflect-metadata MUST be the first import. tslib.__metadata() checks
// `typeof Reflect.metadata === "function"` at decorator application time (module
// load). If reflect-metadata has not yet been loaded when any decorated class
// module evaluates (possible in production CommonJS graphs due to circular deps),
// the metadata write silently no-ops and NestJS DI sees [null, null, null] for
// design:paramtypes. Relying on @nestjs/common to side-effect-load this is
// fragile — it depends on load order which is not guaranteed in large graphs.
import 'reflect-metadata';
import { ... } from '@nestjs/common';
// ... rest of imports
```

### Files to Change

All 15 service entrypoints require this change. The files and their current first import lines are:

| File | Current First Import |
|------|---------------------|
| `apps/admin-api-service/src/main.ts` | `import { ValidationPipe, ... } from '@nestjs/common'` |
| `apps/ai-service/src/main.ts` | (requires inspection) |
| `apps/alert-engine/src/main.ts` | (requires inspection) |
| `apps/auth-service/src/main.ts` | (requires inspection) |
| `apps/billing-service/src/main.ts` | (requires inspection) |
| `apps/config-service/src/main.ts` | (requires inspection) |
| `apps/event-store-service/src/main.ts` | (requires inspection) |
| `apps/farm-service/src/main.ts` | (requires inspection) |
| `apps/hr-service/src/main.ts` | (requires inspection) |
| `apps/hydroponics-service/src/main.ts` | (requires inspection) |
| `apps/messaging-service/src/main.ts` | (requires inspection) |
| `apps/notification-service/src/main.ts` | (requires inspection) |
| `apps/observability-service/src/main.ts` | (requires inspection) |
| `apps/sensor-service/src/main.ts` | (requires inspection) |
| `apps/gateway-api/src/main.ts` | (requires inspection) |

### Exact Change for `apps/admin-api-service/src/main.ts`

Current line 1:
```typescript
import { ValidationPipe, Logger, VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
```

Change to:
```typescript
// WHY: reflect-metadata MUST be the first import. tslib.__metadata() checks
// `typeof Reflect.metadata === "function"` at decorator application time (module
// load). If reflect-metadata has not yet been loaded when any decorated class
// module evaluates (possible in production CommonJS graphs due to circular deps),
// the metadata write silently no-ops and NestJS DI sees [null, null, null] for
// design:paramtypes. Relying on @nestjs/common to side-effect-load this is
// fragile — it depends on load order which is not guaranteed in large graphs.
import 'reflect-metadata';
import { ValidationPipe, Logger, VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
```

This same pattern applies verbatim to all other `main.ts` files — insert `import 'reflect-metadata';` (with the WHY comment block) as the first executable statement.

---

## Why Other Approaches Are Rejected

### Rejected: NODE_OPTIONS=--require reflect-metadata in Dockerfile

```dockerfile
ENV NODE_OPTIONS="--require reflect-metadata"
```

This would work but violates the principle of keeping correctness in the source code. It creates an invisible runtime dependency: the service silently breaks if deployed without that environment variable (different orchestration, different Dockerfile, CI runner without the env). Source-level fix is always preferred.

### Rejected: Add reflect-metadata to tsconfig `types`

`tsconfig.build.json` already has `"types": ["node"]`. Adding `"reflect-metadata"` to `types` only makes the type declarations available — it does not cause the module to be loaded at runtime. Types and runtime loading are orthogonal in CommonJS.

### Rejected: importHelpers: false in tsconfig

Disabling `importHelpers` would inline all tslib helpers into each compiled file, eliminating the tslib `__metadata` dependency. However: (a) it bloats compiled output by duplicating helpers across every file, (b) the underlying race — `reflect-metadata` not loaded when a class decorator runs — still exists regardless of whether helpers come from tslib or are inlined. The inlined helper has the same `typeof Reflect.metadata === "function"` guard.

### Rejected: Remove emitDecoratorMetadata, use explicit @Inject everywhere

This would work architecturally (NestJS supports fully explicit `@Inject()` on every parameter without relying on `design:paramtypes`). The compiled guard already uses `@Inject()` explicitly on all three constructor parameters. However: (a) this requires auditing and updating every injectable across all 15 services and all shared libraries; (b) it removes useful type information for tooling; (c) the one-line fix is strictly less effort and zero risk.

---

## Verification

After applying the change, rebuild and verify in Docker with:

```bash
docker build -f apps/admin-api-service/Dockerfile -t admin-test .
docker run --rm admin-test node -e "
  require('./dist/apps/admin-api-service/main.js');
  const { PlatformAdminGuard } = require('./dist/apps/admin-api-service/apps/admin-api-service/src/guards/platform-admin.guard.js');
  const meta = Reflect.getMetadata('design:paramtypes', PlatformAdminGuard);
  console.log('paramtypes:', meta);
  if (!meta || meta.some(x => x === null)) process.exit(1);
"
```

Expected: `paramtypes: [ [Function: Reflector], [Function: ConfigService], [Function: JwtService] ]`

---

## Impact Assessment

- **Zero breaking changes.** Adding `import 'reflect-metadata'` as first import is additive. Node.js CommonJS `require()` is idempotent — if `reflect-metadata` was already loaded (e.g., `@nestjs/common` already loaded it), re-requiring it returns the cached module with no side effect.
- **All 15 services need the change.** The same race condition exists in every service. It manifests first in `admin-api-service` due to its guard complexity, but all services are vulnerable.
- **No tsconfig changes needed.** `emitDecoratorMetadata: true` and `experimentalDecorators: true` are already set correctly in every `tsconfig.build.json`.
- **No Dockerfile changes needed.** This is a pure source-level fix.
