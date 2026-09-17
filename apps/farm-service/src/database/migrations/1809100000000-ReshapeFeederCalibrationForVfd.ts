import { MigrationInterface, QueryRunner } from 'typeorm';

const CAPABILITIES = 'feeder_capabilities';
const CALIBRATIONS = 'feeder_calibrations';

/**
 * ReshapeFeederCalibrationForVfd1809100000000
 *
 * WHAT: gives feeder calibration the physics a variable-frequency drive needs,
 * and moves the three facts that describe the MACHINE off the rows that describe
 * a FEED.
 *
 *  - `feeder_capabilities` — one row per feeder, carrying its dosing mode
 *    (shot-type or continuous auger), its silo capacity, the drive speed band
 *    its flow model is valid on, and how it knows the dose has landed (elapsed
 *    time, or a measured mass from a bound load cell).
 *  - `feeder_calibrations` — re-keyed from pellet diameter to `feed_id`, and
 *    extended with `grams_per_minute` + `reference_speed_hz` so a continuous
 *    feeder can be calibrated at all.
 *
 * ## Four defects, and how each is made unrepresentable rather than discouraged
 *
 * 1. WRONG PHYSICS. `grams_per_dispensing` models a shot feeder. A VFD-driven
 *    auger has no shot: it has a mass FLOW that rises with drive frequency, so a
 *    dose is rate × time and neither the speed nor the duration is derivable
 *    from a grams-per-shot figure. Both physics now exist, and which one a row
 *    carries is not its own choice: `FK_fcal_feeder_mode` targets
 *    `(tenant_id, equipment_id, dosing_mode)` on the capability row, so a
 *    grams-per-shot number on an auger cannot be inserted by ANY writer — ORM,
 *    raw SQL, or a data-fix script. Flipping a commissioned feeder's mode while
 *    calibrations exist is rejected (ON UPDATE RESTRICT) rather than silently
 *    invalidating them.
 *
 *    A rate is only true at the speed it was measured at, so `grams_per_minute`
 *    and `reference_speed_hz` are constrained to exist together, and the
 *    reference speed is CHECK-constrained to lie inside the feeder's validated
 *    band. The band is stated once, on the capability row; the calibration row
 *    carries a copy solely so that CHECK can be local, and
 *    `FK_fcal_feeder_speed_band` (ON UPDATE CASCADE) makes the copy incapable of
 *    differing from the original. Narrowing a band below an existing measurement
 *    therefore fails at the cascade — the correct outcome, since that
 *    measurement is now outside the range it claims to hold on.
 *
 * 2. WRONG KEY. `feed_size_mm` is a dimension, not an identity: two 4 mm feeds
 *    from different mills differ in bulk density and fat coating and flow at
 *    measurably different rates through the same auger, so one 4 mm row silently
 *    claimed to calibrate both. `feed_id` is the axis the rest of the feeding
 *    system already turns on (`ProtocolBand.feedId`), so re-keying is what makes
 *    the feed transition automatic: fish grow into the next band, the band's
 *    `feedId` changes, and the matching calibration is found by that id with no
 *    human action. Diameter is not lost — it lives on `feeds.pelletSize`, once
 *    per feed, reachable through the new FK.
 *
 * 3. DENORMALISATION. `silo_capacity_kg` sat on rows that are per-feed, so one
 *    silo's capacity was restated once per calibrated feed and the copies could
 *    disagree. It moves to the capability row and the old column is DROPPED, so
 *    the second place to write it no longer exists.
 *
 * 4. NO DISPENSE-MODE CAPABILITY. Some farms have load cells and dispense by
 *    measured weight; others dispense by time. `CK_fcap_weight_source_required`
 *    makes `weight_based` without a bound `weight_sensor_id` uncommittable. The
 *    id alone cannot prove the cell is real, so the runtime completes the guard:
 *    `feeder_silo_mass_latest` only holds rows for sensors that have actually
 *    reported, and the dose planner refuses a weight-based feeder whose reading
 *    is missing or stale.
 *
 * ## Data migration
 *
 * Every pre-existing row carries `grams_per_dispensing`, so every pre-existing
 * feeder is commissioned DISCRETE / TIME_BASED — the only reading the old data
 * supports, since no weight concept existed anywhere on the platform.
 *
 * Silo capacity collapses to `MAX(NULLIF(silo_capacity_kg, 0))` per feeder. The
 * copies could disagree and there is no record of which was meant; the largest
 * non-zero value is chosen because a silo recorded as holding N kg holds at
 * least N, and zero is treated as "never stated" because the old input accepted
 * a blank as 0.
 *
 * `feed_id` is backfilled only where the old key resolves UNAMBIGUOUSLY — where
 * exactly one live feed in the tenant has that pellet diameter. Where two feeds
 * shared a diameter the row genuinely does not record which one it calibrated
 * (that ambiguity IS defect 2), so the row cannot be carried into a model that
 * requires a feed identity, and it is deleted with the count logged. These rows
 * were write-only: nothing on the platform ever read this table.
 *
 * Both tables are TENANT-SCOPED, so the DDL is SCHEMA-UNQUALIFIED — each schema
 * pass lands the objects in its own schema (CreateFeederAssignments precedent).
 */
