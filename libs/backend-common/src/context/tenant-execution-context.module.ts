import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { TenantExecutionContextInterceptor } from './tenant-execution-context.interceptor';

/**
 * SSoT registration of {@link TenantExecutionContextInterceptor} as a global
 * `APP_INTERCEPTOR`.
 *
 * Every tenant-scoped service — one that patches the pg pool for per-tenant
 * search_path routing via `createTenantConnectionBootstrap(<src>)` — imports
 * THIS module exactly once instead of hand-copying a `{ provide:
 * APP_INTERCEPTOR, useClass: TenantExecutionContextInterceptor }` provider
 * block into its own AppModule. One import line, one source of truth, no
 * per-service drift.
 *
 * # Why the interceptor is mandatory for these services
 *
 * `TenantSchemaMiddleware` seeds the tenant schema into AsyncLocalStorage with
 * `requestContextStorage.run(store, () => next())`. That `run()` scope only
 * reliably covers the Express middleware chain. Apollo GraphQL resolver
 * execution and the CQRS QueryBus insert async boundaries BEFORE TypeORM
 * checks out a pg connection; on those hops the middleware-seeded context can
 * be gone, so `TenantConnectionBootstrap` reads an empty context at checkout
 * and falls back to `SET search_path TO "<src>", public` — the source/template
 * schema. The query then runs against the wrong (empty or template) schema:
 * tenant rows intermittently "disappear" and template rows surface as phantom
 * data. The interceptor re-enters `withTenantContext(tenantId, ...)` AROUND the
 * resolver/handler pipeline, so the validated tenant is always present in
 * AsyncLocalStorage at pg checkout regardless of how many async hops run.
 *
 * Registration is enforced by
 * `tests/invariants/tenant-execution-context-registered.spec.ts`.
 */
@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantExecutionContextInterceptor,
    },
  ],
})
export class TenantExecutionContextModule {}
