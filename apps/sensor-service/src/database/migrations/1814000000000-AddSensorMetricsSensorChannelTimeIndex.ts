import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-HIGH-085 (as-of reading projection): add the composite index that
 * makes the per-channel "latest value where time <= T" lookup a single index
 * seek.
 *
 * A SensorReading is reconstructed as an as-of snapshot over the per-channel
 * sensor.sensor_metrics store: for each of the sensor's channels, the freshest
 * row at or before an anchor instant. The reconstruction runs one
 *   WHERE sensor_id = $s AND channel_id = $c AND time <= $t ORDER BY time DESC LIMIT 1
 * per channel (a LATERAL join), and the batch/latest reads use
 *   DISTINCT ON (sensor_id, channel_id) ... ORDER BY sensor_id, channel_id, time DESC.
 * Both collapse to an index-only descent on (sensor_id, channel_id, time DESC).
 *
 * The pre-existing indexes are (sensor_id, time) and (channel_id, time); neither
 * leads with the (sensor_id, channel_id) prefix these access patterns need, so
 * without this index each per-channel lookup degrades to a scan filtered by
 * channel_id. Adding the (sensor_id, channel_id, time DESC) index turns every
 * as-of reconstruction into bounded index seeks.
 *
 * time DESC matches the ORDER BY direction so the LIMIT 1 / DISTINCT ON first
 * row is the leading index entry (a forward read), not a backward scan.
 *
 * Plain (non-CONCURRENT) CREATE INDEX: the shared migration runner executes each
 * migration inside a transaction, and CREATE INDEX CONCURRENTLY cannot run in
 * one. On a hypertable this propagates to every chunk under the migration lock;
 * the sensor_metrics store is index-add-safe at migration time (cold start,
 * pre-traffic). IF NOT EXISTS keeps the migration idempotent.
 */
export class AddSensorMetricsSensorChannelTimeIndex1814000000000
  implements MigrationInterface
{
  name = 'AddSensorMetricsSensorChannelTimeIndex1814000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_sensor_metrics_sensor_channel_time"
         ON sensor.sensor_metrics (sensor_id, channel_id, "time" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS sensor."idx_sensor_metrics_sensor_channel_time"`,
    );
  }
}
