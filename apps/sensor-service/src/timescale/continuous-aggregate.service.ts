import {
  listTenantSchemas,
  resolveDbMigrateAuthoritativeFromConfig,
  SENSOR_CONTINUOUS_AGGREGATE_LOCK_PREFIX,
  SENSOR_CONTINUOUS_AGGREGATE_NAMES,
  SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE,
  SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Continuous Aggregate Service
 *
 * Owns runtime access to the metrics_1min/1hour/1day continuous aggregates
 * over each tenant's `sensor_metrics` hypertable:
 *   - production boot verification (db-migrate owns production DDL),
 *   - local-development creation when db-migrate is not authoritative,
 *   - runtime visibility into refresh state (`getRefreshStatus`),
 *   - on-demand manual refresh of lagging aggregates (`refresh`).
 *
 * ## Per tenant, because the data is per tenant
 *
 * A tenant's telemetry lives in that tenant's own schema, so its rollups must
 * live there too: a continuous aggregate is defined over one hypertable, and
 * there is one hypertable per tenant. The bootstrap therefore SWEEPS the tenant
 * schemas and ensures the three views inside each, rather than creating one
 * shared set over a shared table.
 *
 * TimescaleDB forbids continuous-aggregate creation inside the transaction used
 * by the migration runner. The db-migrate autocommit phase and tenant schema
 * provisioner therefore create and own the rollups in authoritative
 * environments. Runtime boot only verifies that contract; local development
 * retains the advisory-locked autocommit creation path.
 *
 * CRITICAL-005: refresh/status were previously a 1-line stub.
 */
@Injectable()
export class ContinuousAggregateService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContinuousAggregateService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Verify production aggregates, or create them in non-authoritative local
   * development. Any ownership/missing-view drift aborts production boot.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.ensureAggregates();
  }

  /**
   * Idempotently ensure the metrics_1min/1hour/1day continuous aggregates —
   * their real-time flag, refresh + retention policies and lookup indexes — in
   * EVERY tenant schema, over that tenant's own sensor_metrics hypertable.
   *
   * Runs on a single QueryRunner in autocommit (no wrapping transaction), so the
   * continuous-aggregate DDL is legal. Guarded by TimescaleDB presence + a config
   * switch. Each tenant is serialized by its own advisory lock, so replicas
   * sweeping concurrently divide the work instead of colliding on one lock.
   *
   * One tenant's failure does not abort the sweep — the others still get their
   * rollups — but every failure is collected and raised at the end, so a broken
   * tenant is loud rather than quietly skipped.
   */
  async ensureAggregates(): Promise<void> {
    const authoritative = resolveDbMigrateAuthoritativeFromConfig(this.configService);
    const enabled =
      this.configService.get('SENSOR_CONTINUOUS_AGGREGATES_ENABLED', 'true') === 'true';
    if (!enabled && !authoritative) {
      this.logger.log('Continuous-aggregate bootstrap disabled by config — skipping');
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();

      if (!(await this.checkTimescaleDB(queryRunner))) {
        this.logger.warn(
          'TimescaleDB extension not present — skipping continuous-aggregate creation',
        );
        return;
      }

      const tenantSchemas = await listTenantSchemas(this.dataSource);
      if (tenantSchemas.length === 0) {
        this.logger.log('No tenant schemas present — no continuous aggregates to ensure');
        return;
      }

      const failures: string[] = [];
      let ensured = 0;
      for (const schema of tenantSchemas) {
        try {
          if (authoritative) {
            await this.verifyAggregateAuthorityForTenant(queryRunner, schema);
            ensured++;
          } else if (await this.ensureAggregatesForTenant(queryRunner, schema)) {
            ensured++;
          }
        } catch (error) {
          failures.push(`${schema}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      this.logger.log(
        `Continuous aggregates ${authoritative ? 'verified' : 'ensured'} for ` +
          `${ensured}/${tenantSchemas.length} tenant schema(s)`,
      );

      if (failures.length > 0) {
        throw new Error(
          `Continuous-aggregate ${authoritative ? 'authority verification' : 'bootstrap'} ` +
            `failed for ${failures.length} tenant(s): ` +
            failures.join('; '),
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Ensure one tenant's rollups. Returns false when another replica holds this
   * tenant's lock (that replica is creating the same views; creation is
   * idempotent so the loser need not re-run).
   *
   * The schema name is validated before it reaches any SQL, and the pinned
   * search_path is read back and verified, so the unqualified aggregate DDL
   * cannot land in the wrong schema.
   */
  private async ensureAggregatesForTenant(
    queryRunner: QueryRunner,
    tenantSchema: string,
  ): Promise<boolean> {
    const schema = validateTenantSchemaName(tenantSchema);
    const lockKey = `${SENSOR_CONTINUOUS_AGGREGATE_LOCK_PREFIX}${schema}`;

    const lockRows: Array<{ locked: boolean }> = await queryRunner.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [lockKey],
    );
    if (lockRows[0]?.locked !== true) {
      this.logger.debug(`Another instance holds the aggregate lock for ${schema} — skipping`);
      return false;
    }

    try {
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      const schemaRows: Array<{ current_schema: string }> =
        await queryRunner.query(`SELECT current_schema()`);
      if (schemaRows[0]?.current_schema !== schema) {
        throw new Error(
          `Failed to pin search_path to "${schema}" for continuous-aggregate creation ` +
            `(observed "${schemaRows[0]?.current_schema}")`,
        );
      }

      for (const { label, sql } of SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS) {
        await queryRunner.query(sql);
        this.logger.debug(`Continuous-aggregate bootstrap [${schema}]: ${label}`);
      }
      return true;
    } finally {
      await queryRunner.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
      // Leave no tenant pin on a pooled connection the next caller may reuse.
      await queryRunner.query(`SET search_path TO "$user", public`);
    }
  }

  /**
   * Production-side read-only gate. The db-migrate phase must have created all
   * rollups, assigned the dedicated TimescaleDB worker owner role, and granted
   * sensor runtime SELECT before this service is allowed to become ready.
   */
  private async verifyAggregateAuthorityForTenant(
    queryRunner: QueryRunner,
    tenantSchema: string,
  ): Promise<void> {
    const schema = validateTenantSchemaName(tenantSchema);
    const rows: Array<{ view_name: string; view_owner: string }> = await queryRunner.query(
      `SELECT view_name, view_owner
         FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1
          AND view_name = ANY($2::text[])`,
      [schema, SENSOR_CONTINUOUS_AGGREGATE_NAMES],
    );
    const owners = new Map(rows.map((row) => [row.view_name, row.view_owner]));
    const violations: string[] = [];

    for (const aggregate of SENSOR_CONTINUOUS_AGGREGATE_NAMES) {
      const owner = owners.get(aggregate);
      if (owner === undefined) {
        violations.push(`${aggregate} missing`);
      } else if (owner !== SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE) {
        violations.push(`${aggregate} owner=${owner}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(`db-migrate continuous-aggregate contract drift: ${violations.join(', ')}`);
    }

    for (const aggregate of SENSOR_CONTINUOUS_AGGREGATE_NAMES) {
      await queryRunner.query(`SELECT 1 FROM "${schema}"."${aggregate}" LIMIT 0`);
    }
  }

  /** True when the TimescaleDB extension is installed on the target database. */
  private async checkTimescaleDB(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS exists`,
    );
    return rows[0]?.exists === true;
  }

  /**
   * Returns the last completed refresh time for each known aggregate.
   */
  async getRefreshStatus(): Promise<
    Array<{
      viewName: string;
      lastRefresh: Date | null;
      behindBy: string | null;
    }>
  > {
    const rows: Array<{ view_name: string; last_run_started_at: Date | null }> =
      await this.dataSource.query(
        `SELECT view_name, last_run_started_at
         FROM timescaledb_information.continuous_aggregate_stats
         WHERE view_name = ANY($1)`,
        [SENSOR_CONTINUOUS_AGGREGATE_NAMES],
      );

    const byName = new Map(rows.map((r) => [r.view_name, r]));

    return SENSOR_CONTINUOUS_AGGREGATE_NAMES.map((name) => {
      const row = byName.get(name);
      const lastRefresh = row?.last_run_started_at ?? null;
      let behindBy: string | null = null;
      if (lastRefresh) {
        const ms = Date.now() - lastRefresh.getTime();
        behindBy = `${Math.round(ms / 1000)}s`;
      }
      return { viewName: name, lastRefresh, behindBy };
    });
  }

  /**
   * Manually trigger a CALL refresh_continuous_aggregate() for the given view
   * over the specified window.  Use sparingly — prefer the scheduled policy
   * for routine refreshes.
   */
  async refresh(viewName: string, startTime: Date, endTime: Date): Promise<void> {
    // Validate against known views to prevent SQL injection
    const knownViews: readonly string[] = SENSOR_CONTINUOUS_AGGREGATE_NAMES;
    if (!knownViews.includes(viewName)) {
      throw new Error(`Unknown continuous aggregate: ${viewName}`);
    }

    this.logger.log(
      `Manual refresh of ${viewName} from ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    await this.dataSource.query(`CALL refresh_continuous_aggregate($1, $2, $3)`, [
      viewName,
      startTime,
      endTime,
    ]);
  }
}
