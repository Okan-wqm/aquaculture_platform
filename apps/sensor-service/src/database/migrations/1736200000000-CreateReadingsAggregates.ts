import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create Continuous Aggregates for Sensor Readings
 *
 * Creates materialized views for efficient time-series queries on sensor_readings.
 * Uses JSONB extraction for individual metrics aggregation.
 *
 * Views created:
 * - readings_15min: 15-minute aggregates (kept for 90 days)
 * - readings_1hour: 1-hour aggregates (kept for 2 years)
 * - readings_1day: Daily aggregates (kept forever)
 *
 * Query Strategy (based on time range):
 * - Last 6 hours:  Use raw sensor_readings with time_bucket
 * - Last 7 days:   Use readings_15min
 * - Last 30 days:  Use readings_1hour
 * - 30+ days:      Use readings_1day
 */
export class CreateReadingsAggregates1736200000000 implements MigrationInterface {
  name = 'CreateReadingsAggregates1736200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const schemaResult: Array<{ current_schema: string }> = await queryRunner.query(`SELECT current_schema()`);
    const schema = schemaResult[0]?.current_schema || 'public';
    console.log('Running CreateReadingsAggregates migration in schema:', schema);

    // Check if TimescaleDB is available
    const isTimescaleAvailable = await this.checkTimescaleDB(queryRunner);
    if (!isTimescaleAvailable) {
      console.warn('TimescaleDB not available, skipping continuous aggregates');
      return;
    }

    // Check if sensor_readings is a hypertable
    const isHypertable = await this.checkHypertable(queryRunner, schema, 'sensor_readings');
    if (!isHypertable) {
      console.warn('sensor_readings is not a hypertable, skipping continuous aggregates');
      return;
    }

    // 1. Create 15-minute aggregate
    await this.create15MinAggregate(queryRunner);

    // 2. Create 1-hour aggregate
    await this.create1HourAggregate(queryRunner);

    // 3. Create daily aggregate
    await this.createDailyAggregate(queryRunner);

