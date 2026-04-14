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
 * RlsModule — typed API
 * ============================================================================
 *
 * Two entry points, one for each shape of host service. The split is the
 * Tier-1 Make-Impossible answer to the 2026-04-14 gateway-api incident
 * where `RlsModule.forRoot({ serviceName: 'gateway' })` crashed at boot
 * with `Nest can't resolve RlsConnectionBootstrapImpl` because the host
 * module had no `DataSource` in scope.
 *
 * With the old `forRoot()`, ALL call sites looked identical — the
 * presence or absence of `TypeOrmModule` in the host's imports[] was
 * invisible at the call site. Operators had to remember "this service
 * has a pool" on every new registration; that contract was never
 * enforced and drift was inevitable.
 *
 * The split forces the caller to NAME the shape:
 *
 *   RlsModule.forPoolService({...})  // host has TypeOrmModule / DataSource
 *   RlsModule.forBypassOnly({...})   // host has NO DataSource
 *
 * Choosing between them is now an explicit architectural decision
 * captured in the call site. Mis-picking `forPoolService` in a
 * DataSource-less service still fails at DI-time (NestJS cannot
 * fabricate a DataSource), but the error text tells the operator
 * exactly what to do: switch to `forBypassOnly`.
 *
 * # `forPoolService({...})` — services with a DB pool
 *
 * Registers:
 *   - `RlsConnectionBootstrap` — pg pool patch that injects
 *     `app.current_tenant` and `app.bypass_rls` GUCs on every
 *     connection checkout, sourced from AsyncLocalStorage.
 *   - `BypassRlsService` — scoped, audited bypass for SUPER_ADMIN
 *     endpoints, background workers, and legitimately cross-tenant
 *     code paths.
 *   - `TenantRlsService` — table-level helpers used by ad-hoc admin
 *     tools. Requires `DataSource`, so it's pool-only.
 *   - `RlsSchemaBootstrap` (when `autoApply: true`) — startup-time
 *     installer for services without a migration runner.
 *   - `TenantRlsSyncService` (when `syncTenantSchemas: true`) —
 *     per-tenant schema sweep for schema-per-tenant services.
 *
 * Example (farm-service AppModule):
 * ```ts
 * RlsModule.forPoolService({
 *   serviceName: 'farm',
 *   autoApply: false,          // farm-service has a migration runner
 *   syncTenantSchemas: true,   // schema-per-tenant — sweep tenant_* schemas
 *   excludeTables: ['farm_outbox'],
 * })
 * ```
 *
 * # `forBypassOnly({...})` — services without a DB pool
 *
 * Registers:
 *   - `BypassRlsService` ONLY — the `AsyncLocalStorage` bypass primitive
 *     is pure (no DataSource), so it's safe to expose even where no
 *     TypeORM connection exists.
 *
 * No pool patch. No schema bootstrap. No tenant sync. No
 * `TenantRlsService` (it requires DataSource). If you realise you
 * actually DO need any of the pool-backed features, switch the call
 * site to `forPoolService` and add `TypeOrmModule` to imports[].
 *
 * Example (hypothetical gateway-api AppModule):
 * ```ts
 * RlsModule.forBypassOnly({
 *   serviceName: 'gateway',   // audit label only
 * })
 * ```
 *
 * # Registration is explicit; consumption is global-within-service
 *
 * Each service MUST call one of the two methods in its AppModule —
 * there is no auto-registration. Once registered, the exports below
 * are injectable throughout the service's module tree (`global: true`).
 *
 * The caller does NOT get `RlsConnectionBootstrap` or
 * `RlsSchemaBootstrap` as an inject target — those run at startup
 * via lifecycle hooks and have no code outside the module that
 * should reference them directly.
 */

/**
 * Options for `RlsModule.forPoolService()`.
 *
 * Host module MUST have a `DataSource` in scope (typically via
 * `TypeOrmModule.forRootAsync({...})`). If no `DataSource` is
 * available, NestJS DI resolution will fail at boot.
 */
