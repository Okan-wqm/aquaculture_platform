import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BypassRlsService } from './bypass-rls.service';
import { createRlsConnectionBootstrap } from './rls-connection-bootstrap.service';
import {
  RlsSchemaBootstrap,
  RlsSchemaBootstrapOptions,
} from './rls-schema-bootstrap.service';
import {
  TenantRlsSyncService,
  TenantRlsSyncOptions,
} from './tenant-rls-sync.service';
import { TenantRlsService } from './tenant-rls.service';

/**
 * RlsModule
 * ============================================================================
 *
 * One-line wiring for tenant Row-Level Security in any global-schema service.
 *
 * # What you get from `forRoot()`
 *
 * 1. **`RlsConnectionBootstrap`** — pg pool patch that injects
 *    `app.current_tenant` and `app.bypass_rls` GUCs on every connection
 *    checkout, sourced from AsyncLocalStorage. This is the runtime half
 *    that makes the policies installed by `applyTenantRlsToSchema`
 *    actually consult the right tenant.
 *
 * 2. **`RlsSchemaBootstrap`** (when `autoApply` is enabled) — startup-time
 *    installer that runs `applyTenantRlsToSchema` against the service's
 *    schema during `OnApplicationBootstrap`. This is how services without
 *    a TypeORM migration runner (billing, ai, notification, alert,
 *    config, event-store) get policies created at all. Idempotent: each
 *    restart re-installs the canonical predicate so predicate fixes ship
 *    on the next deploy.
 *
 * 3. **`BypassRlsService`** — scoped, audited bypass for SUPER_ADMIN
 *    endpoints, background workers, and any legitimately cross-tenant
 *    code path.
 *
 * 4. **`TenantRlsService`** — table-level helpers used by ad-hoc admin
 *    tools. Re-exported here so a service module only needs to import
 *    `RlsModule` once.
 *
 * # Usage — service WITHOUT migration runner (most global services)
 *
 * ```ts
 * import { RlsModule } from '@aquaculture/backend-common';
 *
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *     RlsModule.forRoot({
 *       serviceName: 'billing',
 *       autoApply: true,
 *       excludeTables: ['billing_outbox'],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * # Usage — service WITH migration runner (farm, sensor, hr, messaging)
 *
 * Skip `autoApply` and write a regular TypeORM migration that calls
 * `applyTenantRlsToSchema(qr, ...)` directly. The pool patch is still
 * needed at runtime, so you still register the module:
 *
 * ```ts
 * RlsModule.forRoot({ serviceName: 'farm' })
 * // (no autoApply — the migration handles policy installation)
 * ```
 *
 * # Registration is explicit; consumption is global-within-service
 *
 * Each service MUST call `RlsModule.forRoot(...)` in its AppModule —
 * there is no auto-registration. This guarantees the "I forgot to wire
 * RLS into the new service" class of incidents is caught at service
 * setup time (the pool patch would never get applied otherwise).
 *
 * Once a service HAS registered the module, however, the `BypassRlsService`
 * and `TenantRlsService` it exports are `global: true` within that
 * service's module tree — feature modules can inject them without
 * re-importing RlsModule. This is deliberate: BypassRlsService has no
 * per-service configuration (audit label is caller-supplied) and
 * requiring every submodule that needs it to thread RlsModule through
 * its imports graph creates import-order hazards and `Nest can't resolve
 * dependencies` errors with no architectural payoff.
 */

/**
 * Options accepted by `RlsModule.forRoot()`.
 *
 * Combines wiring concerns (`serviceName`) with the helper's options
 * (`excludeTables`, `tenantIdColumns`) and the auto-apply switch.
 */
export interface RlsModuleOptions {
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
   * Defaults to `false` for backward compatibility — existing
   * registrations of `RlsModule.forRoot()` continue to work without
   * changes. Enable explicitly for farm-service, hr-service,
   * sensor-service, and any other schema-per-tenant service that
   * wants tenant-table RLS as defense-in-depth.
   */
  syncTenantSchemas?: boolean;
}

@Module({})
export class RlsModule {
  /**
   * Wire RLS into the host service.
   *
   * @param options See `RlsModuleOptions`. Pass at minimum the
   *                `serviceName`; enable `autoApply` for services that
   *                lack a TypeORM migration runner.
   */
  static forRoot(options: RlsModuleOptions): DynamicModule {
    // Build the service-specific bootstrap class. The factory enforces
    // the identifier shape (no need to validate again here) and emits a
    // distinct logger context per service tag.
    const RlsConnectionBootstrap: Type<unknown> =
      createRlsConnectionBootstrap(options.serviceName);

    // Mandatory providers — the pool patch and the table-level helpers.
    // These are the bare minimum every service that imports the module
    // gets, irrespective of `autoApply`.
    const providers: Provider[] = [
      // Listed first so the @Module() factory wires it first; pool
      // patching must complete before any code uses the DataSource.
      RlsConnectionBootstrap,
      BypassRlsService,
      TenantRlsService,
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
      // Re-export the bypass + table helpers so feature modules can
      // inject them without re-importing RlsModule. The bootstraps
      // intentionally stay internal — nothing outside this module
      // should call them.
      exports: [BypassRlsService, TenantRlsService],
    };
  }
}
