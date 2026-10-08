import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a channel's unit or measured quantity last changed
 * (`sensor_data_channels.measurement_configured_at`).
 *
 * # Why
 *
 * Samples carry no unit: a value means what the channel's unit and quantity
 * say. When an operator re-labels an H2S channel from mg/L to µg/L, the
 * samples taken before the edit were reported under the old meaning, and
 * pairing them with the new unit is a thousandfold error. The sensor service
 * cannot tell whether an edit corrected a label or followed a device change,
 * so it never pairs a sample with a configuration newer than the sample: the
 * channel description reports only samples taken at or after this instant.
 *
 * NULL for every existing row ("not changed since tracking began") and set by
 * the one write path whenever the unit or the declared quantity changes.
 *
 * # Tenant routing
 *
 * Per-tenant table: run once per schema with the search_path pinned (the
 * orchestrator), unqualified, guarded for schemas without the table.
 * Blue-green safe: nullable, no default. `down` drops the column.
 */
export class AddChannelMeasurementConfiguredAt1821000000000 implements MigrationInterface {
  name = 'AddChannelMeasurementConfiguredAt1821000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasChannelTable(queryRunner))) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(
      `ALTER TABLE "sensor_data_channels"
         ADD COLUMN IF NOT EXISTS "measurement_configured_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasChannelTable(queryRunner))) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(
      `ALTER TABLE "sensor_data_channels" DROP COLUMN IF EXISTS "measurement_configured_at"`,
    );
  }
}

async function hasChannelTable(queryRunner: QueryRunner): Promise<boolean> {
  const present: Array<{ ready: boolean }> = await queryRunner.query(
    `SELECT to_regclass('sensor_data_channels') IS NOT NULL AS ready`,
  );
  return present[0]?.ready === true;
}
