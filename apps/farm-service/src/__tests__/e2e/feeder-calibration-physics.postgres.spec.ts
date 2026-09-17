/**
 * Proof that the four calibration defects are UNREPRESENTABLE in the database,
 * not merely rejected by a handler.
 *
 * WHY raw SQL: the operator asked for calibration a drive can be commanded
 * from, and a wrong calibration drives an actuator. A test that goes through
 * the command handler proves only that the handler behaves; it says nothing
 * about a psql session, a data-fix script, or the next service to touch this
 * table. Every write below hits the tables with `dataSource.query(...)`,
 * bypassing NestJS, TypeORM entities and the handler entirely. If any of these
 * guarantees lived in the service layer, every test here would pass while the
 * invariant was wide open.
 *
 * What is proved:
 *   - a feeder is one kind of machine, and a calibration carrying the OTHER
 *     kind's physics cannot be stored (2.1);
 *   - a flow rate cannot exist without the speed it was measured at, and that
 *     speed cannot sit outside the drive's commissioned band — nor can the band
 *     be narrowed past a stored measurement (2.1);
 *   - the calibration key is a feed IDENTITY with a foreign key behind it, so a
 *     diameter or a typo is unstorable (2.2);
 *   - silo capacity has exactly ONE home; there is no second column for a
 *     conflicting copy to live in (2.3);
 *   - weight-based dispensing without a bound weight source cannot commit (2.4);
 *   - the data migration recovers the feed identity where it is recoverable and
 *     collapses the duplicated silo capacity to a single value.
 */
import 'reflect-metadata';

import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';

import { CreateFeederSiloMassProjection1809200000000 } from '../../database/migrations/1809200000000-CreateFeederSiloMassProjection';
import { ReshapeFeederCalibrationForVfd1809100000000 } from '../../database/migrations/1809100000000-ReshapeFeederCalibrationForVfd';