export class ReshapeFeederCalibrationForVfd1809100000000 implements MigrationInterface {
  name = 'ReshapeFeederCalibrationForVfd1809100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    // -----------------------------------------------------------------------
    // 1. The machine.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${CAPABILITIES}" (
        "tenant_id" uuid NOT NULL,
        "equipment_id" uuid NOT NULL,
        "dosing_mode" character varying(20) NOT NULL,
        "silo_capacity_kg" numeric(10,3),
        "min_speed_hz" numeric(6,2),
        "max_speed_hz" numeric(6,2),
        "dispense_control" character varying(20) NOT NULL,
        "weight_sensor_id" uuid,
        "notes" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_by" uuid,
        "updated_by" uuid,
        CONSTRAINT "PK_feeder_capabilities" PRIMARY KEY ("tenant_id", "equipment_id"),
        CONSTRAINT "CK_fcap_dosing_mode"
          CHECK ("dosing_mode" IN ('discrete', 'continuous')),
        CONSTRAINT "CK_fcap_dispense_control"
          CHECK ("dispense_control" IN ('time_based', 'weight_based')),
        -- A continuous feeder must declare the band its flow model holds on; a
        -- shot feeder has no speed to declare. Stated as two equivalences so
        -- neither a missing edge nor a stray one can commit.
        CONSTRAINT "CK_fcap_min_speed_matches_mode"
          CHECK (("dosing_mode" = 'continuous') = ("min_speed_hz" IS NOT NULL)),
        CONSTRAINT "CK_fcap_max_speed_matches_mode"
          CHECK (("dosing_mode" = 'continuous') = ("max_speed_hz" IS NOT NULL)),
        CONSTRAINT "CK_fcap_band_ordered"
          CHECK ("min_speed_hz" IS NULL
                 OR ("min_speed_hz" > 0 AND "max_speed_hz" >= "min_speed_hz")),
        -- Null means "not stated yet"; a stated zero is not a silo.
        CONSTRAINT "CK_fcap_silo_capacity_positive"
          CHECK ("silo_capacity_kg" IS NULL OR "silo_capacity_kg" > 0),
        -- THE 2.4 invariant. Weight-based dispensing without a bound weight
        -- source would wait forever on a measurement that never arrives, and a
        -- weight sensor on a time-based feeder is an id nothing would ever
        -- consult and nobody would notice had rotted.
        CONSTRAINT "CK_fcap_weight_source_required"
          CHECK (("dispense_control" = 'weight_based') = ("weight_sensor_id" IS NOT NULL)),
        -- FK targets for feeder_calibrations: the first pins a calibration
        -- row's physics to the machine's, the second pins its band copy.
        CONSTRAINT "UQ_fcap_mode" UNIQUE ("tenant_id", "equipment_id", "dosing_mode"),
        CONSTRAINT "UQ_fcap_speed_band"
          UNIQUE ("tenant_id", "equipment_id", "min_speed_hz", "max_speed_hz")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fcap_tenant" ON "${CAPABILITIES}" ("tenant_id")`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.equipment') IS NOT NULL THEN
          ALTER TABLE "${CAPABILITIES}"
            ADD CONSTRAINT "FK_fcap_equipment"
            FOREIGN KEY ("equipment_id") REFERENCES "equipment" ("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // -----------------------------------------------------------------------
    // 2. New calibration columns. Nullable during the expand phase so old and new
    //    writers coexist; the backfill below fills them and step 4 tightens them.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "feed_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "dosing_mode" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "grams_per_minute" numeric(10,3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "reference_speed_hz" numeric(6,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "min_speed_hz" numeric(6,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "max_speed_hz" numeric(6,2)`,
    );

