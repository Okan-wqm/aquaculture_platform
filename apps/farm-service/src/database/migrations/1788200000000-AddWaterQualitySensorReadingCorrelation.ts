import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger, pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * AddWaterQualitySensorReadingCorrelation1788200000000
 * ============================================================================
 *
 * Phase 7.4 of the "Farm modülü kalan kör noktalar" plan — the
 * cross-service correlation field that lets a `WaterQualityMeasurement`
 * row point back at the `sensor_readings` row that produced it.
 *
 * # The architectural gap this closes
 *
 * Today a WQ measurement carries a `sensorInfo` JSONB field
 * (`{ sensorId, sensorType, lastCalibration, accuracy, batteryLevel }`)
 * that names the DEVICE responsible for the reading, but NOT the
 * specific `sensor_readings` row in sensor-service that carried this
 * measurement's values onto the bus. Without that pointer, an
 * operator viewing a WQ row in farm-service has no clickable trail
 * back to the sensor-service detail (raw signal quality, anomaly
 * flags, calibration metadata for *that exact reading*).
 *
 * The plan's S1 contract block (the v3 SensorReading event published
 * with the federation correlation `parameter` field — see
 * `libs/event-contracts/src/sensor-events.ts`) already gives the
 * sensor side what it needs: every event carries the parameter
 * subject so a farm-service consumer can construct a single-axis
 * correlation. This migration adds the field on the farm-service
 * side that future consumers will populate.
 *
 * # What this migration adds
 *
 *   1. `relatedSensorReadingId UUID NULL` on `water_quality_measurements`.
 *      Nullable because:
 *        - Manual WQ measurements (operator clicks the "log
 *          measurement" button) have no upstream sensor reading.
 *        - Bulk-imported historical measurements have no upstream
 *          sensor reading.
 *        - The correlation may be added retroactively by a
 *          backfill job (a separate, optional concern).
 *      Sensor readings live in `sensor-service`; the FK is
 *      INTENTIONALLY NOT declared at the DB layer because:
 *        a) The two services share a database BUT the table lives
 *           in a different schema namespace (sensor.* vs farm.*).
 *           Cross-schema FKs survive but couple deploys, which is
 *           the wrong direction for a service boundary.
 *        b) The correlation is informational, not invariant. A
 *           sensor reading can be hard-deleted (retention policy)
 *           while the WQ row it produced remains valid; we don't
 *           want CASCADE to wipe historical WQ data.
 *      The `idx_wq_related_sensor_reading` partial index makes the
 *      lookup `WHERE relatedSensorReadingId = $1` cheap without
 *      requiring an FK constraint.
 *
 * # Indexes — split into FARM-MEDIUM-005 follow-up CONCURRENTLY migration
 *
 * Two indexes are architecturally required to land on this column
 * but are NOT created in this migration:
 *
 *   - Partial UNIQUE on `(tenantId, relatedSensorReadingId)
 *     WHERE relatedSensorReadingId IS NOT NULL` — enforces the N:1
 *     cardinality (two WQ rows must not point at the same upstream
 *     sensor reading; defends against NATS redelivery + upcaster
 *     bugs).
 *
 *   - Partial lookup on `(relatedSensorReadingId)
 *     WHERE relatedSensorReadingId IS NOT NULL` — supports the
 *     reverse query (given a sensor_reading_id, find the WQ
 *     measurement) used by the audit UI's "view source reading"
 *     link.
 *
 * Both belong in a follow-up migration with `transaction = false`
 * and `CREATE INDEX CONCURRENTLY` because creating them in-band
 * here would take ACCESS EXCLUSIVE on the tenant copies of
 * water_quality_measurements (which can carry many rows in
 * production) and stall writers. The follow-up migration also
 * needs explicit tenant-schema discovery (`SELECT schema_name
 * FROM information_schema.schemata WHERE schema_name ~
 * '^tenant_[a-f0-9]{16}$'`) to fan out CONCURRENTLY across every
 * tenant, since the runner's standard fan-out runs each migration
 * inside an outer transaction the partial-CONCURRENTLY pattern
 * cannot survive in.
 *
 * Without those indexes, queries against the new column fall back
 * to sequential scans. That is acceptable for the column-add
 * landing because no consumer has wired the field yet — the indexes
 * become load-bearing the moment the auto-correlation event-handler
 * starts populating the column at NATS-event rate.
 *
 * # Per-tenant schema strategy
 *
 * Same as every other farm-service migration: `pinSearchPath` to
 * `farm`, the migration runner re-runs the body in each
 * `tenant_<hex16>` schema. Body uses unqualified table name +
 * `current_schema()` for log tagging only.
 *
 * # Idempotency
 *
 * `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
 * make the migration safe to re-run on partially-migrated
 * environments. `down()` is the symmetric `DROP COLUMN IF EXISTS`
 * + `DROP INDEX IF EXISTS`; rollback is destructive of any
 * correlation data populated post-migration but the column is
 * additive so production rollback within the deploy window is
 * acceptable.
 *
 * # FK semantics — explicit non-decision
 *
 * The intentional choice NOT to declare a foreign key is documented
 * above. If a future architectural decision moves sensor and farm
 * into stricter cross-service event-driven correlation (rather than
 * shared-DB), removing the FK would already be a no-op.
 */
export class AddWaterQualitySensorReadingCorrelation1788200000000
  implements MigrationInterface
{
  private readonly logger = new MigrationLogger(
    'AddWaterQualitySensorReadingCorrelation1788200000000',
  );
  name = 'AddWaterQualitySensorReadingCorrelation1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    const schemaResult = await queryRunner.query('SELECT current_schema() AS schema');
    this.logger.log(
      'Running AddWaterQualitySensorReadingCorrelation in schema:',
      schemaResult,
    );

    // The unqualified table name lets the migration runner re-execute
    // this body against each tenant_<hex16> schema's copy of the table.
    // current_schema() above logs which one we're in for traceability.
    await queryRunner.query(`
      ALTER TABLE "water_quality_measurements"
      ADD COLUMN IF NOT EXISTS "relatedSensorReadingId" UUID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    await queryRunner.query(`
      ALTER TABLE "water_quality_measurements"
      DROP COLUMN IF EXISTS "relatedSensorReadingId"
    `);

    this.logger.warn(
      'Down ran — relatedSensorReadingId column dropped. ' +
        'Any correlation data populated since the up() ran is gone. ' +
        'Sensor-service event consumers expecting this column on the WQ ' +
        'row will fail until the column is re-added.',
    );
  }
}
