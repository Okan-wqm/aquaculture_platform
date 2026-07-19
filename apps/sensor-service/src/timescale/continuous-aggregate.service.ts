import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Continuous Aggregate Service
 *
 * Owns the full lifecycle of the sensor.metrics_1min/1hour/1day continuous
 * aggregates over sensor.sensor_metrics:
 *   - creation (idempotent, at application bootstrap — see `ensureAggregates`),
 *   - runtime visibility into refresh state (`getRefreshStatus`),
 *   - on-demand manual refresh of lagging aggregates (`refresh`).
 *
 * Why bootstrap-time creation rather than a migration (SENSOR-MEDIUM-066/068,
 * OPEN-ADR-030-CAGG): the shared migration runner wraps EVERY migration in an
 * explicit transaction (migration-runner.service.ts), but
 * `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` cannot run inside a
 * transaction block. The Baseline migration created the sensor_metrics
 * hypertable but left the rollup views to "a separate runbook step" for exactly
 * this reason (tracked as OPEN-ADR-030-CAGG). This guarded, advisory-locked, idempotent
 * bootstrap IS that step: it runs the proven aggregate DDL outside any
 * transaction (a QueryRunner in autocommit), so the views MetricQueryService
 * and getRefreshStatus/refresh below depend on actually exist.
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

  /** Schema that owns the sensor_metrics hypertable + its rollup views. */
  private static readonly SCHEMA = 'sensor';

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
    await this.ensureAggregates();
  }

  /**
   * Idempotently create the metrics_1min/1hour/1day continuous aggregates,
   * their real-time flag, refresh + retention policies, and lookup indexes.
   *
   * Runs on a single QueryRunner in autocommit (no wrapping transaction), so
   * the continuous-aggregate DDL is legal; pins search_path to the sensor
   * schema so the unqualified proven DDL lands there and the cascading views
   * resolve their parents. Guarded by TimescaleDB presence + a config switch,
   * and serialized by an advisory lock so replicas do not race.
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

      // Serialize creation across replicas. try-lock (not blocking): if another
      // instance already holds it, that instance is creating the same views —
      // skip cleanly (creation is idempotent, so the loser need not re-run).
      const lockRows: Array<{ locked: boolean }> = await queryRunner.query(
        `SELECT pg_try_advisory_lock(hashtext('sensor-continuous-aggregate-bootstrap')) AS locked`,
      );
      if (lockRows[0]?.locked !== true) {
        this.logger.log(
          'Another instance holds the continuous-aggregate bootstrap lock — skipping',
        );
        return;
      }

      try {
        // Pin search_path so the unqualified DDL creates/resolves views in the
        // sensor schema (where sensor_metrics lives), then verify the pin.
        await queryRunner.query(
          `SET search_path TO "${ContinuousAggregateService.SCHEMA}", public`,
        );
        const schemaRows: Array<{ current_schema: string }> = await queryRunner.query(
          `SELECT current_schema()`,
        );
        if (schemaRows[0]?.current_schema !== ContinuousAggregateService.SCHEMA) {
          throw new Error(
            `Failed to pin search_path to "${ContinuousAggregateService.SCHEMA}" for ` +
              `continuous-aggregate creation (observed "${schemaRows[0]?.current_schema}")`,
          );
        }

        for (const { label, sql } of ContinuousAggregateService.aggregateStatements()) {
          await queryRunner.query(sql);
          this.logger.log(`Continuous-aggregate bootstrap: ${label}`);
        }
        this.logger.log('Continuous aggregates ensured (metrics_1min/1hour/1day)');
      } finally {
        await queryRunner.query(
          `SELECT pg_advisory_unlock(hashtext('sensor-continuous-aggregate-bootstrap'))`,
        );
      }
    } finally {
      await queryRunner.release();
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
          start_offset => INTERVAL '3 minutes',
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
          start_offset => INTERVAL '3 hours',
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
          start_offset => INTERVAL '3 days',
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
   * Returns the last completed refresh time for each known aggregate.
   */
  async getRefreshStatus(): Promise<Array<{
    viewName: string;
    lastRefresh: Date | null;
    behindBy: string | null;
  }>> {
    const rows: Array<{ view_name: string; last_run_started_at: Date | null }> =
      await this.dataSource.query(
        `SELECT view_name, last_run_started_at
         FROM timescaledb_information.continuous_aggregate_stats
         WHERE view_name = ANY($1)`,
        [ContinuousAggregateService.KNOWN_AGGREGATES],
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
    viewName: string,
    startTime: Date,
    endTime: Date,
  ): Promise<void> {
    // Validate against known views to prevent SQL injection
    const knownViews: readonly string[] = ContinuousAggregateService.KNOWN_AGGREGATES;
    if (!knownViews.includes(viewName)) {
      throw new Error(`Unknown continuous aggregate: ${viewName}`);
    }

    this.logger.log(
      `Manual refresh of ${viewName} from ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    await this.dataSource.query(
      `CALL refresh_continuous_aggregate($1, $2, $3)`,
      [viewName, startTime, endTime],
    );
  }
}
