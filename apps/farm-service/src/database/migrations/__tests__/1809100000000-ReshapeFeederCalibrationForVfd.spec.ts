import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { ReshapeFeederCalibrationForVfd1809100000000 } from '../1809100000000-ReshapeFeederCalibrationForVfd';

/**
 * SQL-shape guard for the calibration reshape.
 *
 * The behavioural proof lives in
 * `src/__tests__/e2e/feeder-calibration-physics.postgres.spec.ts`, which runs
 * this migration against a real Postgres and then tries to store every wrong
 * row. That suite is excluded from the unit lane (it needs a container), so
 * this spec keeps the load-bearing shapes under the gate that runs on every
 * change — the same reasoning that put the other migration specs here.
 */
describe('ReshapeFeederCalibrationForVfd1809100000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  async function upSql(): Promise<string> {
    await new ReshapeFeederCalibrationForVfd1809100000000().up(queryRunner);
    return queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
  }

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('pins a calibration row’s physics to its feeder rather than trusting the writer', async () => {
    const sql = await upSql();

    // The mode is an FK target, not a free column: that is what makes a
    // grams-per-shot row on a VFD auger unstorable by ANY writer.
    expect(sql).toContain(
      'CONSTRAINT "UQ_fcap_mode" UNIQUE ("tenant_id", "equipment_id", "dosing_mode")',
    );
    expect(sql).toContain('ADD CONSTRAINT "FK_fcal_feeder_mode"');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "equipment_id", "dosing_mode")');
    // RESTRICT, so a commissioned feeder's mode cannot be flipped out from
    // under live calibrations.
    expect(sql).toContain('ON UPDATE RESTRICT ON DELETE CASCADE');

    // Each physics field is tied to its mode by an EQUIVALENCE, so both a
    // missing field and a stray one are rejected.
    expect(sql).toContain(
      'CHECK (("dosing_mode" = \'discrete\') = ("grams_per_dispensing" IS NOT NULL))',
    );
    expect(sql).toContain(
      'CHECK (("dosing_mode" = \'continuous\') = ("grams_per_minute" IS NOT NULL))',
    );
    expect(sql).toContain(
      'CHECK (("dosing_mode" = \'continuous\') = ("reference_speed_hz" IS NOT NULL))',
    );
  });

  it('keeps a flow measurement inside the band it claims to hold on', async () => {
    const sql = await upSql();

    // The band copy is FK-carried with ON UPDATE CASCADE, which is what turns
    // "reference speed inside the band" into a LOCAL check while leaving the
    // band itself stated exactly once, on the machine.
    expect(sql).toContain(
      'CONSTRAINT "UQ_fcap_speed_band"\n          UNIQUE ("tenant_id", "equipment_id", "min_speed_hz", "max_speed_hz")',
    );
    expect(sql).toContain('ADD CONSTRAINT "FK_fcal_feeder_speed_band"');
    expect(sql).toContain('ON UPDATE CASCADE ON DELETE CASCADE');
    expect(sql).toContain('ADD CONSTRAINT "CK_fcal_reference_speed_in_band"');
    expect(sql).toContain('"reference_speed_hz" >= "min_speed_hz"');
    expect(sql).toContain('"reference_speed_hz" <= "max_speed_hz"');
  });

  it('makes weight-based dispensing without a bound weight source uncommittable', async () => {
    const sql = await upSql();

    expect(sql).toContain(
      'CHECK (("dispense_control" = \'weight_based\') = ("weight_sensor_id" IS NOT NULL))',
    );
  });

  it('leaves silo capacity exactly one home', async () => {
    const sql = await upSql();

    // Migrated onto the machine…
    expect(sql).toContain('MAX(NULLIF(c."silo_capacity_kg", 0))');
    // …and the per-feed column is DROPPED, so the duplicate cannot reappear.
    expect(sql).toContain('DROP COLUMN IF EXISTS "silo_capacity_kg"');
  });

  it('re-keys on feed identity and removes the diameter key entirely', async () => {
    const sql = await upSql();

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "feed_id" uuid');
    expect(sql).toContain('ADD CONSTRAINT "FK_fcal_feed"');
    expect(sql).toContain('REFERENCES "feeds" ("id")');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fcal_tenant_equipment_feed"');
    // Backfilled only where the old key resolves to exactly ONE live feed —
    // two 4 mm feeds means the row never recorded which it calibrated.
    expect(sql).toContain('HAVING COUNT(*) = 1');
    expect(sql).toContain('DELETE FROM "feeder_calibrations" WHERE "feed_id" IS NULL');
    expect(sql).toContain('DROP COLUMN IF EXISTS "feed_size_mm"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "feed_size_label"');
  });

  it('keeps the DDL schema-unqualified so every tenant schema gets its own copy', async () => {
    const sql = await upSql();

    expect(sql).not.toContain('"farm"."feeder_capabilities"');
    expect(sql).not.toContain('"farm"."feeder_calibrations"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "feeder_capabilities"');
  });
});
