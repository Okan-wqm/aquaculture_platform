import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

/**
 * The result of a single readiness probe slice. Mirrors the StandardHealth
 * contract's per-check vocabulary ('ok' | 'error') so the value can be
 * dropped straight into `getAdditionalChecks()`'s return map.
 */
export type ReadinessCheckResult = 'ok' | 'error';

/**
 * The number of farm source-schema core tables we sample-verify inside any
 * single tenant schema. We deliberately do NOT verify the full ~90-table
 * farm surface inside the sampled tenant: the goal of the tenant slice is a
 * *liveness signal for the sync fan-out machinery*, not a full completeness
 * audit (that is `SchemaManagerService.validateTenantSchemaComplete()`'s job,
 * run by db-migrate/provisioning, not by a 1s K8s readiness probe). Verifying
 * a small, stable, anchor set of the earliest-created core tables is enough to
 * detect a tenant schema that exists but was never populated by the sync
 * service (the failure mode this check exists to surface).
 */
const TENANT_SAMPLE_CORE_TABLES: readonly string[] = [
  'farms',
  'sites',
  'ponds',
  'tanks',
  'batches_v2',
];

/**
 * TenantSchemaReadinessService
 *
 * Farm-service-specific readiness slice that verifies tenant-schema routing
 * topology is healthy WITHOUT being O(tenants).
 *
 * BACKGROUND
 * ----------
 * farm-service is schema-per-tenant: every per-tenant table is declared
 * unqualified in the `farm` SOURCE schema and cloned into each `tenant_<uuid>`
 * schema via `CREATE TABLE LIKE ... INCLUDING ALL` by the tenant-schema sync
 * machinery (`TenantSchemaSyncService` / db-migrate provisioner). The standard
 * `/health/ready` only runs `SELECT 1`, so a broken schema topology (missing
 * source template tables, or a tenant schema that exists but was never
 * populated) produced NO production readiness signal. This service is that
 * signal.
 *
 * COST MODEL — why this is cheap and bounded (NOT O(tenants))
 * ----------------------------------------------------------
 * A K8s readiness probe fires every few seconds, so the check MUST be O(1) in
 * the number of tenants. We do exactly two information_schema aggregate
 * queries plus one bounded sample:
 *
 *   1. SOURCE TOPOLOGY (O(1)): one aggregate `information_schema.tables` query
 *      asserts the `farm` source schema contains its expected core per-tenant
 *      tables (drawn from `MODULE_SCHEMAS` — the SSoT, never hardcoded). If
 *      the source template is missing tables, every future tenant clone is
 *      structurally broken — fail CLOSED.
 *
 *   2. TENANT SYNC REACHABILITY (bounded, NOT O(tenants)): we list tenant
 *      schemas and SAMPLE EXACTLY ONE (the lexicographically-first
 *      `tenant_<uuid>`), then verify its anchor core tables exist with a
 *      single aggregate query. One tenant ⇒ one query, regardless of whether
 *      the platform has 1 or 100 000 tenants. A tenant schema that exists but
 *      lacks its core tables means the sync fan-out is broken — fail CLOSED.
 *      Zero tenant schemas (fresh install / nothing provisioned yet) is
 *      HEALTHY: there is no sync work to have failed.
 *
 * FAIL-CLOSED, NOT FAIL-CRASH
 * ---------------------------
 * Any thrown error (DB unreachable, permission denied, malformed topology) is
 * caught and reported as 'error' — readiness reports DOWN with a logged cause,
 * it does NOT bubble a 500 that hides the reason from K8s. The standard
 * controller already separately probes raw DB connectivity via `SELECT 1`.
 */
@Injectable()
export class TenantSchemaReadinessService {
  private readonly logger = new Logger(TenantSchemaReadinessService.name);

