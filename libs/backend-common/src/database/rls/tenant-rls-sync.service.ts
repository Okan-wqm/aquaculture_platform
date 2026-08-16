import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { assertRuntimeDdlAllowed } from '../db-migrate-authority.util';

import { applyTenantRlsToSchema, ApplyTenantRlsOptions } from './apply-tenant-rls.helper';

/**
 * TenantRlsSyncService
 * ============================================================================
 *
 * Startup-time sweep that installs the canonical `tenant_isolation_policy`
 * on every per-tenant schema (`tenant_<uuid>`) for a schema-per-tenant
 * service.
 *
 * # Why this exists — the RLS scope bug it closes
 *
 * Schema-per-tenant services (farm, sensor, hr, hydroponics, messaging,
 * ai, alert) provision per-tenant schemas via `SchemaManagerService.
 * createTenantSchema()` and `TenantSchemaSyncService`, which both copy
 * tables from the source schema using:
 *
 *     CREATE TABLE "tenant_<uuid>"."<table>"
 *       (LIKE "<source>"."<table>" INCLUDING ALL)
 *
 * `INCLUDING ALL` (PostgreSQL) is a shorthand for INCLUDING DEFAULTS,
 * CONSTRAINTS, IDENTITY, STATISTICS, STORAGE, COMMENTS, and (PG14+)
 * COMPRESSION. Critically, it **does NOT include row-level security
 * policies** — RLS policies are catalog objects (`pg_policy`) attached
 * to tables, but `LIKE INCLUDING ALL` does not propagate them.
 *
 * The Phase 1 farm-service RLS migration
 * (`RefreshTenantRlsPredicate1781000000000`) calls
 * `applyTenantRlsToSchema()` against `current_schema()`, which in the
 * migration runner context is the **source schema** (`farm`). Result:
 *
 *   ✓ Policy installed on `farm.batches` (source schema template)
 *   ✗ Policy NOT installed on `tenant_<uuid>.batches` (production data)
 *
 * Production queries use `search_path = tenant_<uuid>, farm, public`
 * (set by `TenantConnectionBootstrap` per pool checkout), so they
 * always hit `tenant_<uuid>.batches` first — which has no policy. The
 * defense-in-depth claim of Phase 1 was therefore non-functional.
 *
 * This service closes that gap by iterating every `tenant_<uuid>`
 * schema at startup and installing the policy on each via
 * `applyTenantRlsToSchema(qr, { schemaOverride: 'tenant_<uuid>' })`.
 *
 * # Why a service, not (only) a migration
 *
 * A migration would only run ONCE per environment. New tenants
 * provisioned at runtime via `SchemaManagerService.createTenantSchema()`
 * would not have RLS installed until the next deploy.
 *
 * Running the same logic at every `OnApplicationBootstrap` makes the
 * sweep:
 *
 *   1. **Idempotent recovery**: any tenant missed during runtime
 *      provisioning is caught on the next service restart.
 *   2. **Safe to re-run**: the helper drops + recreates the canonical
 *      policy on every invocation, so the only cost of running it
 *      twice is a sub-millisecond DDL pair per table per schema.
 *   3. **Self-healing**: a schema added by another process (e.g. a
 *      DBA running `CREATE SCHEMA tenant_xxx; CREATE TABLE LIKE ...`
 *      manually) is automatically picked up.
 *
 * # Order of OnApplicationBootstrap hooks
 *
 * Both this service and `TenantSchemaSyncService` implement
 * `OnApplicationBootstrap`. NestJS calls hooks in module declaration
 * order, but cross-module ordering is not strictly defined. The
 * service is therefore **resilient to ordering**:
 *
 *   - If `TenantSchemaSyncService` runs FIRST, the tenant tables exist
 *     and `applyTenantRlsToSchema` discovers and policies them.
 *   - If `TenantRlsSyncService` runs FIRST, the discovery query
 *     returns whatever tables already exist (typically all of them on
 *     a steady-state environment), and the helper installs policies
 *     on those. Tables created later by `TenantSchemaSyncService` are
 *     missed for that startup but caught on the next restart.
 *
 * Either way, there is no broken state — just a (rare) one-restart
 * delay before all tables get policies, which is acceptable for a
 * defense-in-depth layer.
 *
 * # Failure handling
 *
 * RLS install failures are LOGGED but **not fatal**. Rationale: a
 * partial RLS install must not bring down the entire service. The
 * standard `rls.bootstrap.failed` log substring is emitted on failure
 * so operators can alert on it (see Phase 2 deploy guide §4.1).
 *
 * # Connection management
 *
 * Each tenant schema gets its own `QueryRunner`, connected and
 * released cleanly. The helper's existing logic (single-connection
 * scope, no transaction, idempotent DDL) is preserved.
 *
 * # When NOT to use this service
 *
 * - Global-schema services (billing, notification, config, admin-api)
 *   do not have `tenant_*` schemas. Use `RlsSchemaBootstrap` (which
 *   targets `current_schema`) instead. These two services are
 *   complementary, not duplicates — global services use the bootstrap,
 *   schema-per-tenant services use this sync.
 * - Services that do NOT install RLS at all (auth-service — can't
 *   support RLS because of nullable tenantId on SUPER_ADMIN rows).
 *   Don't register this service for those.
 */