export interface RlsPoolServiceOptions {
  /**
   * Lowercase service tag used in log prefixes. Must match
   * `^[a-z][a-z0-9_-]*$`. Example: `'billing'`, `'ai-service'`.
   */
  serviceName: string;
  /**
   * If `true`, register `RlsSchemaBootstrap` so
   * `applyTenantRlsToSchema` runs at `OnApplicationBootstrap` against
   * the service's source schema. Use this for services with NO
   * TypeORM migration runner (billing, ai, notification, alert,
   * config, event-store). Default: `false`.
   */
  autoApply?: boolean;
  /** Tables to skip in the discovery pass. Forwarded to both
   * `RlsSchemaBootstrap` and `TenantRlsSyncService` when enabled. */
  excludeTables?: readonly string[];
  /** Override discovered tenant column names. Defaults to
   * `['tenantId', 'tenant_id']`. */
  tenantIdColumns?: readonly string[];
  /**
   * Schema-per-tenant services (farm, sensor, hr, messaging,
   * hydroponics, ai, alert) must enable this so the sync service
   * installs the canonical tenant_isolation_policy on every
   * `tenant_<uuid>` schema at boot. `CREATE TABLE LIKE INCLUDING
   * ALL` does NOT propagate policies, so without this sync RLS is
   * wired only on the template tables. Default: `false`.
   */
  syncTenantSchemas?: boolean;
}

/**
 * Options for `RlsModule.forBypassOnly()`.
 *
 * The audit label is the sole per-service configuration —
 * everything else is either pool-backed (and thus unavailable in
 * bypass-only mode) or pure pass-through.
 */
export interface RlsBypassOnlyOptions {
  /** Lowercase service tag used only in audit log prefixes. */
  serviceName: string;
}

@Module({})
export class RlsModule {
  /**
   * Wire RLS into a service that HAS a `DataSource` (i.e. imports
   * `TypeOrmModule`).
   *
   * @throws at boot (via NestJS DI) when no `DataSource` is
   *   available in the host module — the error names
   *   `RlsConnectionBootstrap` as the dependency that can't resolve.
   *   If you see that error, either add `TypeOrmModule` to the host's
   *   imports[] or switch to `RlsModule.forBypassOnly` instead.
   */
  static forPoolService(options: RlsPoolServiceOptions): DynamicModule {
    const RlsConnectionBootstrap: Type<unknown> =
      createRlsConnectionBootstrap(options.serviceName);

    // Pool-backed providers. DataSource is injected via the standard
    // NestJS token; no DataSource in scope → DI fails at boot with
    // the standard "can't resolve" error. We rely on the caller
    // picking forBypassOnly rather than forPoolService when they
    // don't have a pool — the method name is the contract.
    const providers: Provider[] = [
      RlsConnectionBootstrap,
      BypassRlsService,
      TenantRlsService,
    ];

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
      global: true,
      providers,
      exports: [BypassRlsService, TenantRlsService],
    };
  }

  /**
   * Wire the bypass primitive into a service that has NO
   * `DataSource`. Registers only `BypassRlsService`.
   *
   * This is the correct path for any host module that does NOT
   * import `TypeOrmModule` — admin gateways, pure proxies,
   * orchestrator services, etc.
   *
   * `TenantRlsService` is NOT exported here because it injects
   * `DataSource`. If a consumer needs it, the service isn't
   * bypass-only: switch to `forPoolService`.
   */
  static forBypassOnly(options: RlsBypassOnlyOptions): DynamicModule {
    // serviceName is preserved in the API for parity with
    // forPoolService and for future use (per-service bypass audit
    // labels). BypassRlsService itself does not take a serviceName
    // constructor arg — the audit label is per-call. Reference the
    // option here to make the "unused but intentional" clear to the
    // compiler without an eslint-disable.
    void options.serviceName;

    return {
      module: RlsModule,
      global: true,
      providers: [BypassRlsService],
      exports: [BypassRlsService],
    };
  }
}
