import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make `relatedSensorReadingId` able to hold what it documents (SENSOR-HIGH-085).
 *
 * # The broken contract
 *
 * The column is an informational back-reference to the sensor-service reading
 * that produced a water-quality measurement, so the audit UI can offer a
 * "view source reading" link the gateway resolves through sensor-service. It was
 * typed `uuid` because a SensorReading used to BE a stored row with a uuid
 * primary key.
 *
 * A SensorReading is no longer a stored row. It is an as-of projection over the
 * tenant's sensor_metrics hypertable, and its federation `id` is an opaque
 * base64url codec of the projection's anchor — deliberately not a uuid, because
 * there is no row to have a key. A `uuid` column and an `@IsUUID()` validator
 * therefore cannot accept the very identifier they exist to store: the documented
 * capability had become impossible.
 *
 * # Why widen rather than drop
 *
 * The column is empty — nothing in the codebase writes it (the Phase 7.4
 * correlation was declared but never wired to a producer), so there is no data
 * to migrate and no value to lose. That makes both directions cheap, and the
 * question is purely which one is honest. Dropping the column would delete a
 * documented product capability because an id format changed underneath it;
 * widening restores the capability the model already promises. The federation id
 * is opaque and version-tolerant by construction, so `varchar` is the type that
 * matches what it is, and the column stays what it always was — an informational
 * pointer, never a database foreign key (sensor-service owns its own schema, and
 * a projection can be retention-aged out while the derived measurement survives).
 *
 * The index is preserved: ALTER COLUMN ... TYPE rebuilds it in place, and the
 * lookup ("which measurement came from this reading") is unchanged.
 */
export class WidenRelatedSensorReadingIdToFederationId1806800000000 implements MigrationInterface {
  name = 'WidenRelatedSensorReadingIdToFederationId1806800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guarded on the CURRENT column type, not just presence. Tenant provisioning
    // replays the whole migration set, so this runs more than once per database;
    // an unguarded ALTER ... TYPE would re-cast an already-widened column on the
    // second pass. Keyed to current_schema() so the check follows the replay
    // rather than assuming the source schema.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'water_quality_measurements'
             AND column_name = 'relatedSensorReadingId'
             AND data_type = 'uuid'
        ) THEN
          ALTER TABLE "water_quality_measurements"
            ALTER COLUMN "relatedSensorReadingId" TYPE character varying(512)
            USING "relatedSensorReadingId"::text;
        END IF;
      END $$;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting narrows the column back to uuid. Safe only while every stored
    // value is a uuid or NULL — a federation id would fail the cast, which is
    // the correct fail-closed behaviour: it refuses rather than truncating a
    // correlation pointer into something that resolves to the wrong reading.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'water_quality_measurements'
             AND column_name = 'relatedSensorReadingId'
             AND data_type = 'character varying'
        ) THEN
          ALTER TABLE "water_quality_measurements"
            ALTER COLUMN "relatedSensorReadingId" TYPE uuid
            USING "relatedSensorReadingId"::uuid;
        END IF;
      END $$;`);
  }
}
