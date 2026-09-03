import {
  getTenantSchemaName,
  listTenantSchemas,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Continuous Aggregate Service
 *
 * Owns the full lifecycle of the metrics_1min/1hour/1day continuous aggregates
 * over each tenant's `sensor_metrics` hypertable:
 *   - creation (idempotent, at application bootstrap — see `ensureAggregates`),
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
 * Why bootstrap-time creation rather than a migration (SENSOR-MEDIUM-066/068,
 * OPEN-ADR-030-CAGG): the shared migration runner wraps EVERY migration in an
 * explicit transaction (migration-runner.service.ts), but
 * `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` cannot run inside a
 * transaction block — and tenant provisioning is itself migration replay, so it
 * cannot create them either. This guarded, advisory-locked, idempotent bootstrap
 * IS that step: it runs the proven aggregate DDL outside any transaction (a
 * QueryRunner in autocommit).
 *
 * A tenant provisioned BETWEEN boots therefore has no rollups until the next
 * boot ensures them. That is not a silent failure: the aggregated read probes
 * for the tenant's rollup and falls back to the raw hypertable when it is
 * absent, so until the rollups exist that tenant still gets correct — merely
 * unoptimized — charts rather than an error or an empty series.
 *
 * CRITICAL-005: refresh/status were previously a 1-line stub.
 */
@Injectable()
export class ContinuousAggregateService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContinuousAggregateService.name);

  /** Known aggregate views, in dependency order (lowest → highest granularity) */
  private static readonly KNOWN_AGGREGATES = [
    'metrics_1min',
    'metrics_1hour',
    'metrics_1day',
  ] as const;

  /** Advisory-lock key prefix; one lock per tenant so replicas do not race. */
  private static readonly LOCK_PREFIX = 'sensor-continuous-aggregate-bootstrap:';

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Create the continuous aggregates at boot, once TimescaleDB is present.
   * Idempotent (every statement is IF NOT EXISTS / if_not_exists) and
   * advisory-locked so concurrent replicas do not race on creation. Fail-fast:
   * a genuine DDL error aborts boot rather than starting a service whose
   * aggregate-tier reads would error — the same discipline the migration runner
   * applies to schema delivery.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Task 4.3 (plan Task 4): the boot SWEEP is retired as the primary
    // provisioning path — the tenant provisioner's post-step owns cagg
    // creation for NEW tenants, and existing tenants enter through the
    // rate-limited RECONCILE queue. The boot pass below is a reconciler
    // SAFETY NET only: env-gated, off by default at 100-tenant scale
    // (a 100-schema DDL sweep on every replica restart is minutes of
    // boot), on for small deployments that have not yet run the
    // one-shot reconcile.
    const mode =
      this.configService.get('SENSOR_CAGG_BOOT_RECONCILE', 'true') === 'true';
    if (!mode) {
      this.logger.log(
        'SENSOR_CAGG_BOOT_RECONCILE=false — cagg provisioning owned by the provisioner post-step',
      );
      return;
    }
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
    const enabled =
      this.configService.get('SENSOR_CONTINUOUS_AGGREGATES_ENABLED', 'true') === 'true';
    if (!enabled) {
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
          if (await this.ensureAggregatesForTenant(queryRunner, schema)) {
            ensured++;
          }
        } catch (error) {
          failures.push(
            `${schema}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      this.logger.log(
        `Continuous aggregates ensured for ${ensured}/${tenantSchemas.length} tenant schema(s)`,
      );

      if (failures.length > 0) {
        throw new Error(
          `Continuous-aggregate bootstrap failed for ${failures.length} tenant(s): ` +
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
    const lockKey = `${ContinuousAggregateService.LOCK_PREFIX}${schema}`;

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
      const schemaRows: Array<{ current_schema: string }> = await queryRunner.query(
        `SELECT current_schema()`,
      );
      if (schemaRows[0]?.current_schema !== schema) {
        throw new Error(
          `Failed to pin search_path to "${schema}" for continuous-aggregate creation ` +
            `(observed "${schemaRows[0]?.current_schema}")`,
        );
      }

      for (const { label, sql } of ContinuousAggregateService.aggregateStatements()) {
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

  /** True when the TimescaleDB extension is installed on the target database. */
  private async checkTimescaleDB(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS exists`,
    );
    return rows[0]?.exists === true;
  }

  /**
   * The ordered continuous-aggregate DDL. Adapted from the proven
   * 1735900001000-CreateContinuousAggregates migration (which ran in production
   * before the baseline squash dropped it): schema-qualification is provided by
   * the pinned search_path, so the view bodies stay verbatim. Every statement is
   * idempotent (IF NOT EXISTS / if_not_exists) so re-boots are no-ops.
   */
  private static aggregateStatements(): ReadonlyArray<{ label: string; sql: string }> {
    return [
      {
        label: 'create metrics_1min',
        sql: `
          CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1min
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 minute', time) AS bucket,
            tenant_id, sensor_id, channel_id, tank_id,
            AVG(value) AS avg_value,
            MIN(value) AS min_value,
            MAX(value) AS max_value,
            STDDEV(value) AS stddev_value,
            FIRST(value, time) AS first_value,
            LAST(value, time) AS last_value,
            COUNT(*) AS sample_count,
            COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
            COUNT(*) FILTER (WHERE quality_code < 192) AS bad_count
          FROM sensor_metrics
          GROUP BY bucket, tenant_id, sensor_id, channel_id, tank_id
          WITH NO DATA`,
      },
      {
        label: 'metrics_1min real-time',
        sql: `ALTER MATERIALIZED VIEW metrics_1min SET (timescaledb.materialized_only = false)`,
      },
      {
        label: 'metrics_1min refresh policy',
        sql: `SELECT add_continuous_aggregate_policy('metrics_1min',
          start_offset => INTERVAL '24 hours',
          end_offset => INTERVAL '1 minute',
          schedule_interval => INTERVAL '1 minute',
          if_not_exists => TRUE)`,
      },
      {
        label: 'metrics_1min retention',
        sql: `SELECT add_retention_policy('metrics_1min', INTERVAL '1 year', if_not_exists => TRUE)`,
      },
      {
        label: 'create metrics_1hour',
        sql: `
          CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1hour
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 hour', bucket) AS bucket,
            tenant_id, sensor_id, channel_id, tank_id,
            AVG(avg_value) AS avg_value,
            MIN(min_value) AS min_value,
            MAX(max_value) AS max_value,
            SQRT(GREATEST(
              SUM(sample_count * (POWER(COALESCE(stddev_value, 0), 2) + POWER(COALESCE(avg_value, 0), 2)))
                / NULLIF(SUM(sample_count), 0)
              - POWER(SUM(sample_count * COALESCE(avg_value, 0)) / NULLIF(SUM(sample_count), 0), 2),
              0
            )) AS stddev_value,
            FIRST(first_value, bucket) AS first_value,
            LAST(last_value, bucket) AS last_value,
            SUM(sample_count) AS sample_count,
            SUM(good_count) AS good_count,
            SUM(bad_count) AS bad_count,
            (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct
          FROM metrics_1min
          GROUP BY time_bucket('1 hour', bucket), tenant_id, sensor_id, channel_id, tank_id
          WITH NO DATA`,
      },
      {
        label: 'metrics_1hour real-time',
        sql: `ALTER MATERIALIZED VIEW metrics_1hour SET (timescaledb.materialized_only = false)`,
      },
      {
        label: 'metrics_1hour refresh policy',
        sql: `SELECT add_continuous_aggregate_policy('metrics_1hour',
          start_offset => INTERVAL '7 days',
          end_offset => INTERVAL '1 hour',
          schedule_interval => INTERVAL '1 hour',
          if_not_exists => TRUE)`,
      },
      {
        label: 'metrics_1hour retention',
        sql: `SELECT add_retention_policy('metrics_1hour', INTERVAL '5 years', if_not_exists => TRUE)`,
      },
      {
        label: 'create metrics_1day',
        sql: `
          CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1day
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 day', bucket) AS bucket,
            tenant_id, sensor_id, channel_id, tank_id,
            AVG(avg_value) AS avg_value,
            MIN(min_value) AS min_value,
            MAX(max_value) AS max_value,
            SQRT(GREATEST(
              SUM(sample_count * (POWER(COALESCE(stddev_value, 0), 2) + POWER(COALESCE(avg_value, 0), 2)))
                / NULLIF(SUM(sample_count), 0)
              - POWER(SUM(sample_count * COALESCE(avg_value, 0)) / NULLIF(SUM(sample_count), 0), 2),
              0
            )) AS stddev_value,
            FIRST(first_value, bucket) AS first_value,
            LAST(last_value, bucket) AS last_value,
            SUM(sample_count) AS sample_count,
            SUM(good_count) AS good_count,
            SUM(bad_count) AS bad_count,
            (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct
          FROM metrics_1hour
          GROUP BY time_bucket('1 day', bucket), tenant_id, sensor_id, channel_id, tank_id
          WITH NO DATA`,
      },
      {
        label: 'metrics_1day real-time',
        sql: `ALTER MATERIALIZED VIEW metrics_1day SET (timescaledb.materialized_only = false)`,
      },
      {
        label: 'metrics_1day refresh policy',
        sql: `SELECT add_continuous_aggregate_policy('metrics_1day',
          start_offset => INTERVAL '30 days',
          end_offset => INTERVAL '1 day',
          schedule_interval => INTERVAL '1 day',
          if_not_exists => TRUE)`,
      },
      {
        label: 'metrics_1min sensor index',
        sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_sensor_bucket" ON metrics_1min (sensor_id, bucket DESC)`,
      },
      {
        label: 'metrics_1min channel index',
        sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_channel_bucket" ON metrics_1min (channel_id, bucket DESC)`,
      },
      {
        label: 'metrics_1hour sensor index',
        sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1hour_sensor_bucket" ON metrics_1hour (sensor_id, bucket DESC)`,
      },
      {
        label: 'metrics_1day sensor index',
        sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1day_sensor_bucket" ON metrics_1day (sensor_id, bucket DESC)`,
      },
    ];
  }

  /**
   * Task 4.4: the last completed refresh per aggregate FOR ONE TENANT.
   *
   * The previous signature filtered `view_name = ANY(...)` UNQUALIFIED —
   * with N tenant schemas the same three view names appear N times and the
   * dedup Map kept an ARBITRARY tenant's row. Now requires tenantId and
   * filters `view_schema` through the validated SSoT.
   */
  async getRefreshStatus(tenantId: string): Promise<Array<{
    viewName: string;
    lastRefresh: Date | null;
    behindBy: string | null;
  }>> {
    const viewSchema = validateTenantSchemaName(getTenantSchemaName(tenantId));
    const rows: Array<{ view_name: string; last_run_started_at: Date | null }> =
      await this.dataSource.query(
        `SELECT view_name, last_run_started_at
         FROM timescaledb_information.continuous_aggregate_stats
         WHERE view_schema = $1 AND view_name = ANY($2)`,
        [viewSchema, ContinuousAggregateService.KNOWN_AGGREGATES],
      );

    const byName = new Map(rows.map((r) => [r.view_name, r]));

    return ContinuousAggregateService.KNOWN_AGGREGATES.map((name) => {
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
  async refresh(
    tenantId: string,
    viewName: string,
    startTime: Date,
    endTime: Date,
  ): Promise<void> {
    // Validate against known views to prevent SQL injection
    const knownViews: readonly string[] = ContinuousAggregateService.KNOWN_AGGREGATES;
    if (!knownViews.includes(viewName)) {
      throw new Error(`Unknown continuous aggregate: ${viewName}`);
    }

    // Task 4.4: REFUSING a window older than the lower tier's retention
    // horizon. metrics_1min rows older than 1 year are GONE; refreshing
    // metrics_1hour over such a window would recompute those buckets from
    // an EMPTY 1min view and WIPE the 5-year materialization — the exact
    // operator "fix" footgun the plan names.
    const horizon = ContinuousAggregateService.REFRESH_HORIZONS[viewName];
    if (horizon !== undefined && startTime < new Date(Date.now() - horizon)) {
      throw new Error(
        `Refresh window starts ${startTime.toISOString()}, before the ` +
          `${viewName} lower-tier retention horizon (${horizon / 86_400_000} days) — ` +
          `refreshing would recompute from dropped source data and wipe the materialization`,
      );
    }

    const viewSchema = validateTenantSchemaName(getTenantSchemaName(tenantId));
    this.logger.log(
      `Manual refresh of ${viewSchema}.${viewName} from ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    await this.dataSource.query(
      `CALL refresh_continuous_aggregate($1, $2, $3)`,
      [`${viewSchema}.${viewName}`, startTime, endTime],
    );
  }

  /** Lower-tier retention horizons (ms) a refresh may NEVER cross. */
  private static readonly REFRESH_HORIZONS: Readonly<Record<string, number>> = {
    metrics_1hour: 365 * 24 * 60 * 60 * 1000, // 1min retained 1y
    metrics_1day: 365 * 24 * 60 * 60 * 1000, // 1hour retained 5y, but 1min lineage caps us
  };
}