    // 4. Create current readings view
    await this.createCurrentReadingsView(queryRunner);
  }

  private async create15MinAggregate(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS readings_15min
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('15 minutes', timestamp) AS bucket,
          "tenantId" AS tenant_id,
          "sensorId" AS sensor_id,

          -- Count
          COUNT(*) AS sample_count,

          -- Temperature
          AVG((readings->>'temperature')::numeric) AS avg_temperature,
          MIN((readings->>'temperature')::numeric) AS min_temperature,
          MAX((readings->>'temperature')::numeric) AS max_temperature,

          -- pH
          AVG((readings->>'ph')::numeric) AS avg_ph,
          MIN((readings->>'ph')::numeric) AS min_ph,
          MAX((readings->>'ph')::numeric) AS max_ph,

          -- Dissolved Oxygen
          AVG((readings->>'dissolvedOxygen')::numeric) AS avg_dissolved_oxygen,
          MIN((readings->>'dissolvedOxygen')::numeric) AS min_dissolved_oxygen,
          MAX((readings->>'dissolvedOxygen')::numeric) AS max_dissolved_oxygen,

          -- Salinity
          AVG((readings->>'salinity')::numeric) AS avg_salinity,
          MIN((readings->>'salinity')::numeric) AS min_salinity,
          MAX((readings->>'salinity')::numeric) AS max_salinity,

          -- Ammonia
          AVG((readings->>'ammonia')::numeric) AS avg_ammonia,
          MIN((readings->>'ammonia')::numeric) AS min_ammonia,
          MAX((readings->>'ammonia')::numeric) AS max_ammonia,

          -- Quality
          AVG(quality) AS avg_quality

        FROM sensor_readings
        GROUP BY bucket, "tenantId", "sensorId"
        WITH NO DATA
      `);
      console.log('Created readings_15min continuous aggregate');

      // Refresh policy: every 15 minutes
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('readings_15min',
          start_offset => INTERVAL '1 hour',
          end_offset => INTERVAL '15 minutes',
          schedule_interval => INTERVAL '15 minutes',
          if_not_exists => TRUE
        )
      `);

      // Retention: 90 days
      await queryRunner.query(`
        SELECT add_retention_policy('readings_15min', INTERVAL '90 days', if_not_exists => TRUE)
      `);

      // Index for fast lookups
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_readings_15min_sensor_bucket"
        ON readings_15min (sensor_id, bucket DESC)
      `);

      console.log('Added policies and index for readings_15min');
    } catch (error) {
      console.warn('Failed to create readings_15min:', (error as Error).message);
    }
  }

  private async create1HourAggregate(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1hour
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 hour', bucket) AS bucket,
          tenant_id,
          sensor_id,

          -- Count
          SUM(sample_count) AS sample_count,

          -- Temperature
          AVG(avg_temperature) AS avg_temperature,
          MIN(min_temperature) AS min_temperature,
          MAX(max_temperature) AS max_temperature,

          -- pH
          AVG(avg_ph) AS avg_ph,
          MIN(min_ph) AS min_ph,
          MAX(max_ph) AS max_ph,

          -- Dissolved Oxygen
          AVG(avg_dissolved_oxygen) AS avg_dissolved_oxygen,
          MIN(min_dissolved_oxygen) AS min_dissolved_oxygen,
          MAX(max_dissolved_oxygen) AS max_dissolved_oxygen,

          -- Salinity
          AVG(avg_salinity) AS avg_salinity,
          MIN(min_salinity) AS min_salinity,
          MAX(max_salinity) AS max_salinity,

          -- Ammonia
          AVG(avg_ammonia) AS avg_ammonia,
          MIN(min_ammonia) AS min_ammonia,
          MAX(max_ammonia) AS max_ammonia,

          -- Quality
          AVG(avg_quality) AS avg_quality

        FROM readings_15min
        GROUP BY time_bucket('1 hour', bucket), tenant_id, sensor_id
        WITH NO DATA
      `);
      console.log('Created readings_1hour continuous aggregate');

      // Refresh policy: every 1 hour
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('readings_1hour',
          start_offset => INTERVAL '4 hours',
          end_offset => INTERVAL '1 hour',
          schedule_interval => INTERVAL '1 hour',
          if_not_exists => TRUE
        )
      `);

      // Retention: 2 years
      await queryRunner.query(`
        SELECT add_retention_policy('readings_1hour', INTERVAL '2 years', if_not_exists => TRUE)
      `);

      // Index
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_readings_1hour_sensor_bucket"
        ON readings_1hour (sensor_id, bucket DESC)
      `);

      console.log('Added policies and index for readings_1hour');
    } catch (error) {
      console.warn('Failed to create readings_1hour:', (error as Error).message);
    }
  }

  private async createDailyAggregate(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1day
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', bucket) AS bucket,
          tenant_id,
          sensor_id,

          -- Count
          SUM(sample_count) AS sample_count,

          -- Temperature
          AVG(avg_temperature) AS avg_temperature,
          MIN(min_temperature) AS min_temperature,
          MAX(max_temperature) AS max_temperature,

          -- pH
          AVG(avg_ph) AS avg_ph,
          MIN(min_ph) AS min_ph,
          MAX(max_ph) AS max_ph,

          -- Dissolved Oxygen
          AVG(avg_dissolved_oxygen) AS avg_dissolved_oxygen,
          MIN(min_dissolved_oxygen) AS min_dissolved_oxygen,
          MAX(max_dissolved_oxygen) AS max_dissolved_oxygen,

          -- Salinity
          AVG(avg_salinity) AS avg_salinity,

          -- Ammonia
          AVG(avg_ammonia) AS avg_ammonia,

          -- Quality
          AVG(avg_quality) AS avg_quality

        FROM readings_1hour
        GROUP BY time_bucket('1 day', bucket), tenant_id, sensor_id
        WITH NO DATA
      `);
      console.log('Created readings_1day continuous aggregate');

      // Refresh policy: every day
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('readings_1day',
          start_offset => INTERVAL '3 days',
          end_offset => INTERVAL '1 day',
          schedule_interval => INTERVAL '1 day',
          if_not_exists => TRUE
        )
      `);

      // No retention for daily - keep forever

      // Index
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_readings_1day_sensor_bucket"
        ON readings_1day (sensor_id, bucket DESC)
      `);

      console.log('Added policies and index for readings_1day');
    } catch (error) {
      console.warn('Failed to create readings_1day:', (error as Error).message);
    }
  }

  private async createCurrentReadingsView(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`
        CREATE OR REPLACE VIEW current_sensor_readings AS
        SELECT DISTINCT ON ("sensorId")
          "sensorId" AS sensor_id,
          "tenantId" AS tenant_id,
          timestamp AS last_reading_at,
          readings,
          quality,
          source
        FROM sensor_readings
        WHERE timestamp > NOW() - INTERVAL '30 minutes'
        ORDER BY "sensorId", timestamp DESC
      `);
      console.log('Created current_sensor_readings view');
    } catch (error) {
      console.warn('Failed to create current_sensor_readings view:', (error as Error).message);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop views in reverse order
    const views = ['current_sensor_readings'];
    const aggregates = ['readings_1day', 'readings_1hour', 'readings_15min'];

    for (const view of views) {
      try {
        await queryRunner.query(`DROP VIEW IF EXISTS ${view}`);
        console.log(`Dropped ${view}`);
      } catch (error) {
        console.warn(`Failed to drop ${view}:`, (error as Error).message);
      }
    }

    for (const agg of aggregates) {
      try {
        await queryRunner.query(`
          SELECT remove_continuous_aggregate_policy('${agg}', if_exists => TRUE)
        `);
        await queryRunner.query(`
          SELECT remove_retention_policy('${agg}', if_exists => TRUE)
        `);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS ${agg} CASCADE`);
        console.log(`Dropped ${agg}`);
      } catch (error) {
        console.warn(`Failed to drop ${agg}:`, (error as Error).message);
      }
    }
  }

  private async checkTimescaleDB(queryRunner: QueryRunner): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result: Array<{ exists: boolean }> = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
        )
      `);
      return result[0]?.exists === true;
    } catch {
      return false;
    }
  }

  private async checkHypertable(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
  ): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result: Array<{ exists: boolean }> = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM timescaledb_information.hypertables
          WHERE hypertable_schema = $1 AND hypertable_name = $2
        )
      `, [schema, table]);
      return result[0]?.exists === true;
    } catch {
      return false;
    }
  }
}
