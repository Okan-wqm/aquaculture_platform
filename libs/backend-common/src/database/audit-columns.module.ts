import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  AuditColumnsBootstrap,
  AuditColumnsBootstrapOptions,
} from './audit-columns-bootstrap.service';

/**
 * AuditColumnsModule
 * ============================================================================
 *
 * One-line wiring for the NEW-H1 audit-column TIMESTAMP → TIMESTAMPTZ
 * conversion in services that have **no TypeORM migration runner**
 * (currently hr, billing, notification, config, ai). Mirrors the
 * `RlsModule.forPoolService()` pattern so the two pieces of cold-start schema
 * hardening look and feel identical at the call site.
 *
 * # What you get from `forRoot()`
 *
 * `AuditColumnsBootstrap` is registered as a provider via `useFactory`
 * so it can receive both the `DataSource` and a service-specific options
 * object. On `OnApplicationBootstrap` it runs
 * `convertAuditColumnsToTimestamptz()` against `current_schema()` —
 * idempotent, since the helper's discovery query filters out columns
 * that are already TIMESTAMPTZ at the database layer.
 *
 * # Why a separate module from RlsModule
 *
 * RLS and timestamptz conversion are independent concerns:
 *
 *   - A service may need timestamptz hardening without ever using
 *     tenant RLS (e.g., a globally-scoped notification service).
 *   - A service may need RLS without yet adopting NEW-H1 (the rollout
 *     is staged across the fleet).
 *
 * Co-locating them in one module would force every adopter of one
 * concern to opt into the other. Keeping them separate lets each
 * service progress independently and keeps the failure blast radius
 * scoped to the concern that actually broke.
 *
 * # Usage — service WITHOUT migration runner
 *
 * ```ts
 * import { AuditColumnsModule, RlsModule } from '@aquaculture/backend-common/audit-columns.module.ts';
 *
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *     RlsModule.forPoolService({ serviceName: 'billing', autoApply: true }),
 *     AuditColumnsModule.forRoot({ serviceName: 'billing' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * # Usage — service WITH migration runner
 *
 * Do NOT register this module. Write a regular TypeORM migration that
 * calls `convertAuditColumnsToTimestamptz(qr, ...)` directly so the
 * deploy pipeline keeps a single source of truth for schema state. See
 * `apps/auth-service/src/migrations/1781900000000-ConvertAuditColumnsToTimestamptz.ts`
 * for the canonical example.
 *
 * # Module-scoped, not global
 *
 * `AuditColumnsModule` is **NOT** registered as global. Each service
 * imports it explicitly because the bootstrap is parametrised with a
 * service name (for log readability) and because making schema-level
 * hardening globally implicit is exactly the kind of magic that
 * produces "I forgot to wire NEW-H1 into the new service" incidents —
 * the same reasoning RlsModule documents at its module-scoping note.
 */

/**
 * Options accepted by `AuditColumnsModule.forRoot()`. A thin wrapper
 * around `AuditColumnsBootstrapOptions` so the module signature stays
 * stable even if the bootstrap gains new constructor arguments.
 */
export type AuditColumnsModuleOptions = AuditColumnsBootstrapOptions;

@Module({})
export class AuditColumnsModule {
  /**
   * Wire `AuditColumnsBootstrap` into the host service. The bootstrap
   * fires once at `OnApplicationBootstrap` and is idempotent — re-runs
   * are no-ops because the helper's discovery query filters
   * already-converted columns.
   *
   * @param options See `AuditColumnsModuleOptions`. Pass at minimum
   *                the `serviceName`; supply `excludeTables` to keep a
   *                deliberately-cross-tenant table on the legacy type.
   */
  static forRoot(options: AuditColumnsModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: AuditColumnsBootstrap,
        useFactory: (dataSource: DataSource): AuditColumnsBootstrap =>
          new AuditColumnsBootstrap(dataSource, options),
        inject: [DataSource],
      },
    ];

    return {
      module: AuditColumnsModule,
      providers,
      // Nothing to re-export — the bootstrap is internal lifecycle
      // machinery and no other code should reach into it.
      exports: [],
    };
  }
}
