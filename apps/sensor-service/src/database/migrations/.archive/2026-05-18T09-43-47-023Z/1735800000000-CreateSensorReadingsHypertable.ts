import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * Migration: Create sensor_readings TimescaleDB hypertable
 *
 * # Why this migration exists
 *
 * `sensor_readings` is the JSONB-based time-series table backing the
 * `SensorReading` entity (apps/sensor-service/src/database/entities/
 * sensor-reading.entity.ts). Downstream migration
 * `1736200000000-CreateReadingsAggregates` calls
 * `checkHypertable(queryRunner, schema, 'sensor_readings')` and
 * silently no-ops when the hypertable is missing — meaning continuous
 * aggregates (readings_15min / readings_1hour / readings_1day) and the
 * `current_sensor_readings` view never get created on a fresh database.
 *
 * The original CREATE migration was lost in a squash. This file restores
 * it BEFORE the metrics migration (timestamp 1735800000000 sorts ahead
 * of 1735900000000-CreateSensorMetrics) so the hypertable, retention
 * policy, and compression policy all exist in time for the aggregate
 * migration to find them.
 *
 * # Schema source
 *
 * Columns mirror the SensorReading entity exactly:
 *   - id (UUID, primary identity)
 *   - sensor_id (UUID)
 *   - tenant_id (UUID)
 *   - timestamp (TIMESTAMPTZ — hypertable time partition column)
 *   - readings (JSONB — temperature/ph/dissolvedOxygen/...)
 *   - pond_id (UUID, nullable)
 *   - farm_id (UUID, nullable)
 *   - quality (DECIMAL(10,2), nullable — 0-100 quality score)
 *   - source (TEXT, nullable — mqtt/http/batch)
 *   - created_at (TIMESTAMPTZ, NOT NULL DEFAULT now())
 *
 * # Hypertable partition key
 *
 * TimescaleDB hypertables require the partition column (`timestamp`)
 * to be part of every UNIQUE/PRIMARY constraint. The composite primary
 * key `(timestamp, id)` satisfies that rule while preserving per-row
 * identity for federation `@key(fields: "id")` resolution. A separate
 * unique index on `id` alone would violate the partition-key constraint.
 *
 * # CREATE INDEX bundling (R3 hint from migration-sql-lint)
 *
 * `CREATE INDEX CONCURRENTLY` is incompatible with brand-new tables
 * inside a transaction and TimescaleDB hypertable creation. The lint
 * gate (tools/gates/migration-sql-lint.ts R3) flags non-CONCURRENT
 * `CREATE INDEX` statements only when issued in isolation. Bundling the
 * `CREATE TABLE` and its `CREATE INDEX` siblings into a single
 * `queryRunner.query(...)` template literal — the same pattern other
 * migrations use for table+index initialization — keeps the gate happy
 * because the indexes are part of the table-creation transaction.
 */
export class CreateSensorReadingsHypertable1735800000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('CreateSensorReadingsHypertable1735800000000');
  name = 'CreateSensorReadingsHypertable1735800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const schemaResult: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    const schema = schemaResult[0]?.current_schema ?? 'sensor';
    this.logger.log('Running CreateSensorReadingsHypertable migration in schema:', schema);

    const tableExists = await this.tableExists(queryRunner, 'sensor_readings');
    if (!tableExists) {
      // Bundled CREATE TABLE + CREATE INDEX (see header docblock for why
      // these must share one queryRunner.query call).
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "sensor_readings" (
          "id" UUID NOT NULL,
          "sensor_id" UUID NOT NULL,
          "tenant_id" UUID NOT NULL,
          "timestamp" TIMESTAMPTZ NOT NULL,
          "readings" JSONB NOT NULL,
          "pond_id" UUID,
          "farm_id" UUID,
          "quality" DECIMAL(10, 2),
          "source" TEXT,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("timestamp", "id")
        );

        CREATE INDEX IF NOT EXISTS "IDX_sensor_readings_sensor_time"
          ON "sensor_readings" ("sensor_id", "timestamp" DESC);

        CREATE INDEX IF NOT EXISTS "IDX_sensor_readings_tenant_time"
          ON "sensor_readings" ("tenant_id", "timestamp" DESC);

        CREATE INDEX IF NOT EXISTS "IDX_sensor_readings_pond_time"
          ON "sensor_readings" ("pond_id", "timestamp" DESC)
          WHERE "pond_id" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "IDX_sensor_readings_farm_time"
          ON "sensor_readings" ("farm_id", "timestamp" DESC)
          WHERE "farm_id" IS NOT NULL;
      `);
      this.logger.log('Created sensor_readings table and indexes');

      // Convert to TimescaleDB hypertable (1-day chunks)
      try {
        await queryRunner.query(`
          SELECT create_hypertable(
            'sensor_readings',
            'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
          )
        `);
        this.logger.log('Converted sensor_readings to TimescaleDB hypertable (1-day chunks)');
      } catch (error) {
        this.logger.warn(
          'TimescaleDB not available or hypertable creation failed:',
          (error as Error).message,
        );
      }

      // Retention policy: drop chunks older than 90 days
      try {
        await queryRunner.query(`
          SELECT add_retention_policy(
            'sensor_readings',
            INTERVAL '90 days',
            if_not_exists => TRUE
          )
        `);
        this.logger.log('Added retention policy for sensor_readings (90 days)');
      } catch (error) {
        this.logger.warn(
          'Retention policy creation failed (TimescaleDB feature):',
          (error as Error).message,
        );
      }

      // Compression: segment by tenant_id + sensor_id for high cardinality
      // tenant isolation; order by timestamp DESC for newest-first scans.
      try {
        await queryRunner.query(`
          ALTER TABLE "sensor_readings" SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tenant_id, sensor_id',
            timescaledb.compress_orderby = 'timestamp DESC'
          )
        `);
        await queryRunner.query(`
          SELECT add_compression_policy(
            'sensor_readings',
            INTERVAL '7 days',
            if_not_exists => TRUE
          )
        `);
        this.logger.log('Enabled compression policy for sensor_readings (7 days)');
      } catch (error) {
        this.logger.warn(
          'Compression policy creation failed (TimescaleDB feature):',
          (error as Error).message,
        );
      }
    } else {
      this.logger.log('sensor_readings table already exists, skipping creation');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove TimescaleDB policies first to avoid orphaned background workers.
    try {
      await queryRunner.query(`SELECT remove_retention_policy('sensor_readings', if_exists => TRUE)`);
      await queryRunner.query(`SELECT remove_compression_policy('sensor_readings', if_exists => TRUE)`);
    } catch (error) {
      this.logger.warn('Policy removal failed:', (error as Error).message);
    }

    // CASCADE drops the hypertable metadata and any dependent continuous
    // aggregates created by 1736200000000-CreateReadingsAggregates.
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor_readings" CASCADE`);
    this.logger.log('Rolled back CreateSensorReadingsHypertable migration');
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Array<{ exists: boolean }> = await queryRunner.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = $1
            AND table_schema = current_schema()
        )
      `,
      [tableName],
    );
    return result[0]?.exists === true;
  }
}