@Injectable()
export class TenantRlsSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantRlsSyncService.name);

  constructor(
    private readonly dataSource: DataSource,
    /**
     * Helper options forwarded to every per-tenant invocation.
     * `schemaOverride` is set per-iteration so callers must not provide
     * it here.
     */
    private readonly options: TenantRlsSyncOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.disabled === true) {
      this.logger.warn(
        `TenantRlsSyncService DISABLED for "${this.options.serviceName}". ` +
          `Per-tenant RLS policies will NOT be installed at startup. ` +
          `This must only be used for staged rollouts; remove the disable ` +
          `flag once policies are validated.`,
      );
      return;
    }

    // Choke-point (PR#363 design): the per-tenant RLS sweep issues DDL
    // (CREATE POLICY / ENABLE RLS) per tenant schema. In authoritative
    // mode that DDL belongs to aqua-db-migrate's tenant fan-out
    // hardening — fail fast BEFORE tenant discovery.
    assertRuntimeDdlAllowed({
      serviceName: this.options.serviceName,
      operation: 'tenant RLS schema sync',
    });

    let schemas: string[];
    try {
      schemas = await this.listTenantSchemas();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `rls.bootstrap.failed service="${this.options.serviceName}" ` +
          `phase="discover-schemas" — could not enumerate tenant schemas: ${msg}`,
        stack,
      );
      return;
    }

    if (schemas.length === 0) {
      this.logger.log(
        `No tenant_* schemas found for "${this.options.serviceName}" — nothing to sync. ` +
          `This is expected on environments without provisioned tenants.`,
      );
      return;
    }

    this.logger.log(
      `Syncing RLS policies across ${schemas.length} tenant schemas for "${this.options.serviceName}"`,
    );

    // Process serially to avoid pool contention. Each tenant schema is
    // small (sub-millisecond DDL), so 100 tenants ≈ 100ms total. Parallel
    // processing would not meaningfully improve total time and would
    // complicate error attribution in logs.
    let succeeded = 0;
    let failed = 0;

    for (const schema of schemas) {
      const ok = await this.syncSchema(schema);
      if (ok) {
        succeeded++;
      } else {
        failed++;
      }
    }

    if (failed > 0) {
      // Aggregate-level failure log — operators see one summary line
      // alongside the per-schema rls.bootstrap.failed entries from the
      // helper or our catch block. Keeps dashboards readable while
      // preserving full per-schema visibility for debugging.
      this.logger.error(
        `rls.bootstrap.failed service="${this.options.serviceName}" ` +
          `phase="apply-policies" — ${failed} of ${schemas.length} schemas failed; ` +
          `${succeeded} succeeded. Service running with PARTIAL tenant isolation.`,
      );
    } else {
      this.logger.log(
        `Tenant RLS sync complete for "${this.options.serviceName}": ` +
          `${succeeded} schemas updated`,
      );
    }
  }

  /**
   * Apply RLS policies to a single tenant schema. Returns true on
   * success, false on failure (logged with the rls.bootstrap.failed
   * substring for alerting).
   *
   * The QueryRunner is connected and released cleanly per invocation
   * so a single hung connection cannot starve the rest of the sync.
   */
  private async syncSchema(schema: string): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await applyTenantRlsToSchema(queryRunner, {
        schemaOverride: schema,
        excludeTables: this.options.excludeTables,
        tenantIdColumns: this.options.tenantIdColumns,
        // Reuse this service's logger so per-schema log lines share a
        // grep-friendly prefix with the aggregate summary above.
        logger: this.logger,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `rls.bootstrap.failed service="${this.options.serviceName}" ` +
          `schema="${schema}" — apply failed: ${msg}`,
        stack,
      );
      return false;
    } finally {
      // Always release. A leaked QueryRunner pins a connection in the
      // pool until eviction, which would gradually starve the service.
      await queryRunner.release();
    }
  }

  /**
   * Discover every `tenant_<16hex>` schema. We use the same regex
   * pattern that `validateTenantSchemaName` enforces elsewhere in
   * backend-common so this discovery rejects anything that isn't a
   * properly-formatted tenant schema (e.g. legacy `tenant_dev_*`
   * sandbox schemas the platform may have used in the past).
   *
   * The query runs through the main DataSource without setting
   * `search_path`, because `information_schema.schemata` is in the
   * postgres global catalog and visible regardless.
   */
  private async listTenantSchemas(): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await this.dataSource.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );
    return rows.map((r) => r.schema_name);
  }
}

/**
 * Options for `TenantRlsSyncService`. Mirrors the relevant fields from
 * `ApplyTenantRlsOptions` plus wiring concerns (`serviceName`,
 * `disabled`).
 */
export interface TenantRlsSyncOptions {
  /**
   * Lowercase service tag, used in audit-grade log lines. Same value
   * passed to other RLS components for the same service so all RLS
   * logs from one service share a grep-friendly prefix.
   */
  serviceName: string;
  /**
   * Tables that must NOT receive RLS — typically outbox, audit logs.
   * @see ApplyTenantRlsOptions.excludeTables
   */
  excludeTables?: ApplyTenantRlsOptions['excludeTables'];
  /**
   * Override the discovered tenant column names. Defaults to
   * `['tenantId', 'tenant_id']`.
   * @see ApplyTenantRlsOptions.tenantIdColumns
   */
  tenantIdColumns?: ApplyTenantRlsOptions['tenantIdColumns'];
  /**
   * If true, skip the sweep entirely. Reserved for staged rollouts —
   * remove the flag once the per-tenant policies are validated in
   * staging.
   */
  disabled?: boolean;
}
