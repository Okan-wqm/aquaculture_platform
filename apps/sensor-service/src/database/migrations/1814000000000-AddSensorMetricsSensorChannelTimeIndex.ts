import { MigrationInterface } from 'typeorm';

/**
 * INERT — superseded by 1815000000000 before release.
 *
 * # What it did
 *
 * It added `(sensor_id, channel_id, time DESC)` to `sensor.sensor_metrics` so
 * the as-of reading projection's per-channel "latest value at or before T"
 * lookups would be index seeks.
 *
 * # Why it is inert now
 *
 * Telemetry moved back to where the model always declared it: each tenant's own
 * schema (SENSOR-HIGH-085). The projections read the tenant's hypertable, and
 * migration 1815000000000 creates that table WITH this index already on it. An
 * index on the shared table would sit on a table nothing reads or writes.
 *
 * Two further reasons not to keep the statement, both raised by the pre-merge
 * audit of this change:
 *
 *  1. Its own justification was wrong. The docblock claimed both the LATERAL
 *     form and a `DISTINCT ON (sensor_id, channel_id)` form "collapse to an
 *     index-only descent". Only the bounded LATERAL ... LIMIT 1 form is a
 *     descent; DISTINCT ON is a full ordered scan plus a Unique node. The two
 *     reads that used DISTINCT ON were rewritten rather than indexed around.
 *  2. Non-CONCURRENT CREATE INDEX on a hypertable takes a lock that propagates
 *     to every chunk, stalling ingestion for the build. Paying that on a table
 *     nothing queries would be cost with no benefit.
 *
 * Emptied rather than deleted for the same reason as 1813000000000: development
 * and CI databases have already run it, and removing the file would leave their
 * ledgers naming a migration that no longer exists.
 */
export class AddSensorMetricsSensorChannelTimeIndex1814000000000 implements MigrationInterface {
  name = 'AddSensorMetricsSensorChannelTimeIndex1814000000000';

  public async up(): Promise<void> {
    // Intentionally empty — 1815000000000 creates the per-tenant hypertable with
    // this index in place. See the docblock.
  }

  public async down(): Promise<void> {
    // Nothing to undo: this migration no longer changes anything.
  }
}