    // -----------------------------------------------------------------------
    // 3. Commission every feeder that already had calibrations.
    //    Old rows carry grams-per-shot, so they are DISCRETE by construction,
    //    and TIME_BASED because no weight concept existed to have chosen.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      INSERT INTO "${CAPABILITIES}" (
        "tenant_id", "equipment_id", "dosing_mode", "silo_capacity_kg", "dispense_control"
      )
      SELECT
        c."tenant_id",
        c."equipment_id",
        'discrete',
        MAX(NULLIF(c."silo_capacity_kg", 0)),
        'time_based'
      FROM "${CALIBRATIONS}" c
      GROUP BY c."tenant_id", c."equipment_id"
      ON CONFLICT ("tenant_id", "equipment_id") DO NOTHING
    `);

    await queryRunner.query(
      `UPDATE "${CALIBRATIONS}" SET "dosing_mode" = 'discrete' WHERE "dosing_mode" IS NULL`,
    );

    // -----------------------------------------------------------------------
    // 4. Recover the feed identity where — and only where — it is recoverable.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.feeds') IS NOT NULL THEN
          UPDATE "${CALIBRATIONS}" c
             SET "feed_id" = unambiguous."id"
            FROM (
              SELECT f."tenantId" AS "tenant_id",
                     f."pelletSize" AS "pellet_size",
                     (array_agg(f."id"))[1] AS "id"
                FROM "feeds" f
               WHERE f."isDeleted" = false
                 AND f."pelletSize" IS NOT NULL
               GROUP BY f."tenantId", f."pelletSize"
              HAVING COUNT(*) = 1
            ) unambiguous
           WHERE c."feed_id" IS NULL
             AND c."tenant_id" = unambiguous."tenant_id"
             AND c."feed_size_mm" = unambiguous."pellet_size";
        END IF;
      END $$;
    `);

    // A row that cannot name its feed is not carryable into a model keyed by
    // feed identity — that ambiguity is the defect this migration exists to
    // remove. Nothing on the platform ever read this table, so the loss is a
    // re-entry task rather than an operational one. The count is logged so the
    // deploy record says exactly how much was dropped, per schema.
    await queryRunner.query(`
      DO $$
      DECLARE
        v_orphans bigint;
      BEGIN
        SELECT COUNT(*) INTO v_orphans FROM "${CALIBRATIONS}" WHERE "feed_id" IS NULL;
        IF v_orphans > 0 THEN
          RAISE NOTICE
            'ReshapeFeederCalibrationForVfd: schema %, dropping % feeder calibration row(s) whose pellet diameter matched no single live feed — re-enter them against the intended feed.',
            current_schema(), v_orphans;
          DELETE FROM "${CALIBRATIONS}" WHERE "feed_id" IS NULL;
        END IF;
      END $$;
    `);

    // -----------------------------------------------------------------------
    // 5. Contract phase: the old key and the duplicated silo capacity go away.
    // -----------------------------------------------------------------------
    // DESTRUCTIVE: drops feeder_calibrations."feed_size_mm" — the pellet-diameter key replaced by "feed_id" in step 4 of this same migration; rollback reference is this file's down().
    await queryRunner.query(`ALTER TABLE "${CALIBRATIONS}" DROP COLUMN IF EXISTS "feed_size_mm"`);
    // DESTRUCTIVE: drops feeder_calibrations."feed_size_label" — a label for the diameter key removed above; the feed's own name is reachable through "feed_id"; rollback reference is this file's down().
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" DROP COLUMN IF EXISTS "feed_size_label"`,
    );
    // DESTRUCTIVE: drops feeder_calibrations."silo_capacity_kg" — a feeder property restated per feed, migrated to feeder_capabilities in step 3 of this same migration; rollback reference is this file's down().
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" DROP COLUMN IF EXISTS "silo_capacity_kg"`,
    );

    // -----------------------------------------------------------------------
    // 6. Tighten. Guarded through information_schema so a replay is a no-op.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${CALIBRATIONS}'
             AND column_name = 'feed_id'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "${CALIBRATIONS}" ALTER COLUMN "feed_id" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${CALIBRATIONS}'
             AND column_name = 'dosing_mode'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "${CALIBRATIONS}" ALTER COLUMN "dosing_mode" SET NOT NULL;
        END IF;

        -- grams_per_dispensing becomes conditional: required for DISCRETE rows
        -- (enforced by CK_fcal_discrete_shape below), absent for CONTINUOUS.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${CALIBRATIONS}'
             AND column_name = 'grams_per_dispensing'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "${CALIBRATIONS}" ALTER COLUMN "grams_per_dispensing" DROP NOT NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fcal_tenant_equipment_feed" ON "${CALIBRATIONS}" ("tenant_id", "equipment_id", "feed_id")`,
    );

    // -----------------------------------------------------------------------
    // 7. The constraints that make the wrong row unstorable.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_dosing_mode"
          CHECK ("dosing_mode" IN ('discrete', 'continuous'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Each field is tied to its mode by an EQUIVALENCE, not an implication, so
    // both "a discrete row carrying auger physics" and "a continuous row
    // missing it" are equally unstorable.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_discrete_shape"
          CHECK (("dosing_mode" = 'discrete') = ("grams_per_dispensing" IS NOT NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_rate_matches_mode"
          CHECK (("dosing_mode" = 'continuous') = ("grams_per_minute" IS NOT NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_reference_speed_matches_mode"
          CHECK (("dosing_mode" = 'continuous') = ("reference_speed_hz" IS NOT NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_min_speed_matches_mode"
          CHECK (("dosing_mode" = 'continuous') = ("min_speed_hz" IS NOT NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_max_speed_matches_mode"
          CHECK (("dosing_mode" = 'continuous') = ("max_speed_hz" IS NOT NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // A flow rate measured outside the band it is declared valid on describes
    // an operating point the machine is not commissioned for; extrapolating
    // back in would be inventing physics.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_reference_speed_in_band"
          CHECK ("reference_speed_hz" IS NULL
                 OR ("reference_speed_hz" >= "min_speed_hz"
                     AND "reference_speed_hz" <= "max_speed_hz"));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}" ADD CONSTRAINT "CK_fcal_positive_magnitudes"
          CHECK (("grams_per_dispensing" IS NULL OR "grams_per_dispensing" > 0)
                 AND ("grams_per_minute" IS NULL OR "grams_per_minute" > 0));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // The feed IS a feed row. The FK is what makes a diameter, a code, or a
    // typo unstorable in the column that now carries feed identity.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.feeds') IS NOT NULL THEN
          ALTER TABLE "${CALIBRATIONS}"
            ADD CONSTRAINT "FK_fcal_feed"
            FOREIGN KEY ("feed_id") REFERENCES "feeds" ("id");
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // THE mode pin. Two consequences, both wanted: a calibration whose physics
    // disagrees with its feeder is unstorable, and a calibration for a machine
    // never commissioned as a feeder is unstorable. ON UPDATE RESTRICT so a
    // feeder's mode cannot be flipped out from under live calibrations; ON
    // DELETE CASCADE so decommissioning takes its calibrations with it.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}"
          ADD CONSTRAINT "FK_fcal_feeder_mode"
          FOREIGN KEY ("tenant_id", "equipment_id", "dosing_mode")
          REFERENCES "${CAPABILITIES}" ("tenant_id", "equipment_id", "dosing_mode")
          ON UPDATE RESTRICT ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // THE band pin. The calibration row's band columns are a COPY of the
    // capability row's, not a second statement of it: MATCH SIMPLE means the
    // constraint sleeps for DISCRETE rows (all-null band) and binds for
    // CONTINUOUS ones, and ON UPDATE CASCADE rewrites the copy whenever the
    // original moves — at which point CK_fcal_reference_speed_in_band
    // re-evaluates and rejects a band narrowed past a stored measurement.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "${CALIBRATIONS}"
          ADD CONSTRAINT "FK_fcal_feeder_speed_band"
          FOREIGN KEY ("tenant_id", "equipment_id", "min_speed_hz", "max_speed_hz")
          REFERENCES "${CAPABILITIES}" ("tenant_id", "equipment_id", "min_speed_hz", "max_speed_hz")
          ON UPDATE CASCADE ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${CAPABILITIES}') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${CALIBRATIONS}'
             AND column_name = 'feed_id'
             AND is_nullable = 'NO'
        )
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${CALIBRATIONS}'
             AND column_name IN ('feed_size_mm', 'feed_size_label', 'silo_capacity_kg')
        )
        AND EXISTS (
          SELECT 1
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
           WHERE nsp.nspname = current_schema()
             AND rel.relname = '${CALIBRATIONS}'
             AND con.conname = 'FK_fcal_feeder_mode'
        )
        AND EXISTS (
          SELECT 1
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
           WHERE nsp.nspname = current_schema()
             AND rel.relname = '${CAPABILITIES}'
             AND con.conname = 'CK_fcap_weight_source_required'
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" DROP CONSTRAINT IF EXISTS "FK_fcal_feeder_speed_band"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" DROP CONSTRAINT IF EXISTS "FK_fcal_feeder_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" DROP CONSTRAINT IF EXISTS "FK_fcal_feed"`,
    );
    for (const constraint of [
      'CK_fcal_dosing_mode',
      'CK_fcal_discrete_shape',
      'CK_fcal_rate_matches_mode',
      'CK_fcal_reference_speed_matches_mode',
      'CK_fcal_min_speed_matches_mode',
      'CK_fcal_max_speed_matches_mode',
      'CK_fcal_reference_speed_in_band',
      'CK_fcal_positive_magnitudes',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${CALIBRATIONS}" DROP CONSTRAINT IF EXISTS "${constraint}"`,
      );
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fcal_tenant_equipment_feed"`);

    // The pre-reshape columns come back NULLABLE and EMPTY. Their content was a
    // pellet diameter that is now derivable from "feeds"."pelletSize" through
    // "feed_id", and a silo capacity that lives on "${CAPABILITIES}"; rolling
    // back restores the shape, not the duplication.
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "feed_size_mm" numeric(5,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "feed_size_label" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${CALIBRATIONS}" ADD COLUMN IF NOT EXISTS "silo_capacity_kg" numeric(8,2)`,
    );

    // DESTRUCTIVE: down() of ReshapeFeederCalibrationForVfd1809100000000 — drops the feed-identity key and the continuous-flow physics introduced by this same migration; rollback reference is this file's up().
    for (const column of [
      'feed_id',
      'dosing_mode',
      'grams_per_minute',
      'reference_speed_hz',
      'min_speed_hz',
      'max_speed_hz',
    ]) {
      await queryRunner.query(`ALTER TABLE "${CALIBRATIONS}" DROP COLUMN IF EXISTS "${column}"`);
    }

    // DESTRUCTIVE: down() of ReshapeFeederCalibrationForVfd1809100000000 — drops the per-feeder capability row introduced by this same migration; rollback reference is this file's up().
    await queryRunner.query(`DROP TABLE IF EXISTS "${CAPABILITIES}"`);
  }
}
