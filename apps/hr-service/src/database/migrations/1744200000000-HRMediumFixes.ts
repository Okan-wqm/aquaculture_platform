import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: HR MEDIUM Fixes
 *
 * HR-MEDIUM-002: Add EXCLUDE USING gist on leave_requests to prevent overlapping leaves at DB level.
 * HR-MEDIUM-003: Change weekly_plan_entries.planned_start_time/planned_end_time from time to timestamptz.
 * HR-MEDIUM-005: Add isSTCW column to certification_types.
 */
export class HRMediumFixes1744200000000 implements MigrationInterface {
  name = 'HRMediumFixes1744200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pin search_path so unqualified table names below resolve to hr.*
    // (defense-in-depth against running under any search_path — see
    // CreateHRModuleSchema migration for full rationale).
    await queryRunner.query(`SET search_path TO "hr", public`);

    // ── HR-MEDIUM-002: Leave overlap exclusion constraint ──
    // Requires btree_gist extension for GiST index on scalar types
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    // EXCLUDE USING gist prevents concurrent requests from creating overlapping
    // leave periods for the same employee. Application-level checks remain for
    // user-friendly error messages, but the constraint is the authoritative guard.
    //
    // # Idempotency (CRITICAL-004 from 2026-04-14 review)
    //
    // PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`. Wrapping in
    // `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
    // makes the statement re-run-safe — the migration was hand-applied to
    // dev/staging via psql before the HR migration runner was wired in
    // P6-P8 of the public-schema teardown, so a subsequent runner-driven
    // re-run would otherwise raise `constraint "leave_no_overlap" of
    // relation "leave_requests" already exists` and crash hr-service boot.
    // The same pattern is already used for ENUM creation elsewhere in the
    // HR migrations (e.g. CreateHRModuleSchema).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE leave_requests
        ADD CONSTRAINT leave_no_overlap
        EXCLUDE USING gist (
          "tenantId" WITH =,
          "employeeId" WITH =,
          daterange("startDate", "endDate", '[]') WITH &&
        )
        WHERE (
          status NOT IN ('cancelled', 'rejected', 'withdrawn')
          AND "isDeleted" = false
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── HR-MEDIUM-003: Shift times with timezone ──
    // Change from time (no tz) to timestamptz so cross-timezone sites are unambiguous.
    //
    // # Idempotency (CRITICAL-004 from 2026-04-14 review)
    //
    // ALTER COLUMN TYPE timestamptz USING ("date" + "plannedStartTime")::timestamptz
    // FAILS if the column is already timestamptz — `date + timestamptz` is not
    // a valid PostgreSQL operator (needs `date + time`). The dev/staging DBs
    // that had this migration hand-applied via psql before the HR migration
    // runner was wired would otherwise crash on the runner's re-run with
    // `operator does not exist: date + timestamptz`. Guard with a check
    // against information_schema.columns.data_type so the ALTER fires only
    // when the column is still the original `time` type.
    await queryRunner.query(`
      DO $$ BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name = 'weekly_plan_entries'
              AND column_name = 'plannedStartTime') = 'time without time zone' THEN
          ALTER TABLE weekly_plan_entries
          ALTER COLUMN "plannedStartTime" TYPE timestamptz
          USING CASE
            WHEN "plannedStartTime" IS NOT NULL
            THEN ("date" + "plannedStartTime")::timestamptz
            ELSE NULL
          END;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name = 'weekly_plan_entries'
              AND column_name = 'plannedEndTime') = 'time without time zone' THEN
          ALTER TABLE weekly_plan_entries
          ALTER COLUMN "plannedEndTime" TYPE timestamptz
          USING CASE
            WHEN "plannedEndTime" IS NOT NULL
            THEN ("date" + "plannedEndTime")::timestamptz
            ELSE NULL
          END;
        END IF;
      END $$
    `);

    // ── HR-MEDIUM-005: STCW BST flag ──
    // Already idempotent via ADD COLUMN IF NOT EXISTS.
    await queryRunner.query(`
      ALTER TABLE certification_types
      ADD COLUMN IF NOT EXISTS "isSTCW" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: drop STCW column
    await queryRunner.query(`
      ALTER TABLE certification_types
      DROP COLUMN IF EXISTS "isSTCW"
    `);

    // Reverse: change timestamptz back to time
    await queryRunner.query(`
      ALTER TABLE weekly_plan_entries
      ALTER COLUMN "plannedStartTime" TYPE time
      USING "plannedStartTime"::time
    `);

    await queryRunner.query(`
      ALTER TABLE weekly_plan_entries
      ALTER COLUMN "plannedEndTime" TYPE time
      USING "plannedEndTime"::time
    `);

    // Reverse: drop exclusion constraint
    await queryRunner.query(`
      ALTER TABLE leave_requests
      DROP CONSTRAINT IF EXISTS leave_no_overlap
    `);
  }
}
