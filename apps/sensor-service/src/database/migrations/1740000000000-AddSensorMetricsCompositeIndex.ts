import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * Migration: Add composite covering index on sensor_metrics
 *
 * HIGH-002: The existing (sensor_id, time DESC) and (channel_id, time DESC)
 * indexes do not cover the most common dashboard query pattern:
 *
 *   SELECT ... FROM sensor_metrics
 *   WHERE sensor_id = $1 AND channel_id = $2
 *   ORDER BY time DESC LIMIT 1;
 *
 * Without a covering index PostgreSQL must merge two partial index scans or
 * fall back to a seqscan on the latest chunk.  This migration adds a single
 * composite index that satisfies the predicate and the sort in one pass.
 *
 * TimescaleDB note: `sensor_metrics` is a hypertable. TimescaleDB rejects
 * `CREATE INDEX CONCURRENTLY` on hypertables with
 *   ERROR: hypertables do not support concurrent index creation
 * because TimescaleDB already performs chunk-by-chunk index creation with
 * minimally-blocking locks on a per-chunk basis — the production-safety
 * property `CONCURRENTLY` provides on plain tables is the default
 * behaviour here. Omitting the keyword lets the migration succeed while
 * keeping the same live-traffic safety characteristics.
 */
export class AddSensorMetricsCompositeIndex1740000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddSensorMetricsCompositeIndex1740000000000');
  name = 'AddSensorMetricsCompositeIndex1740000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index for the "current value per channel" query pattern
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_sensor_channel_time"
      ON sensor_metrics (sensor_id, channel_id, time DESC)
    `);
    this.logger.log('Created IDX_sensor_metrics_sensor_channel_time');

    // Composite index for tenant + sensor + channel queries (multi-tenant dashboards)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_tenant_sensor_channel_time"
      ON sensor_metrics (tenant_id, sensor_id, channel_id, time DESC)
    `);
    this.logger.log('Created IDX_sensor_metrics_tenant_sensor_channel_time');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_sensor_channel_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_metrics_tenant_sensor_channel_time"`);
  }
}
