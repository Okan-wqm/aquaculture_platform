import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create Sensor Metrics Table with TimescaleDB Optimizations
 *
 * This migration creates the narrow table design for sensor data:
 * - sensor_metrics: Core time-series table (TimescaleDB hypertable)
 * - Optimized indexes for common query patterns
 * - Compression policy for data older than 7 days
 * - Retention policy for data older than 90 days
 *
 * Also updates sensor_data_channels with new columns for enhanced calibration
 * and protocol configuration.
 */
export class CreateSensorMetrics1735900000000 implements MigrationInterface {
  name = 'CreateSensorMetrics1735900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running CreateSensorMetrics migration in schema:', schema);

    // 1. Create sensor_metrics table
    const tableExists = await this.tableExists(queryRunner, 'sensor_metrics');
    if (!tableExists) {
      await queryRunner.query(`
        CREATE TABLE "sensor_metrics" (
          "time" TIMESTAMPTZ NOT NULL,
          "sensor_id" UUID NOT NULL,
          "channel_id" UUID NOT NULL,
          "tenant_id" UUID NOT NULL,
          "site_id" UUID,
          "department_id" UUID,
          "system_id" UUID,
          "equipment_id" UUID,
          "tank_id" UUID,
          "pond_id" UUID,
          "farm_id" UUID,
          "raw_value" DOUBLE PRECISION NOT NULL,
          "value" DOUBLE PRECISION NOT NULL,
          "quality_code" SMALLINT NOT NULL DEFAULT 192,
          "quality_bits" SMALLINT NOT NULL DEFAULT 0,
          "source_protocol" VARCHAR(20),
          "source_timestamp" TIMESTAMPTZ,
          "ingestion_latency_ms" INTEGER,
          "batch_id" UUID,
          PRIMARY KEY ("time", "sensor_id", "channel_id")
        )
      `);
      console.log('Created sensor_metrics table');

      // 2. Convert to TimescaleDB hypertable
      try {
        await queryRunner.query(`
          SELECT create_hypertable(
            'sensor_metrics',
            'time',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
          )
        `);
        console.log('Converted sensor_metrics to TimescaleDB hypertable');
      } catch (error) {
        console.warn('TimescaleDB not available or hypertable creation failed:', error);
      }

      // 3. Create indexes for common query patterns
      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_sensor_time"
        ON "sensor_metrics" ("sensor_id", "time" DESC)
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_channel_time"
        ON "sensor_metrics" ("channel_id", "time" DESC)
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_tenant_time"
        ON "sensor_metrics" ("tenant_id", "time" DESC)
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_tank_time"
        ON "sensor_metrics" ("tank_id", "time" DESC)
        WHERE "tank_id" IS NOT NULL
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_equipment_time"
        ON "sensor_metrics" ("equipment_id", "time" DESC)
        WHERE "equipment_id" IS NOT NULL
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_quality"
        ON "sensor_metrics" ("quality_code", "time" DESC)
        WHERE "quality_code" != 192
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_metrics_batch"
        ON "sensor_metrics" ("batch_id")
        WHERE "batch_id" IS NOT NULL
      `);

      console.log('Created indexes for sensor_metrics');

      // 4. Enable TimescaleDB compression
      try {
        await queryRunner.query(`
          ALTER TABLE "sensor_metrics" SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tenant_id, sensor_id, channel_id',
            timescaledb.compress_orderby = 'time DESC'
          )
        `);

        // Compress chunks older than 7 days
        await queryRunner.query(`
          SELECT add_compression_policy('sensor_metrics', INTERVAL '7 days', if_not_exists => TRUE)
        `);
        console.log('Enabled compression policy for sensor_metrics (7 days)');
      } catch (error) {
        console.warn('Compression policy creation failed (TimescaleDB feature):', error);
      }

      // 5. Add retention policy (90 days)
      try {
        await queryRunner.query(`
          SELECT add_retention_policy('sensor_metrics', INTERVAL '90 days', if_not_exists => TRUE)
        `);
        console.log('Added retention policy for sensor_metrics (90 days)');
      } catch (error) {
        console.warn('Retention policy creation failed (TimescaleDB feature):', error);
      }
    } else {
      console.log('sensor_metrics table already exists, skipping creation');
    }

    // 6. Update sensor_data_channels with new columns
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'unit_symbol', 'VARCHAR(10)');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'physical_min', 'DOUBLE PRECISION');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'physical_max', 'DOUBLE PRECISION');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'operational_min', 'DOUBLE PRECISION');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'operational_max', 'DOUBLE PRECISION');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'next_calibration_due', 'TIMESTAMPTZ');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'calibration_polynomial', 'JSONB');
    await this.addColumnIfNotExists(queryRunner, 'sensor_data_channels', 'protocol_config', 'JSONB');

    console.log('Updated sensor_data_channels with new columns');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove policies first (TimescaleDB)
    try {
      await queryRunner.query(`SELECT remove_retention_policy('sensor_metrics', if_exists => TRUE)`);
      await queryRunner.query(`SELECT remove_compression_policy('sensor_metrics', if_exists => TRUE)`);
    } catch (error) {
      console.warn('Policy removal failed:', error);
    }

    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_sensor_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_channel_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_tenant_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_tank_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_equipment_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_quality"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_batch"`);

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor_metrics"`);

    // Remove new columns from sensor_data_channels
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'unit_symbol');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'physical_min');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'physical_max');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'operational_min');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'operational_max');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'next_calibration_due');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'calibration_polynomial');
    await this.dropColumnIfExists(queryRunner, 'sensor_data_channels', 'protocol_config');

    console.log('Rolled back CreateSensorMetrics migration');
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = $1
      )
    `, [tableName]);
    return result[0]?.exists === true;
  }

  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
      )
    `, [tableName, columnName]);
    return result[0]?.exists === true;
  }

  private async addColumnIfNotExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    columnType: string
  ): Promise<void> {
    const exists = await this.columnExists(queryRunner, tableName, columnName);
    if (!exists) {
      await queryRunner.query(`
        ALTER TABLE "${tableName}"
        ADD COLUMN "${columnName}" ${columnType}
      `);
      console.log(`Added column ${columnName} to ${tableName}`);
    }
  }

  private async dropColumnIfExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string
  ): Promise<void> {
    const exists = await this.columnExists(queryRunner, tableName, columnName);
    if (exists) {
      await queryRunner.query(`
        ALTER TABLE "${tableName}"
        DROP COLUMN "${columnName}"
      `);
    }
  }
}
