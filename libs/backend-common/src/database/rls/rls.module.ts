import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BypassRlsService } from './bypass-rls.service';
import { createRlsConnectionBootstrap } from './rls-connection-bootstrap.service';
import {
  RlsSchemaBootstrap,
  RlsSchemaBootstrapOptions,
} from './rls-schema-bootstrap.service';
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
 * # Module-scoped, not global
 *
 * `RlsModule` is **NOT** registered as global. Each service explicitly
 * imports it because the bootstrap is parametrised with a service name
 * (for log readability) and because making security infrastructure
 * globally implicit is exactly the kind of magic that produces the "I
 * forgot to wire RLS into the new service" class of incidents.
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

    return {
      module: RlsModule,
      providers,
      // Re-export the bypass + table helpers so feature modules can
      // inject them without re-importing RlsModule. The bootstraps
      // intentionally stay internal — nothing outside this module
      // should call them.
      exports: [BypassRlsService, TenantRlsService],
    };
  }
}
