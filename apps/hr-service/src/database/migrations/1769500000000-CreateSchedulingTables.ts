import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
  dropPartialTables,
} from '@aquaculture/backend-common';

const SCHEDULING_PARTIAL_STATE_TABLES = [
  'scheduling_settings',
  'weekly_plans',
  'weekly_plan_entries',
] as const;

/**
 * Migration: Create Scheduling Tables
 *
 * Creates tables for the weekly workforce scheduling system:
 * - scheduling_settings: Tenant-level configuration for work hours, overtime limits
 * - weekly_plans: Per-employee weekly work plan
 * - weekly_plan_entries: Individual day entries within a weekly plan
 */
export class CreateSchedulingTables1769500000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('CreateSchedulingTables1769500000000');
  name = 'CreateSchedulingTables1769500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // MA5b: pinSearchPath + dropPartialTables helpers replace the
    // previously inline boilerplate (commits 552f289d + fbee69aa).
    await pinSearchPath(queryRunner, 'hr');

    // 1. Create ENUMs
    await this.createEnums(queryRunner);

    // 2. Drop partial-state skeletons from prior crashed runs.
    await dropPartialTables(
      queryRunner,
      'hr',
      SCHEDULING_PARTIAL_STATE_TABLES,
      'tenant_id',
    );

    // 3. Create tables
    await this.createSchedulingSettingsTable(queryRunner);
    await this.createWeeklyPlansTable(queryRunner);
    await this.createWeeklyPlanEntriesTable(queryRunner);

    // 4. Add totalMinutes column to shifts table if not exists
    await this.updateShiftsTable(queryRunner);

    this.logger.log('Scheduling tables created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse order (from hr schema)
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."weekly_plan_entries" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."weekly_plans" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."scheduling_settings" CASCADE`);

    // Drop ENUMs
    await this.dropEnums(queryRunner);
  }

  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    // Weekly Plan Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE weekly_plan_status AS ENUM ('draft', 'published');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Weekly Plan Entry Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE weekly_plan_entry_type AS ENUM ('work', 'off', 'leave', 'holiday', 'training');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Work Week Start Day (reuse shift WeekDay if exists)
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE work_week_day AS ENUM (
          'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    this.logger.log('Scheduling ENUMs created');
  }

  private async dropEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TYPE IF EXISTS weekly_plan_status CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS weekly_plan_entry_type CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS work_week_day CASCADE`);
  }

  private async createSchedulingSettingsTable(queryRunner: QueryRunner): Promise<void> {
    // Ensure hr schema exists
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "hr"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."scheduling_settings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL UNIQUE,
        "standard_weekly_minutes" int NOT NULL DEFAULT 2700,
        "max_overtime_minutes_per_week" int DEFAULT 600,
        "max_overtime_minutes_per_month" int DEFAULT 2400,
        "default_shift_id" uuid,
        "work_week_start_day" work_week_day NOT NULL DEFAULT 'monday',
        "auto_notify_employees" boolean DEFAULT false,
        "notify_days_before" int DEFAULT 2,
        "max_consecutive_work_days" int DEFAULT 6,
        "min_rest_minutes_between_shifts" int DEFAULT 600,
        "allow_overtime_without_approval" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        CONSTRAINT "FK_sched_settings_shift" FOREIGN KEY ("default_shift_id")
          REFERENCES "hr"."shifts"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sched_settings_tenant"
      ON "hr"."scheduling_settings"("tenant_id")
    `);

    this.logger.log('scheduling_settings table created');
  }

  private async createWeeklyPlansTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."weekly_plans" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "week_start_date" date NOT NULL,
        "week_end_date" date NOT NULL,
        "status" weekly_plan_status NOT NULL DEFAULT 'draft',
        "standard_weekly_minutes" int NOT NULL DEFAULT 2700,
        "planned_work_days" int DEFAULT 0,
        "planned_off_days" int DEFAULT 0,
        "planned_total_minutes" int DEFAULT 0,
        "planned_overtime_minutes" int DEFAULT 0,
        "actual_overtime_minutes" int DEFAULT 0,
        "published_at" timestamptz,
        "notified_at" timestamptz,
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        CONSTRAINT "FK_weekly_plan_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE CASCADE
      )
    `);

    // Unique constraint: One plan per employee per week
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_weekly_plan_employee_week"
      ON "hr"."weekly_plans"("tenant_id", "employee_id", "week_start_date")
      WHERE NOT "is_deleted"
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_weekly_plan_tenant_week"
      ON "hr"."weekly_plans"("tenant_id", "week_start_date", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_weekly_plan_employee"
      ON "hr"."weekly_plans"("tenant_id", "employee_id")
    `);

    this.logger.log('weekly_plans table created');
  }

  private async createWeeklyPlanEntriesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."weekly_plan_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "weekly_plan_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "date" date NOT NULL,
        "day_of_week" work_week_day NOT NULL,
        "shift_id" uuid,
        "is_off_day" boolean DEFAULT false,
        "is_leave_day" boolean DEFAULT false,
        "leave_request_id" uuid,
        "planned_start_time" time,
        "planned_end_time" time,
        "planned_minutes" int DEFAULT 0,
        "entry_type" weekly_plan_entry_type NOT NULL DEFAULT 'work',
        "display_order" int DEFAULT 0,
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        CONSTRAINT "FK_entry_weekly_plan" FOREIGN KEY ("weekly_plan_id")
          REFERENCES "hr"."weekly_plans"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entry_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entry_shift" FOREIGN KEY ("shift_id")
          REFERENCES "hr"."shifts"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_entry_leave_request" FOREIGN KEY ("leave_request_id")
          REFERENCES "hr"."leave_requests"("id") ON DELETE SET NULL
      )
    `);

    // Unique: One entry per plan per date
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_plan_entry_unique"
      ON "hr"."weekly_plan_entries"("tenant_id", "weekly_plan_id", "date")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_plan_entry_plan"
      ON "hr"."weekly_plan_entries"("weekly_plan_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_plan_entry_employee_date"
      ON "hr"."weekly_plan_entries"("tenant_id", "employee_id", "date")
    `);

    this.logger.log('weekly_plan_entries table created');
  }

  private async updateShiftsTable(queryRunner: QueryRunner): Promise<void> {
    // Add totalMinutes column if not exists (in hr schema)
    const columnExists = await this.columnExists(queryRunner, 'hr', 'shifts', 'total_minutes');
    if (!columnExists) {
      await queryRunner.query(`
        ALTER TABLE "hr"."shifts" ADD COLUMN "total_minutes" int DEFAULT 480
      `);

      // Update existing shifts: calculate total_minutes from start_time and end_time
      await queryRunner.query(`
        UPDATE "hr"."shifts"
        SET "total_minutes" = EXTRACT(EPOCH FROM ("end_time" - "start_time")) / 60
        WHERE "total_minutes" IS NULL OR "total_minutes" = 480
      `);

      this.logger.log('Added total_minutes column to shifts table');
    }
  }

  private async columnExists(
    queryRunner: QueryRunner,
    schemaName: string,
    tableName: string,
    columnName: string,
  ): Promise<boolean> {
    const result = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
      )
    `,
      [schemaName, tableName, columnName],
    );
    return result[0]?.exists === true;
  }
}
