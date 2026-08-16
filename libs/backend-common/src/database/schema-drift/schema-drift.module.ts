import { DynamicModule, Module, Provider } from '@nestjs/common';

import { createSchemaDriftValidator } from '../schema-drift-validator.service';

/**
 * SchemaDriftModule
 * ============================================================================
 *
 * NestJS dynamic module that wires the `OnApplicationBootstrap`
 * schema-drift validator into a service. Mirrors the registration
 * ergonomics of `RlsModule.forPoolService()` so the wiring story across the
 * codebase is consistent: one import line in AppModule, no per-feature-
 * module ceremony, no `providers: [createXService('name')]` factory call
 * leaking into module configuration.
 *
 * # Why a module instead of "just call the factory"
 *
 * The 2026-04-14 review surfaced that `createSchemaDriftValidator(...)`
 * was authored, exported, and documented in ADR-012 as the third layer
 * of drift defense — but ZERO services registered it. ADR-012 + the
 * runbook claimed the validator fires on every cold start; in reality
 * it never ran. Audit-theater anti-pattern.
 *
 * Wrapping the factory in a `forRoot()` module:
 *   1. Makes registration discoverable in `app.module.ts` (one import,
 *      readable in the imports[] array next to RlsModule, AuditColumnsModule,
 *      and the other infra modules — operators reading the module list see
 *      "drift detection is on").
 *   2. Eliminates the per-service-name typo class (factory call site has
 *      to remember the exact service name; module options validate it via
 *      TypeScript).
 *   3. Allows future configuration (per-service excludeEntities, per-table
 *      drift budgets) to land as additive options without changing every
 *      consumer.
 *   4. Keeps consumption global within the service tree (per the RlsModule
 *      pattern adopted in commit 4139486f) so feature modules don't have
 *      to re-import.
 *
 * # Usage
 *
 * ```ts
 * import { SchemaDriftModule } from '@aquaculture/backend-common/schema-drift';
 *
 * @Module({
 *   imports: [
 *     // ... TypeOrmModule, RlsModule, etc.
 *     SchemaDriftModule.forRoot({ serviceName: 'billing' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * # Configuration via environment (no module-level config needed)
 *
 *   SCHEMA_DRIFT_FATAL=false (default)  → log + start anyway
 *   SCHEMA_DRIFT_FATAL=true             → fail boot on any violation
 *   SCHEMA_DRIFT_ENABLED=false          → skip entirely (kill switch)
 *
 * Per ADR-012 enforcement timeline: deploy with default, observe one
 * cycle, then flip FATAL in staging → production.
 */

export interface SchemaDriftModuleOptions {
  /**
   * Runtime service tag used in log prefixes and emergency override lookup.
   * Example: `'billing'`, `'auth'`, `'alert-engine'`.
   */
  serviceName: string;

  /**
   * Physical source schema to validate. Defaults to `serviceName`.
   * Use when a runtime service name differs from its database schema
   * (for example alert-engine owns the `alert` source schema).
   */
  schemaName?: string;
}

@Module({})
export class SchemaDriftModule {
  /**
   * Wire the schema-drift validator into the host service.
   *
   * Returns a `global: true` DynamicModule — the underlying validator
   * class is registered once and runs once at OnApplicationBootstrap.
   * Other modules in the service tree don't need to inject it (it has
   * no consumer-facing API), but the `global: true` flag keeps the
   * provider visible for future consumers without re-imports.
   */
  static forRoot(options: SchemaDriftModuleOptions): DynamicModule {
    if (!options.serviceName || !/^[a-z][a-z0-9_-]*$/.test(options.serviceName)) {
      throw new Error(
        `[SchemaDriftModule.forRoot] Invalid serviceName: "${options.serviceName}". ` +
          `Must match /^[a-z][a-z0-9_-]*$/ (lowercase, digits, underscore, hyphen).`,
      );
    }
    if (options.schemaName !== undefined && !/^[a-z][a-z0-9_-]*$/.test(options.schemaName)) {
      throw new Error(
        `[SchemaDriftModule.forRoot] Invalid schemaName: "${options.schemaName}". ` +
          `Must match /^[a-z][a-z0-9_-]*$/ (lowercase, digits, underscore, hyphen).`,
      );
    }

    const ValidatorClass = createSchemaDriftValidator(options.serviceName, options.schemaName);
    const provider: Provider = ValidatorClass;

    return {
      module: SchemaDriftModule,
      // Global within the service's module tree so feature modules can
      // inject the validator (rare — its main job is OnApplicationBootstrap)
      // without re-importing this module. Registration itself stays
      // explicit — AppModule MUST call forRoot() — so the "I forgot to
      // wire drift detection" failure mode is impossible.
      global: true,
      providers: [provider],
      exports: [provider],
    };
  }
}
