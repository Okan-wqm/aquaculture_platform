import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  applyTenantRlsToSchema,
  ApplyTenantRlsOptions,
} from './apply-tenant-rls.helper';

/**
 * RlsSchemaBootstrap
 * ============================================================================
 *
 * Startup-time installer for tenant Row-Level Security policies.
 *
 * # Why a runtime bootstrap instead of a TypeORM migration?
 *
 * The global-schema services (billing, ai, notification, alert, config,
 * event-store) currently have **no migration runner wired in** — TypeORM
 * `synchronize` was removed in commit `5ce2b127` for production safety, but
 * a replacement migration system has not yet been added (out of scope for
 * this RLS work). Tables are created by deploy scripts and `SourceSchemaBootstrapService`.
 *
 * Adding a migration runner to six services to deliver RLS would be a major
 * scope expansion and would change the deploy story for each service.
 * Instead, we follow the **same pattern as `SourceSchemaBootstrapService`**:
 * a small `OnApplicationBootstrap` provider that runs the idempotent helper
 * once per process, after the rest of the application is wired but before
 * any HTTP handler can serve a request.
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
 * RLS install failures are LOGGED but **not fatal** — the service still
 * boots. Rationale: if startup hard-fails on RLS install, a partial outage
 * (one badly-named table, a missing extension, anything) takes down the
 * whole service. The risk of a brief window without RLS during recovery is
 * lower than the risk of a global outage.
 *
 * **Operational note**: this means RLS install errors MUST be alerted on
 * via the `rls.bootstrap.failed` log event so an operator notices the
 * service is running without isolation.
 *
 * # When NOT to use this bootstrap
 *
 * Services with their own migration runner (currently only `farm-service`,
 * `sensor-service`, `hr-service`, `messaging-service`) should install RLS
 * via a regular TypeORM migration instead — that gives the deploy pipeline
 * a single, sequenced source of truth for schema state. The bootstrap is
 * for services that don't have that pipeline (yet).
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

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      this.logger.log(
        `Installing tenant RLS policies for service "${this.options.serviceName}"`,
      );

      await applyTenantRlsToSchema(queryRunner, {
        excludeTables: this.options.excludeTables,
        tenantIdColumns: this.options.tenantIdColumns,
        // Reuse the bootstrap's logger so install logs share a common
        // context with the service that owns them — easier to grep.
        logger: this.logger,
      });

      this.logger.log(
        `Tenant RLS policies installed for "${this.options.serviceName}"`,
      );
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
 * Options accepted by `RlsModule.forRoot()` and forwarded into the
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
