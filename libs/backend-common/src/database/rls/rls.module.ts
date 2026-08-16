import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BypassRlsService } from './bypass-rls.service';
import { createRlsConnectionBootstrap } from './rls-connection-bootstrap.service';
import { RlsSchemaBootstrap, RlsSchemaBootstrapOptions } from './rls-schema-bootstrap.service';
import { TenantRlsSyncService, TenantRlsSyncOptions } from './tenant-rls-sync.service';

/**
 * RlsModule
 * ============================================================================
 *
 * Tier-1 typed API for tenant Row-Level Security wiring.
 *
 * # Why there are two entry points (and not one `forRoot`)
 *
 * The legacy `forRoot({ serviceName })` signature had a subtle footgun: it
 * unconditionally registered `RlsConnectionBootstrap`, which constructor-
 * injects `DataSource`. A service without `TypeOrmModule.forRoot(...)` in
 * its imports graph (e.g., gateway-api) would crash at DI resolution time
 * with a cryptic `Nest can't resolve dependencies of RlsConnectionBootstrapImpl`
 * deep in the bootstrap path — exactly what the 2026-04-14 gateway-api
 * outage was (fixed site-locally in `607f9d9d`).
 *
 * Root-cause fix per CLAUDE.md architectural hierarchy:
 *
 *   - **Tier-1 at the API surface**: two distinct named static methods —
 *     `forPoolService(...)` and `forBypassOnly(...)` — make the decision
 *     structural. The service author chooses the pool-bound variant OR the
 *     bypass-only variant at import time; there is no code path that
 *     registers pool-bound providers without declaring a pool dependency.
 *
 *   - **Tier-3 runtime guard**: inside `forPoolService`, the pool bootstrap
 *     asserts the `DataSource` it receives is a usable pg pool and throws
 *     a LOUD, actionable error with remediation steps if the token was
 *     resolved from a non-pool source (or is missing a pg master). This
 *     catches edge cases NestJS DI cannot statically prove — e.g., a
 *     misconfigured `TypeOrmModule` that resolves `DataSource` to a stub.
 *
 * The two mechanisms compose: the compile-time API split prevents the
 * common case; the runtime guard catches configuration-level drift.
 *
 * # `forPoolService` — services that OWN a TypeORM DataSource
 *
 * Requires `TypeOrmModule.forRoot(...)` (or `forRootAsync(...)`) in the
 * host module's imports. Registers:
 *
 *   1. `RlsConnectionBootstrap` — pool patch that injects
 *      `app.current_tenant` + `app.bypass_rls` GUCs on every checkout,
 *      sourced from `AsyncLocalStorage`. Pairs with the
 *      `tenant_isolation_policy` installed by `applyTenantRlsToSchema`.
 *
 *   2. `BypassRlsService` — scoped, audited bypass for SUPER_ADMIN
 *      endpoints and background workers.
 *
 *   3. **(optional)** `RlsSchemaBootstrap` when `autoApply: true` — runs
 *      `applyTenantRlsToSchema` at `OnApplicationBootstrap`. Used by
 *      services WITHOUT a TypeORM migration runner (billing, ai,
 *      notification, alert, config, event-store). Services WITH a
 *      migration runner (farm, sensor, hr, messaging) install policies
 *      via a regular migration and should leave `autoApply` at its
 *      default (`false`).
 *
 *   4. **(optional)** `TenantRlsSyncService` when `syncTenantSchemas:
 *      true` — iterates every `tenant_<uuid>` schema at
 *      `OnApplicationBootstrap` and reinstalls the canonical
 *      `tenant_isolation_policy`. Required for schema-per-tenant
 *      services because `CREATE TABLE LIKE INCLUDING ALL` does NOT
 *      propagate RLS policies to tenant-cloned tables.
 *
 * ```ts
 * import { RlsModule } from '@aquaculture/backend-common';
 *
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *     RlsModule.forPoolService({
 *       serviceName: 'billing',
 *       autoApply: true,
 *       excludeTables: ['billing_outbox'],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * # `forBypassOnly` — services that need `BypassRlsService` but have NO pool
 *
 * For services that must use `BypassRlsService` (background workers,
 * impersonation auditors that call remote subgraphs, etc.) but do NOT own
 * a local TypeORM pool. Registers ONLY `BypassRlsService`.
 *
 * NOTE: Pool-less services that do NOT need bypass should not import
 * `RlsModule` at all. Gateway-api is the canonical example — it has no
 * DataSource and no rows to bypass, so it stays out of the RLS module
 * graph entirely (the commit history of `607f9d9d` and the comment
 * block in gateway-api's `app.module.ts` serve as the architectural
 * reference for this negative case).
 *
 * ```ts
 * import { RlsModule } from '@aquaculture/backend-common';
 *
 * @Module({
 *   imports: [
 *     RlsModule.forBypassOnly({ serviceName: 'some-bypass-only-service' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * # Registration is explicit; consumption is global-within-service
 *
 * Each service MUST call one of the static methods in its AppModule —
 * there is no auto-registration. This guarantees "I forgot to wire RLS
 * into the new service" is caught at service setup time.
 *
 * Once registered, the export (`BypassRlsService` in both the pool and
 * bypass-only variants) is `global: true` within that service's module tree, so
 * feature modules can inject them without re-importing `RlsModule`.
 * This is deliberate: these services have no per-service configuration
 * (audit label is caller-supplied) and requiring every submodule that
 * needs bypass to thread `RlsModule` through its imports creates
 * import-order hazards with no architectural payoff.
 */

