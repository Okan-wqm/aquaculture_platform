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
    // ── HR-MEDIUM-002: Leave overlap exclusion constraint ──
    // Requires btree_gist extension for GiST index on scalar types
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    // EXCLUDE USING gist prevents concurrent requests from creating overlapping
    // leave periods for the same employee. Application-level checks remain for
    // user-friendly error messages, but the constraint is the authoritative guard.
    await queryRunner.query(`
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
      )
    `);

    // ── HR-MEDIUM-003: Shift times with timezone ──
    // Change from time (no tz) to timestamptz so cross-timezone sites are unambiguous
    await queryRunner.query(`
      ALTER TABLE weekly_plan_entries
      ALTER COLUMN "plannedStartTime" TYPE timestamptz
      USING CASE
        WHEN "plannedStartTime" IS NOT NULL
        THEN ("date" + "plannedStartTime")::timestamptz
        ELSE NULL
      END
    `);

    await queryRunner.query(`
      ALTER TABLE weekly_plan_entries
      ALTER COLUMN "plannedEndTime" TYPE timestamptz
      USING CASE
        WHEN "plannedEndTime" IS NOT NULL
        THEN ("date" + "plannedEndTime")::timestamptz
        ELSE NULL
      END
    `);

    // ── HR-MEDIUM-005: STCW BST flag ──
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
