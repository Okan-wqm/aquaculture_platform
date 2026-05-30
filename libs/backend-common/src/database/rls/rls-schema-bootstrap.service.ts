import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { applyTenantRlsToSchema, ApplyTenantRlsOptions } from './apply-tenant-rls.helper';
import { assertRuntimeDdlAllowed } from '../db-migrate-authority';

/**
 * RlsSchemaBootstrap
 * ============================================================================
 *
 * Startup-time installer for tenant Row-Level Security policies.
 *
 * # Why does this runtime bootstrap still exist?
 *
 * Production-like environments use `db-migrate` as the single source of truth
 * for schema changes and post-migration hardening. In that mode this provider
 * fails fast before opening a query runner so application startup cannot
 * mutate schema state.
 *
 * Local and test environments may run without authoritative `db-migrate`
 * ownership. For those environments this bootstrap keeps the historical
 * developer workflow intact by installing tenant RLS policies after the
 * service has started wiring its modules.
 *
 * # Why `OnApplicationBootstrap` and not `OnModuleInit`?
 *
 * `OnModuleInit` runs as each module's `init` method completes — module
 * dependencies are wired but the application is not yet "live". That's
 * fine for pool-patching (`RlsConnectionBootstrap`) which only needs the
 * DataSource.
 *
 * `OnApplicationBootstrap` runs **after every module is initialised** —
 * which is exactly when we want to install policies, because:
 *
 * 1. The DataSource has been validated and connected (otherwise the helper's
 *    `qr.query()` calls would fail with cryptic startup errors).
 * 2. `SourceSchemaBootstrapService` (which runs in `onModuleInit`) has had
 *    a chance to create the tables. RLS on a non-existent table is silently
 *    a no-op, but with this ordering we get the policies on the FIRST cold
 *    start, not the second.
 *
 * # Idempotency and forward-migration
 *
 * `applyTenantRlsToSchema` drops the canonical policy and recreates it on
 * every invocation. That makes startup-time installation safe (re-running
 * is free) AND turns it into a forward-migration mechanism: bumping the
 * helper's predicate (e.g. fixing the NULLIF cast bug) deploys the new
 * predicate the next time any service that uses this bootstrap restarts.
 *
 * # Failure handling
 *
 * In authoritative mode runtime RLS installation is fatal by contract because
 * schema hardening must be performed by `db-migrate`.
 *
 * In non-authoritative local/test mode, RLS install failures are logged but
 * not fatal. Rationale: if startup hard-fails on a local schema edge case,
 * developers cannot boot the service to inspect the underlying state.
 *
 * **Operational note**: this means RLS install errors MUST be alerted on
 * via the `rls.bootstrap.failed` log event so an operator notices the
 * service is running without isolation.
 *
 * # When NOT to use this bootstrap
 *
 * Do not register this provider for production-like schema ownership. Services
 * must rely on `db-migrate` registry hardening when `DB_MIGRATE_AUTHORITATIVE`
 * resolves to true.
 */

@Injectable()
export class RlsSchemaBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(RlsSchemaBootstrap.name);

  constructor(
    private readonly dataSource: DataSource,
    /**
     * Helper options provided at module registration time. Wrapped in a
     * concrete object (not a `Partial`) so the bootstrap signature stays
     * stable when new helper options are added.
     */
    private readonly options: RlsSchemaBootstrapOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.disabled === true) {
      this.logger.warn(
        `RLS auto-apply DISABLED for "${this.options.serviceName}" — ` +
          `tenant_isolation_policy will NOT be installed at startup. ` +
          `This must only be used for staged rollouts; remove the disable ` +
          `flag once policies are validated.`,
      );
      return;
    }

    assertRuntimeDdlAllowed({
      serviceName: this.options.serviceName,
      operation: 'RLS schema auto-apply',
    });

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      this.logger.log(`Installing tenant RLS policies for service "${this.options.serviceName}"`);

      await applyTenantRlsToSchema(queryRunner, {
        excludeTables: this.options.excludeTables,
        tenantIdColumns: this.options.tenantIdColumns,
        // Reuse the bootstrap's logger so install logs share a common
        // context with the service that owns them — easier to grep.
        logger: this.logger,
      });

      this.logger.log(`Tenant RLS policies installed for "${this.options.serviceName}"`);
    } catch (err) {
      // SECURITY-OPS: this is the alerting hook. The literal substring
      // "rls.bootstrap.failed" should be matched in log dashboards / alert
      // rules so operators are paged when a service boots without
      // tenant isolation in place.
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `rls.bootstrap.failed service="${this.options.serviceName}" — ` +
          `service is running WITHOUT tenant RLS until restart succeeds: ${msg}`,
        stack,
      );
      // Do NOT rethrow — see "Failure handling" in the class docblock.
    } finally {
      // Always release the runner; otherwise the connection leaks until
      // pool eviction.
      await queryRunner.release();
    }
  }
}

/**
 * Options accepted by `RlsModule.forPoolService()` and forwarded into the
 * bootstrap. Mirrors `ApplyTenantRlsOptions` but adds wiring concerns
 * (`serviceName`, `disabled`).
 */
export interface RlsSchemaBootstrapOptions {
  /**
   * Lowercase service tag, used in log lines. Same value passed to
   * `createRlsConnectionBootstrap` so all RLS-related logs from the same
   * service share the prefix.
   */
  serviceName: string;
  /**
   * Tables that must NOT receive RLS — typically outbox, audit logs, and
   * any deliberately cross-tenant infrastructure tables.
   * @see ApplyTenantRlsOptions.excludeTables
   */
  excludeTables?: ApplyTenantRlsOptions['excludeTables'];
  /**
   * Override the discovered tenant column names. Defaults to the helper's
   * built-in list (`['tenantId', 'tenant_id']`).
   * @see ApplyTenantRlsOptions.tenantIdColumns
   */
  tenantIdColumns?: ApplyTenantRlsOptions['tenantIdColumns'];
  /**
   * If true, the bootstrap logs a warning and returns without installing
   * any policies. Reserved for staged rollouts where the team wants the
   * pool patch (`RlsConnectionBootstrap`) live but is not yet ready to
   * enforce policies. Remove the flag once policies are validated.
   */
  disabled?: boolean;
}