/**
 * Options accepted by `RlsModule.forPoolService()`.
 *
 * Combines wiring concerns (`serviceName`) with the helper's options
 * (`excludeTables`, `tenantIdColumns`) and the two optional bootstraps
 * (`autoApply`, `syncTenantSchemas`).
 */
export interface RlsPoolServiceOptions {
  /**
   * Lowercase service tag used in log prefixes.
   * Must match `^[a-z][a-z0-9_-]*$`.
   * Example: `'billing'`, `'ai-service'`, `'notification'`.
   */
  serviceName: string;
  /**
   * If `true`, register `RlsSchemaBootstrap` so the helper runs at
   * `OnApplicationBootstrap` and installs policies on every cold start.
   * Use this for services that have NO TypeORM migration runner.
   *
   * Defaults to `false` — services with their own migration runner should
   * call `applyTenantRlsToSchema` from a regular migration instead, so the
   * deploy pipeline keeps a single source of truth for schema state.
   */
  autoApply?: boolean;
  /**
   * Tables to skip when discovering tenant-scoped tables. Forwarded into
   * `applyTenantRlsToSchema` and ignored when `autoApply` is false.
   * @see ApplyTenantRlsOptions.excludeTables
   */
  excludeTables?: readonly string[];
  /**
   * Override the discovered tenant column names. Defaults to
   * `['tenantId', 'tenant_id']`. Forwarded into `applyTenantRlsToSchema`
   * and ignored when `autoApply` is false.
   * @see ApplyTenantRlsOptions.tenantIdColumns
   */
  tenantIdColumns?: readonly string[];
  /**
   * If `true`, register `TenantRlsSyncService` so the helper iterates
   * every `tenant_<uuid>` schema at `OnApplicationBootstrap` and
   * installs the canonical `tenant_isolation_policy` on each.
   *
   * Required for schema-per-tenant services. The Phase 1 migration
   * pattern (running `applyTenantRlsToSchema` against `current_schema`)
   * only installs policies on the SOURCE schema's template tables —
   * production data lives in `tenant_<uuid>` tables created via
   * `CREATE TABLE LIKE INCLUDING ALL`, which does NOT copy RLS
   * policies. Without this sync, RLS is non-functional in
   * schema-per-tenant services.
   *
   * Defaults to `false`. Enable explicitly for farm-service, hr-service,
   * sensor-service, ai-service, alert-engine, hydroponics-service,
   * messaging-service, and any other schema-per-tenant service.
   */
  syncTenantSchemas?: boolean;
}

/**
 * Options accepted by `RlsModule.forBypassOnly()`.
 *
 * Deliberately narrower than `RlsPoolServiceOptions` — the bypass-only
 * variant registers no pool patch and no schema bootstrap, so the pool-
 * specific options (`autoApply`, `excludeTables`, `tenantIdColumns`,
 * `syncTenantSchemas`) are rejected at compile time.
 */
export interface RlsBypassOnlyOptions {
  /**
   * Lowercase service tag used in log prefixes.
   * Must match `^[a-z][a-z0-9_-]*$`.
   */
  serviceName: string;
}