  /** Source schema for the farm module (per-tenant tables live here unqualified). */
  private static readonly SOURCE_SCHEMA = 'farm';

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolve the farm module's expected core per-tenant tables from the
   * MODULE_SCHEMAS SSoT. We intersect the declared `tables` with our stable
   * anchor sample so the source check is anchored to tables that have existed
   * since the baseline migration (avoiding spurious failures while a newly
   * added table is mid-rollout across environments), while still failing if
   * the foundational core is absent.
   */
  private getExpectedSourceCoreTables(): string[] {
    const farmModule = MODULE_SCHEMAS.find((m) => m.moduleName === 'farm');
    if (!farmModule) {
      // MODULE_SCHEMAS is a compile-time constant in backend-common; a missing
      // farm entry is an architectural breakage, surfaced (not swallowed) here.
      throw new Error(
        'MODULE_SCHEMAS has no "farm" module entry — schema topology SSoT is broken',
      );
    }
    const declared = new Set(farmModule.tables);
    return TENANT_SAMPLE_CORE_TABLES.filter((t) => declared.has(t));
  }

  /**
   * Count how many of `expectedTables` exist in `schema`, using a single
   * aggregate `information_schema.tables` query (parameterized — no SQL
   * injection surface; schema/table names flow only through the `$n` binds).
   */
  private async countExistingTables(
    schema: string,
    expectedTables: readonly string[],
  ): Promise<number> {
    const rows: Array<{ count: string }> = await this.dataSource.query(
      `SELECT COUNT(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = ANY($2::text[])`,
      [schema, [...expectedTables]],
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }

  /**
   * List tenant schema names. Bounded by design: we only ever read the FIRST
   * row, but information_schema returns the full set; we cap the cost with
   * `LIMIT 1` + `ORDER BY` so PostgreSQL never materializes more than one row
   * for the readiness probe.
   */
  private async getSampleTenantSchema(): Promise<string | null> {
    const rows: Array<{ schema_name: string }> = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata
        WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
        ORDER BY schema_name
        LIMIT 1`,
    );
    return rows[0]?.schema_name ?? null;
  }

  /**
   * Tenant-schema routing readiness probe. Returns 'ok' when the farm source
   * topology is intact AND (if any tenant exists) the sampled tenant schema is
   * populated; returns 'error' otherwise. Never throws.
   */
  async checkTenantSchemaRouting(): Promise<ReadinessCheckResult> {
    try {
      if (!this.dataSource.isInitialized) {
        return 'error';
      }

      // (1) SOURCE TOPOLOGY — the clone template every tenant is built from.
      const expectedSourceTables = this.getExpectedSourceCoreTables();
      const sourcePresent = await this.countExistingTables(
        TenantSchemaReadinessService.SOURCE_SCHEMA,
        expectedSourceTables,
      );
      if (sourcePresent < expectedSourceTables.length) {
        this.logger.error(
          `Tenant-schema readiness DOWN: farm source schema is missing core tables ` +
            `(${sourcePresent}/${expectedSourceTables.length} of ` +
            `[${expectedSourceTables.join(', ')}] present). ` +
            `Tenant provisioning clones from this schema, so the topology is broken.`,
        );
        return 'error';
      }

      // (2) TENANT SYNC REACHABILITY — bounded single-tenant sample.
      const sampleSchema = await this.getSampleTenantSchema();
      if (sampleSchema === null) {
        // No tenant provisioned yet — nothing for the sync machinery to have
        // failed. Source topology is intact, so readiness is healthy.
        return 'ok';
      }

      const sampleExpected = expectedSourceTables;
      const tenantPresent = await this.countExistingTables(sampleSchema, sampleExpected);
      if (tenantPresent < sampleExpected.length) {
        this.logger.error(
          `Tenant-schema readiness DOWN: sampled tenant schema ${sampleSchema} is ` +
            `missing core tables (${tenantPresent}/${sampleExpected.length} present). ` +
            `Tenant-schema sync fan-out did not complete for this tenant.`,
        );
        return 'error';
      }

      return 'ok';
    } catch (error) {
      // Fail CLOSED with a logged cause — never let a thrown error become a
      // 500 that hides why readiness failed.
      this.logger.error(
        `Tenant-schema readiness check failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return 'error';
    }
  }
}