jest.setTimeout(180_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const AUGER = '22222222-2222-4222-8222-222222222222';
const SHOT_FEEDER = '33333333-3333-4333-8333-333333333333';
const UNCOMMISSIONED = '44444444-4444-4444-8444-444444444444';
const FEED_SLOW = '55555555-5555-4555-8555-555555555555';
const FEED_FAST = '66666666-6666-4666-8666-666666666666';
const FEED_TWIN_A = '77777777-7777-4777-8777-777777777777';
const FEED_TWIN_B = '88888888-8888-4888-8888-888888888888';
const MASS_SENSOR = '99999999-9999-4999-8999-999999999999';
/** Spare feeders, one per commissioning test, so each proves ONE constraint. */
const SPARE_NO_BAND = '10101010-1010-4010-8010-101010101010';
const SPARE_NO_SOURCE = '13131313-1313-4313-8313-131313131313';
const SPARE_STRAY_SOURCE = '14141414-1414-4414-8414-141414141414';
const SPARE_WEIGHT_BASED = '15151515-1515-4515-8515-151515151515';

describe('feeder calibration physics (real Postgres, service layer bypassed)', () => {
  let pg: HarnessContext | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query('CREATE SCHEMA farm');

    // Minimal stand-ins for the tables the migration references, and the
    // PRE-RESHAPE shape of feeder_calibrations so the data migration runs for
    // real rather than against an already-correct table.
    await pg.dataSource.query(`
      CREATE TABLE farm.equipment (
        "id" uuid PRIMARY KEY,
        "code" text NOT NULL
      )
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.feeds (
        "id" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "code" text NOT NULL,
        "pelletSize" numeric(5,2),
        "isDeleted" boolean NOT NULL DEFAULT false
      )
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.feeder_calibrations (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "equipment_id" uuid NOT NULL REFERENCES farm.equipment ("id"),
        "feed_size_mm" numeric(5,2) NOT NULL,
        "feed_size_label" character varying(100),
        "grams_per_dispensing" numeric(8,2) NOT NULL,
        "silo_capacity_kg" numeric(8,2) NOT NULL,
        "notes" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);

    for (const [id, code] of [
      [AUGER, 'AUGER-01'],
      [SHOT_FEEDER, 'SHOT-01'],
      [UNCOMMISSIONED, 'PUMP-01'],
      [SPARE_NO_BAND, 'SPARE-NO-BAND'],
      [SPARE_NO_SOURCE, 'SPARE-NO-SOURCE'],
      [SPARE_STRAY_SOURCE, 'SPARE-STRAY-SOURCE'],
      [SPARE_WEIGHT_BASED, 'SPARE-WEIGHT'],
    ] as const) {
      await pg.dataSource.query(`INSERT INTO farm.equipment ("id", "code") VALUES ($1, $2)`, [
        id,
        code,
      ]);
    }
    for (const [id, code, pellet] of [
      [FEED_SLOW, 'SLOW', 1.5],
      [FEED_FAST, 'FAST', 2.5],
      // Two live feeds sharing 4.00 mm — the ambiguity that IS defect 2.2.
      [FEED_TWIN_A, 'TWIN-A', 4],
      [FEED_TWIN_B, 'TWIN-B', 4],
    ] as const) {
      await pg.dataSource.query(
        `INSERT INTO farm.feeds ("id", "tenantId", "code", "pelletSize") VALUES ($1, $2, $3, $4)`,
        [id, TENANT, code, pellet],
      );
    }

    // Legacy rows: one resolvable (1.5 mm is unique), one not (4 mm is shared).
    // The two 1.5 mm/2.5 mm rows disagree about the silo — the defect in 2.3.
    await pg.dataSource.query(
      `INSERT INTO farm.feeder_calibrations
         ("tenant_id", "equipment_id", "feed_size_mm", "grams_per_dispensing", "silo_capacity_kg")
       VALUES ($1, $2, 1.5, 12, 400), ($1, $2, 2.5, 18, 500), ($1, $2, 4.0, 25, 0)`,
      [TENANT, SHOT_FEEDER],
    );

    const qr = pg.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('SET search_path TO farm, public');
      await new ReshapeFeederCalibrationForVfd1809100000000().up(qr);
      await new CreateFeederSiloMassProjection1809200000000().up(qr);
      await qr.query(`RESET search_path`);
    } finally {
      await qr.release();
    }

    // Commission the auger as a continuous machine over a 10–50 Hz band.
    await pg.dataSource.query(
      `INSERT INTO farm.feeder_capabilities
         ("tenant_id", "equipment_id", "dosing_mode", "silo_capacity_kg",
          "min_speed_hz", "max_speed_hz", "dispense_control")
       VALUES ($1, $2, 'continuous', 800, 10, 50, 'time_based')`,
      [TENANT, AUGER],
    );
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  beforeEach(async () => {
    await pg!.dataSource.query(`DELETE FROM farm.feeder_calibrations WHERE "equipment_id" = $1`, [
      AUGER,
    ]);
  });

  function insertContinuous(
    feedId: string,
    gramsPerMinute: number,
    referenceSpeedHz: number,
    band: { min: number | null; max: number | null } = { min: 10, max: 50 },
  ): Promise<unknown> {
    return pg!.dataSource.query(
      `INSERT INTO farm.feeder_calibrations
         ("tenant_id", "equipment_id", "feed_id", "dosing_mode",
          "grams_per_minute", "reference_speed_hz", "min_speed_hz", "max_speed_hz")
       VALUES ($1, $2, $3, 'continuous', $4, $5, $6, $7)`,
      [TENANT, AUGER, feedId, gramsPerMinute, referenceSpeedHz, band.min, band.max],
    );
  }

  // -------------------------------------------------------------------------
  // 2.1 — the physics of the machine
  // -------------------------------------------------------------------------

  it('stores a continuous calibration: a flow rate WITH the speed it was measured at', async () => {
    await expect(insertContinuous(FEED_SLOW, 10, 25)).resolves.toBeDefined();
    await expect(insertContinuous(FEED_FAST, 40, 25)).resolves.toBeDefined();
  });

  it('REJECTS a flow rate with no speed behind it', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_calibrations
           ("tenant_id", "equipment_id", "feed_id", "dosing_mode",
            "grams_per_minute", "min_speed_hz", "max_speed_hz")
         VALUES ($1, $2, $3, 'continuous', 10, 10, 50)`,
        [TENANT, AUGER, FEED_SLOW],
      ),
    ).rejects.toThrow(/CK_fcal_reference_speed_matches_mode/);
  });

  it('REJECTS grams-per-shot on a continuous auger', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_calibrations
           ("tenant_id", "equipment_id", "feed_id", "dosing_mode", "grams_per_dispensing",
            "grams_per_minute", "reference_speed_hz", "min_speed_hz", "max_speed_hz")
         VALUES ($1, $2, $3, 'continuous', 12.5, 10, 25, 10, 50)`,
        [TENANT, AUGER, FEED_SLOW],
      ),
    ).rejects.toThrow(/CK_fcal_discrete_shape/);
  });

  it('REJECTS a calibration whose physics disagrees with its own feeder', async () => {
    // The auger is commissioned CONTINUOUS. Declaring a discrete row for it
    // does not merely look odd — there is no matching capability key to point
    // at, so the FK refuses it.
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_calibrations
           ("tenant_id", "equipment_id", "feed_id", "dosing_mode", "grams_per_dispensing")
         VALUES ($1, $2, $3, 'discrete', 12.5)`,
        [TENANT, AUGER, FEED_SLOW],
      ),
    ).rejects.toThrow(/FK_fcal_feeder_mode/);
  });

  it('REJECTS a measurement taken outside the drive’s commissioned band', async () => {
    // 60 Hz on a drive commissioned to 50: above the band the screw under-fills
    // and the line no longer holds, so the figure describes nothing usable.
    await expect(insertContinuous(FEED_SLOW, 10, 60)).rejects.toThrow(
      /CK_fcal_reference_speed_in_band/,
    );
    await expect(insertContinuous(FEED_SLOW, 10, 5)).rejects.toThrow(
      /CK_fcal_reference_speed_in_band/,
    );
  });

  it('REJECTS a band that disagrees with the feeder’s own band', async () => {
    // The copy on the calibration row is FK-pinned; a row claiming a wider band
    // than the machine was commissioned for has no key to reference.
    await expect(insertContinuous(FEED_SLOW, 10, 25, { min: 5, max: 80 })).rejects.toThrow(
      /FK_fcal_feeder_speed_band/,
    );
  });

  it('REJECTS narrowing a feeder’s band past a measurement already stored', async () => {
    await insertContinuous(FEED_SLOW, 10, 12);

    // Raising the floor to 20 Hz would strand the 12 Hz measurement outside the
    // range it claims to hold on. The cascade rewrites the copy, the local
    // CHECK re-evaluates, and the edit dies — which is correct: that
    // measurement has to be redone before the band can move.
    await expect(
      pg!.dataSource.query(
        `UPDATE farm.feeder_capabilities SET "min_speed_hz" = 20
          WHERE "tenant_id" = $1 AND "equipment_id" = $2`,
        [TENANT, AUGER],
      ),
    ).rejects.toThrow(/CK_fcal_reference_speed_in_band/);
  });

  it('carries a band change through to every calibration copy', async () => {
    await insertContinuous(FEED_SLOW, 10, 25);

    await pg!.dataSource.query(
      `UPDATE farm.feeder_capabilities SET "max_speed_hz" = 45
        WHERE "tenant_id" = $1 AND "equipment_id" = $2`,
      [TENANT, AUGER],
    );

    const rows: Array<{ max_speed_hz: string }> = await pg!.dataSource.query(
      `SELECT "max_speed_hz" FROM farm.feeder_calibrations
        WHERE "equipment_id" = $1 AND "feed_id" = $2`,
      [AUGER, FEED_SLOW],
    );
    expect(Number(rows[0]!.max_speed_hz)).toBe(45);

    await pg!.dataSource.query(
      `UPDATE farm.feeder_capabilities SET "max_speed_hz" = 50
        WHERE "tenant_id" = $1 AND "equipment_id" = $2`,
      [TENANT, AUGER],
    );
  });

  it('REJECTS a continuous feeder commissioned without a speed band', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_capabilities
           ("tenant_id", "equipment_id", "dosing_mode", "dispense_control")
         VALUES ($1, $2, 'continuous', 'time_based')`,
        [TENANT, SPARE_NO_BAND],
      ),
    ).rejects.toThrow(/CK_fcap_(min|max)_speed_matches_mode/);
  });

  // -------------------------------------------------------------------------
  // 2.2 — the key is a feed identity
  // -------------------------------------------------------------------------

  it('REJECTS a calibration whose feed does not exist', async () => {
    await expect(insertContinuous('12121212-1212-4212-8212-121212121212', 10, 25)).rejects.toThrow(
      /FK_fcal_feed/,
    );
  });

  it('REJECTS a second calibration for the same feed on the same feeder', async () => {
    await insertContinuous(FEED_SLOW, 10, 25);
    await expect(insertContinuous(FEED_SLOW, 11, 25)).rejects.toThrow(
      /IDX_fcal_tenant_equipment_feed/,
    );
  });

  it('lets two feeds share a pellet diameter and still flow differently', async () => {
    // The whole point of re-keying: TWIN-A and TWIN-B are both 4 mm, and under
    // the old key one row claimed to calibrate both.
    await expect(insertContinuous(FEED_TWIN_A, 10, 25)).resolves.toBeDefined();
    await expect(insertContinuous(FEED_TWIN_B, 40, 25)).resolves.toBeDefined();
  });

  it('REJECTS a calibration on equipment never commissioned as a feeder', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_calibrations
           ("tenant_id", "equipment_id", "feed_id", "dosing_mode", "grams_per_dispensing")
         VALUES ($1, $2, $3, 'discrete', 12.5)`,
        [TENANT, UNCOMMISSIONED, FEED_SLOW],
      ),
    ).rejects.toThrow(/FK_fcal_feeder_mode/);
  });

  // -------------------------------------------------------------------------
  // 2.3 — silo capacity has exactly one home
  // -------------------------------------------------------------------------

  it('has nowhere to state a silo capacity twice', async () => {
    const columns: Array<{ column_name: string }> = await pg!.dataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'farm' AND table_name = 'feeder_calibrations'`,
    );
    const names = columns.map((row) => row.column_name);

    // The duplicate cannot reappear because the column it lived in is gone —
    // together with the diameter key that made rows per-feed in the first place.
    expect(names).not.toContain('silo_capacity_kg');
    expect(names).not.toContain('feed_size_mm');
    expect(names).not.toContain('feed_size_label');

    // And the one place it does live admits at most one row per feeder.
    const capabilityColumns: Array<{ column_name: string }> = await pg!.dataSource.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'farm' AND table_name = 'feeder_capabilities'`,
    );
    expect(capabilityColumns.map((row) => row.column_name)).toContain('silo_capacity_kg');

    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_capabilities
           ("tenant_id", "equipment_id", "dosing_mode", "silo_capacity_kg", "dispense_control")
         VALUES ($1, $2, 'discrete', 999, 'time_based')`,
        [TENANT, SHOT_FEEDER],
      ),
    ).rejects.toThrow(/PK_feeder_capabilities|duplicate key/);
  });

  // -------------------------------------------------------------------------
  // 2.4 — weight-based dispensing fails closed
  // -------------------------------------------------------------------------

  it('REJECTS weight-based dispensing with no weight source bound', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_capabilities
           ("tenant_id", "equipment_id", "dosing_mode", "dispense_control")
         VALUES ($1, $2, 'discrete', 'weight_based')`,
        [TENANT, SPARE_NO_SOURCE],
      ),
    ).rejects.toThrow(/CK_fcap_weight_source_required/);
  });

  it('REJECTS a weight sensor on a feeder that dispenses by time', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_capabilities
           ("tenant_id", "equipment_id", "dosing_mode", "dispense_control", "weight_sensor_id")
         VALUES ($1, $2, 'discrete', 'time_based', $3)`,
        [TENANT, SPARE_STRAY_SOURCE, MASS_SENSOR],
      ),
    ).rejects.toThrow(/CK_fcap_weight_source_required/);
  });

  it('accepts weight-based dispensing with a bound source, and keeps its readings', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_capabilities
           ("tenant_id", "equipment_id", "dosing_mode", "dispense_control", "weight_sensor_id")
         VALUES ($1, $2, 'discrete', 'weight_based', $3)`,
        [TENANT, SPARE_WEIGHT_BASED, MASS_SENSOR],
      ),
    ).resolves.toBeDefined();

    await pg!.dataSource.query(
      `INSERT INTO farm.feeder_silo_mass_latest ("tenantId", "sensorId", "massKg", "measuredAt")
       VALUES ($1, $2, 412.5, now())`,
      [TENANT, MASS_SENSOR],
    );

    // A negative mass is a load cell drifting below its tare; the projection
    // must not hold one, because its presence is the health signal itself.
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.feeder_silo_mass_latest ("tenantId", "sensorId", "massKg", "measuredAt")
         VALUES ($1, $2, -3, now())`,
        [TENANT, '16161616-1616-4616-8616-161616161616'],
      ),
    ).rejects.toThrow(/CK_fsml_mass_non_negative/);
  });

  // -------------------------------------------------------------------------
  // The data migration
  // -------------------------------------------------------------------------

  it('recovered the feed identity where the old key resolved, and dropped it where it did not', async () => {
    const rows: Array<{ feed_id: string; grams_per_dispensing: string }> =
      await pg!.dataSource.query(
        `SELECT "feed_id", "grams_per_dispensing" FROM farm.feeder_calibrations
          WHERE "equipment_id" = $1 ORDER BY "grams_per_dispensing"`,
        [SHOT_FEEDER],
      );

    // 1.5 mm and 2.5 mm each matched exactly one live feed and carried over.
    expect(rows.map((row) => row.feed_id)).toEqual([FEED_SLOW, FEED_FAST]);
    // The 4 mm row matched TWO live feeds, so it genuinely never recorded which
    // one it calibrated and cannot be carried into a feed-keyed model.
    expect(rows).toHaveLength(2);
  });

  it('collapsed the duplicated silo capacity onto the machine', async () => {
    const rows: Array<{ silo_capacity_kg: string; dosing_mode: string; dispense_control: string }> =
      await pg!.dataSource.query(
        `SELECT "silo_capacity_kg", "dosing_mode", "dispense_control"
           FROM farm.feeder_capabilities WHERE "equipment_id" = $1`,
        [SHOT_FEEDER],
      );

    expect(rows).toHaveLength(1);
    // 400 and 500 disagreed and one row said nothing at all (0). The largest
    // stated value wins: a silo recorded as holding 500 kg holds at least 500.
    expect(Number(rows[0]!.silo_capacity_kg)).toBe(500);
    // Old rows carried grams-per-shot and no weight concept existed, so the
    // only reading the data supports is a time-based shot feeder.
    expect(rows[0]!.dosing_mode).toBe('discrete');
    expect(rows[0]!.dispense_control).toBe('time_based');
  });
});