@Module({})
export class RlsModule {
  /**
   * Wire RLS into a service that owns a TypeORM `DataSource`.
   *
   * **Prerequisite**: the host module's imports graph MUST include
   * `TypeOrmModule.forRoot(...)` (or `forRootAsync(...)`). If the
   * `DataSource` token cannot be resolved or resolves to an object
   * without a pg master pool, `RlsConnectionBootstrap.onModuleInit()`
   * throws an actionable error at boot (see runtime guard in
   * `rls-connection-bootstrap.service.ts`).
   *
   * @see RlsPoolServiceOptions
   */
  static forPoolService(options: RlsPoolServiceOptions): DynamicModule {
    // Build the service-specific bootstrap class. The factory enforces
    // the identifier shape (no need to validate again here) and emits a
    // distinct logger context per service tag.
    const RlsConnectionBootstrap: Type<unknown> = createRlsConnectionBootstrap(options.serviceName);

    // Mandatory providers — the pool patch and the table-level helpers.
    // These are the bare minimum every pool-owning service gets.
    const providers: Provider[] = [
      // Listed first so the @Module() factory wires it first; pool
      // patching must complete before any code uses the DataSource.
      RlsConnectionBootstrap,
      BypassRlsService,
    ];

    // Optional: register the startup-time installer. We construct
    // `RlsSchemaBootstrap` via `useFactory` so we can inject the
    // service-specific options object alongside the DataSource.
    if (options.autoApply === true) {
      providers.push({
        provide: RlsSchemaBootstrap,
        useFactory: (dataSource: DataSource): RlsSchemaBootstrap =>
          new RlsSchemaBootstrap(dataSource, {
            serviceName: options.serviceName,
            excludeTables: options.excludeTables,
            tenantIdColumns: options.tenantIdColumns,
          } satisfies RlsSchemaBootstrapOptions),
        inject: [DataSource],
      });
    }

    // Optional: register the per-tenant schema sweep. Schema-per-tenant
    // services need this because the Phase 1 migration only touches the
    // SOURCE schema (current_schema in migration runner context), and
    // CREATE TABLE LIKE INCLUDING ALL does NOT propagate RLS policies
    // to per-tenant copies. Without this sync, RLS is installed on
    // template tables that production never queries.
    if (options.syncTenantSchemas === true) {
      providers.push({
        provide: TenantRlsSyncService,
        useFactory: (dataSource: DataSource): TenantRlsSyncService =>
          new TenantRlsSyncService(dataSource, {
            serviceName: options.serviceName,
            excludeTables: options.excludeTables,
            tenantIdColumns: options.tenantIdColumns,
          } satisfies TenantRlsSyncOptions),
        inject: [DataSource],
      });
    }

    return {
      module: RlsModule,
      // global: true makes the exports below injectable throughout the
      // service's module tree without every feature module having to
      // re-import RlsModule. Registration itself stays explicit — this
      // only affects consumption of the already-registered providers.
      global: true,
      providers,
      // Re-export the bypass helper so feature modules can inject it
      // without re-importing RlsModule. The bootstraps intentionally
      // stay internal — nothing outside this module should call them.
      exports: [BypassRlsService],
    };
  }

  /**
   * Wire RLS into a service that needs `BypassRlsService` but has NO
   * TypeORM `DataSource`.
   *
   * Registers `BypassRlsService` only. No pool patch, no schema
   * bootstrap — nothing that constructor-injects `DataSource`. Safe to
   * use in modules without `TypeOrmModule`.
   *
   * Pool-less services that also do NOT need bypass should simply not
   * import `RlsModule` at all (gateway-api is the canonical example).
   *
   * @see RlsBypassOnlyOptions
   */
  static forBypassOnly(options: RlsBypassOnlyOptions): DynamicModule {
    // Enforce the service-name shape here too — `forBypassOnly` does
    // not go through `createRlsConnectionBootstrap`, which is where the
    // validation normally happens for the pool variant. Without this
    // check, a caller could pass `'  '` or `'Bad Name!'` and the audit
    // logs would reference a malformed tag.
    if (!/^[a-z][a-z0-9_-]*$/.test(options.serviceName)) {
      throw new Error(
        `RlsModule.forBypassOnly: invalid serviceName "${options.serviceName}" — ` +
          `must be lowercase, alphanumeric, hyphens or underscores only`,
      );
    }

    return {
      module: RlsModule,
      global: true,
      providers: [BypassRlsService],
      exports: [BypassRlsService],
    };
  }
}
