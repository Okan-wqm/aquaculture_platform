import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  convertAuditColumnsToTimestamptz,
  ConvertAuditColumnsOptions,
} from './convert-audit-columns-to-timestamptz.helper';
import { assertRuntimeDdlAllowed } from './db-migrate-authority.util';

/**
 * AuditColumnsBootstrap
 * ============================================================================
 *
 * Startup-time installer that converts every TIMESTAMP-typed audit
 * column (`createdAt`, `updatedAt`, snake_case variants) to TIMESTAMPTZ
 * via `convertAuditColumnsToTimestamptz()`. Designed for services that
 * lack a TypeORM migration runner (currently hr, billing, notification,
 * config, ai), so they can still close NEW-H1 without per-service
 * migration infrastructure.
 *
 * # Why a runtime bootstrap instead of a migration?
 *
 * Same reasoning as `RlsSchemaBootstrap`. Adding a TypeORM migration
 * runner to five services to deliver this single fix would change the
 * deploy story for each service — a much larger blast radius than the
 * fix itself. Instead we follow the proven pattern from
 * `SourceSchemaBootstrapService` and `RlsSchemaBootstrap`: an idempotent
 * `OnApplicationBootstrap` provider that runs the helper once per cold
 * start. The helper's discovery query filters out already-converted
 * columns, so re-running is free.
 *
 * # Why `OnApplicationBootstrap` and not `OnModuleInit`?
 *
 * Same lifecycle reasoning as `RlsSchemaBootstrap`. The DataSource
 * must be connected before we can `createQueryRunner()`, and any
 * `SourceSchemaBootstrapService` that verifies post-migration source-schema
 * tables must run in the same application bootstrap phase, after module
 * initialization and after authoritative migration ownership has been decided.
 * `OnApplicationBootstrap` runs after every module's `OnModuleInit`,
 * giving us both guarantees in one phase.
 *
 * # Failure handling
 *
 * Per the same convention as `RlsSchemaBootstrap`, conversion failures
 * are LOGGED but **not fatal** — a partial schema-hardening pass must
 * not bring down the entire service. The standard
 * `audit_columns.bootstrap.failed` log substring is emitted on failure
 * so operators can wire it into PagerDuty / OpsGenie.
 *
 * # Connection management
 *
 * Uses one `QueryRunner`, connected and released cleanly. The helper
 * itself wraps multiple ALTER statements in a single connection scope.
 *
 * # When NOT to use this service
 *
 * - Services with their own TypeORM migration runner (auth, admin-api,
 *   farm, sensor, messaging) should call `convertAuditColumnsToTimestamptz`
 *   from a regular migration instead. That keeps the deploy pipeline
 *   single-source-of-truth for schema state.
 * - Services where audit columns are deliberately TIMESTAMP for some
 *   exotic reason (we have none — but if a future service did, it
 *   would skip this bootstrap and document why).
 */

@Injectable()
export class AuditColumnsBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditColumnsBootstrap.name);

  constructor(
    private readonly dataSource: DataSource,
    /**
     * Options bound at registration time. Same shape as the helper's
     * options minus `logger` (we provide our own) and `schemaOverride`
     * (the bootstrap operates on `current_schema()` per its DataSource
     * config — for tenant schema iteration, services should use a
     * dedicated tenant sweep service, not this bootstrap).
     */
    private readonly options: AuditColumnsBootstrapOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.disabled === true) {
      this.logger.warn(
        `AuditColumnsBootstrap DISABLED for "${this.options.serviceName}". ` +
          `Audit-column TIMESTAMP → TIMESTAMPTZ conversion will NOT run at ` +
          `startup. Use only for staged rollouts; remove the disable flag ` +
          `once validated.`,
      );
      return;
    }

    // Choke-point (PR#363 design): in authoritative mode fail fast BEFORE
    // pinning a pool connection. The helper re-asserts internally (it is
    // also called directly from migrations), so this is defense-in-depth
    // plus a cheaper failure point.
    assertRuntimeDdlAllowed({
      serviceName: this.options.serviceName,
      operation: 'audit-column TIMESTAMPTZ conversion',
    });

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      this.logger.log(`Running audit-column conversion for service "${this.options.serviceName}"`);

      await convertAuditColumnsToTimestamptz(queryRunner, {
        excludeTables: this.options.excludeTables,
        auditColumns: this.options.auditColumns,
        // Reuse this service's logger so the helper's per-table progress
        // logs share a grep-friendly prefix with our boot summary.
        logger: this.logger,
      });

      this.logger.log(`Audit-column conversion complete for "${this.options.serviceName}"`);
    } catch (err) {
      // Operator alerting hook: the literal substring
      // "audit_columns.bootstrap.failed" is the recommended pattern in
      // log-based alert rules so a partial conversion produces a page.
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `audit_columns.bootstrap.failed service="${this.options.serviceName}" — ` +
          `service is running with the LEGACY TIMESTAMP layout until restart ` +
          `succeeds: ${msg}`,
        stack,
      );
      if (msg.includes('[db-migrate authority]')) {
        throw err;
      }
      // Do NOT rethrow — partial conversion is recoverable on next
      // restart and is preferable to a hard service crash.
    } finally {
      // Always release. A leaked QueryRunner pins a connection in the
      // pool until eviction.
      await queryRunner.release();
    }
  }
}

/**
 * Options for `AuditColumnsBootstrap`. Bound at provider registration
 * time and forwarded to the helper.
 */
export interface AuditColumnsBootstrapOptions {
  /**
   * Lowercase service tag for log prefixes. Same value services pass
   * to other backend-common bootstrap services for grep-consistency.
   */
  serviceName: string;
  /**
   * Tables to skip. Forwarded to
   * `ConvertAuditColumnsOptions.excludeTables`.
   */
  excludeTables?: ConvertAuditColumnsOptions['excludeTables'];
  /**
   * Override the audit column names list. Defaults to
   * `['createdAt', 'updatedAt', 'created_at', 'updated_at']`.
   * @see ConvertAuditColumnsOptions.auditColumns
   */
  auditColumns?: ConvertAuditColumnsOptions['auditColumns'];
  /**
   * If true, the bootstrap logs a warning and returns without running.
   * Reserved for staged rollouts.
   */
  disabled?: boolean;
}
