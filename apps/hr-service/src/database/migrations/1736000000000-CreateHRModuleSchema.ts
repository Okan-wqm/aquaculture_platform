import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create HR Module Schema
 *
 * Creates all HR tables for the aquaculture platform:
 * - Organizational: departments_hr, positions, salary_structures
 * - Leave: leave_types, leave_balances, leave_requests
 * - Attendance: shifts, schedules, schedule_entries, attendance_records
 * - Performance: performance_reviews, performance_goals, employee_kpis
 * - Training: training_courses, training_sessions, training_enrollments
 * - Certifications: certification_types, employee_certifications
 * - Aquaculture: work_areas, work_rotations, safety_training_records
 */
export class CreateHRModuleSchema1736000000000 implements MigrationInterface {
  name = 'CreateHRModuleSchema1736000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create ENUMs
    await this.createEnums(queryRunner);

    // 2. Create tables in dependency order
    await this.createOrganizationalTables(queryRunner);
    await this.createLeaveTables(queryRunner);
    await this.createAttendanceTables(queryRunner);
    await this.createTrainingTables(queryRunner);
    await this.createPerformanceTables(queryRunner);
    await this.createAquacultureTables(queryRunner);

    // 3. Update employees table with new columns
    await this.updateEmployeesTable(queryRunner);

    console.log('HR Module Schema created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse dependency order
    const tables = [
      'safety_training_records',
      'work_rotations',
      'work_areas',
      'employee_kpis',
      'performance_goals',
      'performance_reviews',
      'training_enrollments',
      'training_sessions',
      'training_courses',
      'employee_certifications',
      'certification_types',
      'attendance_records',
      'schedule_entries',
      'schedules',
      'shifts',
      'leave_requests',
      'leave_balances',
      'leave_types',
      'salary_structures',
      'positions',
      'departments_hr',
    ];

    for (const table of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // Drop ENUMs
    await this.dropEnums(queryRunner);
  }

  private async createEnums(queryRunner: QueryRunner): Promise<void> {
    // Personnel Category (Aquaculture-specific)
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE personnel_category AS ENUM ('offshore', 'onshore', 'hybrid');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Department Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE department_type AS ENUM (
          'operations', 'maintenance', 'feeding', 'quality_control',
          'administration', 'management', 'logistics', 'security',
          'hatchery', 'grow_out', 'processing', 'laboratory', 'general'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Position Level
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE position_level AS ENUM (
          'intern', 'entry', 'individual_contributor', 'senior',
          'lead', 'manager', 'director', 'executive'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Pay Frequency
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE pay_frequency AS ENUM ('weekly', 'bi_weekly', 'semi_monthly', 'monthly');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Leave Category
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE leave_category AS ENUM (
          'annual', 'sick', 'parental', 'bereavement', 'personal',
          'study', 'sabbatical', 'compensatory', 'shore_leave', 'rotation_break',
          'emergency', 'unpaid', 'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Leave Request Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE leave_request_status AS ENUM (
          'draft', 'pending', 'approved', 'rejected', 'cancelled', 'withdrawn'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Half Day Period
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE half_day_period AS ENUM ('am', 'pm');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Shift Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE shift_type AS ENUM (
          'regular', 'morning', 'evening', 'night', 'offshore_rotation', 'flexible'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Schedule Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE schedule_status AS ENUM ('draft', 'published', 'archived');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Attendance Method
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE attendance_method AS ENUM (
          'manual', 'biometric', 'rfid', 'gps', 'facial_recognition', 'mobile_app', 'web'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Attendance Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE attendance_status AS ENUM (
          'pending', 'present', 'absent', 'half_day', 'on_leave', 'holiday',
          'work_from_home', 'offshore', 'approved', 'rejected'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Certification Category
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE certification_category AS ENUM (
          'general', 'diving', 'safety', 'vessel', 'equipment', 'first_aid',
          'water_quality', 'fish_health', 'feed_management', 'electrical',
          'mechanical', 'environmental', 'regulatory', 'management'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Certification Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE certification_status AS ENUM (
          'active', 'expired', 'revoked', 'suspended', 'pending_renewal'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Training Category
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE training_category AS ENUM (
          'general', 'technical', 'safety', 'compliance', 'leadership',
          'aquaculture_operations', 'diving', 'vessel_operation', 'equipment',
          'water_quality', 'fish_health', 'feed_management', 'soft_skills'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Training Delivery Method
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE training_delivery_method AS ENUM (
          'in_person', 'online', 'hybrid', 'on_the_job', 'self_paced'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Training Session Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE session_status AS ENUM (
          'scheduled', 'in_progress', 'completed', 'cancelled', 'postponed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Enrollment Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE enrollment_status AS ENUM (
          'pending_approval', 'enrolled', 'waitlisted', 'in_progress',
          'completed', 'failed', 'withdrawn', 'no_show'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Review Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE review_type AS ENUM (
          'probation', 'quarterly', 'semi_annual', 'annual', 'promotion', 'pip', 'project'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Review Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE review_status AS ENUM (
          'draft', 'self_assessment', 'in_review', 'pending_acknowledgment', 'completed', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Goal Category
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE goal_category AS ENUM (
          'performance', 'development', 'behavioral', 'project', 'certification', 'safety'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Goal Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE goal_status AS ENUM (
          'not_started', 'in_progress', 'completed', 'partially_completed', 'deferred', 'cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // KPI Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE kpi_type AS ENUM (
          'general', 'production', 'quality', 'safety', 'efficiency',
          'mortality_rate', 'feed_conversion', 'growth_rate', 'water_quality'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Work Area Type (Aquaculture-specific)
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE work_area_type AS ENUM (
          'shore_facility', 'sea_cage', 'floating_platform', 'vessel',
          'feed_barge', 'processing_plant', 'hatchery', 'laboratory',
          'office', 'warehouse', 'workshop', 'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Rotation Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE rotation_type AS ENUM ('offshore', 'onshore', 'field', 'vessel', 'mixed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Rotation Status
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE rotation_status AS ENUM (
          'scheduled', 'in_progress', 'completed', 'cancelled', 'extended'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Safety Training Type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE safety_training_type AS ENUM (
          'general_safety', 'emergency_response', 'fire_safety', 'first_aid',
          'cpr', 'sea_survival', 'helicopter_underwater_escape',
          'diving_safety', 'vessel_safety', 'ppe_usage', 'hazmat',
          'electrical_safety', 'working_at_height', 'confined_space',
          'manual_handling', 'chemical_handling', 'environmental_awareness'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    console.log('ENUMs created');
  }

  private async dropEnums(queryRunner: QueryRunner): Promise<void> {
    const enums = [
      'personnel_category', 'department_type', 'position_level', 'pay_frequency',
      'leave_category', 'leave_request_status', 'half_day_period',
      'shift_type', 'schedule_status', 'attendance_method', 'attendance_status',
      'certification_category', 'certification_status',
      'training_category', 'training_delivery_method', 'session_status', 'enrollment_status',
      'review_type', 'review_status', 'goal_category', 'goal_status', 'kpi_type',
      'work_area_type', 'rotation_type', 'rotation_status', 'safety_training_type',
    ];

    for (const enumName of enums) {
      await queryRunner.query(`DROP TYPE IF EXISTS ${enumName} CASCADE`);
    }
  }

  private async createOrganizationalTables(queryRunner: QueryRunner): Promise<void> {
    // departments_hr
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "departments_hr" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid,
        "parent_department_id" uuid,
        "name" varchar(150) NOT NULL,
        "code" varchar(20) NOT NULL,
        "type" department_type NOT NULL DEFAULT 'general',
        "description" text,
        "manager_id" uuid,
        "budget_code" varchar(50),
        "cost_center" varchar(50),
        "is_active" boolean DEFAULT true,
        "sort_order" int DEFAULT 0,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_dept_parent" FOREIGN KEY ("parent_department_id")
          REFERENCES "departments_hr"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_dept_tenant_code"
      ON "departments_hr"("tenant_id", "code") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dept_tenant_site"
      ON "departments_hr"("tenant_id", "site_id")
    `);

    // positions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "positions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "department_id" uuid,
        "title" varchar(150) NOT NULL,
        "code" varchar(20) NOT NULL,
        "description" text,
        "level" position_level NOT NULL DEFAULT 'individual_contributor',
        "grade" varchar(10),
        "salary_range_min" decimal(12, 2),
        "salary_range_max" decimal(12, 2),
        "currency" varchar(3) DEFAULT 'USD',
        "requirements" jsonb,
        "responsibilities" jsonb,
        "is_aquaculture_specific" boolean DEFAULT false,
        "required_certifications" text[],
        "headcount" int DEFAULT 0,
        "filled_count" int DEFAULT 0,
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_position_dept" FOREIGN KEY ("department_id")
          REFERENCES "departments_hr"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_position_tenant_code"
      ON "positions"("tenant_id", "code") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_position_tenant_dept"
      ON "positions"("tenant_id", "department_id")
    `);

    // salary_structures
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "salary_structures" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "position_id" uuid,
        "name" varchar(150) NOT NULL,
        "grade" varchar(10),
        "level" int,
        "base_salary_min" decimal(12, 2) NOT NULL,
        "base_salary_max" decimal(12, 2) NOT NULL,
        "base_salary_mid" decimal(12, 2),
        "currency" varchar(3) DEFAULT 'USD',
        "pay_frequency" pay_frequency NOT NULL DEFAULT 'monthly',
        "allowances" jsonb,
        "offshore_allowance" decimal(10, 2),
        "diving_allowance" decimal(10, 2),
        "hazard_pay" decimal(10, 2),
        "remote_location_allowance" decimal(10, 2),
        "effective_from" date NOT NULL,
        "effective_to" date,
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_salary_position" FOREIGN KEY ("position_id")
          REFERENCES "positions"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_salary_tenant_position"
      ON "salary_structures"("tenant_id", "position_id")
    `);

    console.log('Organizational tables created');
  }

  private async createLeaveTables(queryRunner: QueryRunner): Promise<void> {
    // leave_types
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "leave_types" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "code" varchar(20) NOT NULL,
        "description" text,
        "category" leave_category NOT NULL DEFAULT 'annual',
        "is_paid" boolean DEFAULT true,
        "is_accrued" boolean DEFAULT true,
        "default_days_per_year" decimal(5, 2),
        "max_carry_over_days" decimal(5, 2),
        "max_consecutive_days" int,
        "min_days_notice" int,
        "accrual_rate" decimal(6, 4),
        "accrual_start_after_months" int DEFAULT 0,
        "requires_approval" boolean DEFAULT true,
        "approval_levels" int DEFAULT 1,
        "is_aquaculture_specific" boolean DEFAULT false,
        "applicable_for_offshore" boolean DEFAULT true,
        "color" varchar(7),
        "sort_order" int DEFAULT 0,
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_leave_type_tenant_code"
      ON "leave_types"("tenant_id", "code") WHERE NOT "is_deleted"
    `);

    // leave_balances
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "leave_balances" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "leave_type_id" uuid NOT NULL,
        "year" int NOT NULL,
        "opening_balance" decimal(6, 2) DEFAULT 0,
        "accrued" decimal(6, 2) DEFAULT 0,
        "used" decimal(6, 2) DEFAULT 0,
        "pending" decimal(6, 2) DEFAULT 0,
        "adjustment" decimal(6, 2) DEFAULT 0,
        "carried_over" decimal(6, 2) DEFAULT 0,
        "current_balance" decimal(6, 2) GENERATED ALWAYS AS
          ("opening_balance" + "accrued" + "carried_over" + "adjustment" - "used" - "pending") STORED,
        "last_accrual_date" date,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_balance_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_balance_leave_type" FOREIGN KEY ("leave_type_id")
          REFERENCES "leave_types"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_leave_balance_unique"
      ON "leave_balances"("tenant_id", "employee_id", "leave_type_id", "year")
      WHERE NOT "is_deleted"
    `);

    // leave_requests
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "leave_requests" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "leave_type_id" uuid NOT NULL,
        "request_number" varchar(30) NOT NULL,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "total_days" decimal(5, 2) NOT NULL,
        "is_half_day_start" boolean DEFAULT false,
        "is_half_day_end" boolean DEFAULT false,
        "half_day_period" half_day_period,
        "reason" text,
        "contact_during_leave" varchar(100),
        "status" leave_request_status NOT NULL DEFAULT 'pending',
        "current_approval_level" int DEFAULT 1,
        "approval_history" jsonb,
        "approved_by" uuid,
        "approved_at" timestamptz,
        "rejected_by" uuid,
        "rejected_at" timestamptz,
        "rejection_reason" text,
        "cancelled_by" uuid,
        "cancelled_at" timestamptz,
        "cancellation_reason" text,
        "attachments" jsonb,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_request_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_request_leave_type" FOREIGN KEY ("leave_type_id")
          REFERENCES "leave_types"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_leave_request_number"
      ON "leave_requests"("tenant_id", "request_number") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_leave_request_employee"
      ON "leave_requests"("tenant_id", "employee_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_leave_request_dates"
      ON "leave_requests"("tenant_id", "start_date", "end_date")
    `);

    console.log('Leave tables created');
  }

  private async createAttendanceTables(queryRunner: QueryRunner): Promise<void> {
    // shifts
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shifts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "code" varchar(20) NOT NULL,
        "description" text,
        "type" shift_type NOT NULL DEFAULT 'regular',
        "start_time" time NOT NULL,
        "end_time" time NOT NULL,
        "break_duration_minutes" int DEFAULT 60,
        "is_night_shift" boolean DEFAULT false,
        "is_split_shift" boolean DEFAULT false,
        "work_hours" decimal(4, 2),
        "is_offshore_shift" boolean DEFAULT false,
        "requires_boat_transport" boolean DEFAULT false,
        "rotation_config" jsonb,
        "color" varchar(7),
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_shift_tenant_code"
      ON "shifts"("tenant_id", "code") WHERE NOT "is_deleted"
    `);

    // schedules
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedules" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(150) NOT NULL,
        "description" text,
        "department_id" uuid,
        "site_id" uuid,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "status" schedule_status NOT NULL DEFAULT 'draft',
        "published_at" timestamptz,
        "published_by" uuid,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_schedule_dept" FOREIGN KEY ("department_id")
          REFERENCES "departments_hr"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_schedule_tenant_dates"
      ON "schedules"("tenant_id", "start_date", "end_date")
    `);

    // schedule_entries
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "schedule_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "schedule_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "shift_id" uuid NOT NULL,
        "date" date NOT NULL,
        "work_area_id" uuid,
        "notes" text,
        "custom_start_time" time,
        "custom_end_time" time,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_entry_schedule" FOREIGN KEY ("schedule_id")
          REFERENCES "schedules"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entry_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entry_shift" FOREIGN KEY ("shift_id")
          REFERENCES "shifts"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_entry_unique"
      ON "schedule_entries"("tenant_id", "schedule_id", "employee_id", "date")
      WHERE NOT "is_deleted"
    `);

    // attendance_records
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "attendance_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "date" date NOT NULL,
        "shift_id" uuid,
        "schedule_entry_id" uuid,
        "check_in_time" timestamptz,
        "check_out_time" timestamptz,
        "check_in_location" jsonb,
        "check_out_location" jsonb,
        "check_in_method" attendance_method DEFAULT 'manual',
        "check_out_method" attendance_method,
        "work_area_id" uuid,
        "scheduled_hours" decimal(4, 2),
        "actual_hours" decimal(4, 2),
        "overtime_hours" decimal(4, 2) DEFAULT 0,
        "break_duration_minutes" int,
        "status" attendance_status NOT NULL DEFAULT 'pending',
        "is_late" boolean DEFAULT false,
        "late_minutes" int DEFAULT 0,
        "is_early_departure" boolean DEFAULT false,
        "early_departure_minutes" int DEFAULT 0,
        "notes" text,
        "manager_notes" text,
        "approved_by" uuid,
        "approved_at" timestamptz,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_attendance_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_attendance_shift" FOREIGN KEY ("shift_id")
          REFERENCES "shifts"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_attendance_unique"
      ON "attendance_records"("tenant_id", "employee_id", "date") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_attendance_status"
      ON "attendance_records"("tenant_id", "status", "date")
    `);

    console.log('Attendance tables created');
  }

  private async createTrainingTables(queryRunner: QueryRunner): Promise<void> {
    // certification_types
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "certification_types" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(150) NOT NULL,
        "code" varchar(30) NOT NULL,
        "description" text,
        "category" certification_category NOT NULL DEFAULT 'general',
        "validity_months" int,
        "issuing_authority" varchar(200),
        "prerequisites" text[],
        "required_training_courses" text[],
        "requires_practical_exam" boolean DEFAULT false,
        "requires_written_exam" boolean DEFAULT false,
        "renewal_requirements" text,
        "renewal_training_required" boolean DEFAULT false,
        "is_aquaculture_specific" boolean DEFAULT true,
        "is_mandatory" boolean DEFAULT false,
        "applicable_positions" text[],
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cert_type_tenant_code"
      ON "certification_types"("tenant_id", "code") WHERE NOT "is_deleted"
    `);

    // employee_certifications
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "employee_certifications" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "certification_type_id" uuid NOT NULL,
        "certificate_number" varchar(100),
        "issue_date" date NOT NULL,
        "expiry_date" date,
        "issuing_authority" varchar(200),
        "issuing_location" varchar(200),
        "status" certification_status NOT NULL DEFAULT 'active',
        "is_verified" boolean DEFAULT false,
        "verified_by" uuid,
        "verified_at" timestamptz,
        "verification_notes" text,
        "document_url" text,
        "attachments" jsonb,
        "renewal_reminder_sent" boolean DEFAULT false,
        "renewal_reminder_date" date,
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_emp_cert_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_emp_cert_type" FOREIGN KEY ("certification_type_id")
          REFERENCES "certification_types"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_emp_cert_employee"
      ON "employee_certifications"("tenant_id", "employee_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_emp_cert_expiry"
      ON "employee_certifications"("tenant_id", "expiry_date") WHERE "status" = 'active'
    `);

    // training_courses
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "training_courses" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" varchar(200) NOT NULL,
        "code" varchar(30) NOT NULL,
        "description" text,
        "category" training_category NOT NULL DEFAULT 'general',
        "duration_hours" decimal(6, 2),
        "duration_days" int,
        "provider" varchar(200),
        "instructor_name" varchar(150),
        "syllabus" jsonb,
        "materials_url" text,
        "prerequisites" text[],
        "max_participants" int,
        "min_participants" int,
        "grants_certification" boolean DEFAULT false,
        "certification_type_id" uuid,
        "is_aquaculture_specific" boolean DEFAULT false,
        "applicable_positions" text[],
        "is_mandatory" boolean DEFAULT false,
        "regulatory_requirement" varchar(100),
        "delivery_method" training_delivery_method NOT NULL DEFAULT 'in_person',
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_course_cert_type" FOREIGN KEY ("certification_type_id")
          REFERENCES "certification_types"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_course_tenant_code"
      ON "training_courses"("tenant_id", "code") WHERE NOT "is_deleted"
    `);

    // training_sessions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "training_sessions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "course_id" uuid NOT NULL,
        "session_number" varchar(30) NOT NULL,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "start_time" time,
        "end_time" time,
        "location" varchar(255),
        "is_virtual" boolean DEFAULT false,
        "virtual_meeting_url" text,
        "instructor_id" uuid,
        "external_instructor" varchar(150),
        "max_capacity" int,
        "enrolled_count" int DEFAULT 0,
        "status" session_status NOT NULL DEFAULT 'scheduled',
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_session_course" FOREIGN KEY ("course_id")
          REFERENCES "training_courses"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_session_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "employees"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_session_number"
      ON "training_sessions"("tenant_id", "session_number") WHERE NOT "is_deleted"
    `);

    // training_enrollments
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "training_enrollments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "course_id" uuid NOT NULL,
        "session_id" uuid,
        "enrollment_date" date NOT NULL DEFAULT CURRENT_DATE,
        "status" enrollment_status NOT NULL DEFAULT 'enrolled',
        "started_at" timestamptz,
        "completed_at" timestamptz,
        "score" decimal(5, 2),
        "passed" boolean,
        "attempts" int DEFAULT 0,
        "feedback" text,
        "rating" int,
        "certificate_issued" boolean DEFAULT false,
        "certificate_number" varchar(50),
        "certificate_issued_at" timestamptz,
        "approved_by" uuid,
        "approved_at" timestamptz,
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_enrollment_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_enrollment_course" FOREIGN KEY ("course_id")
          REFERENCES "training_courses"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_enrollment_session" FOREIGN KEY ("session_id")
          REFERENCES "training_sessions"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_enrollment_employee"
      ON "training_enrollments"("tenant_id", "employee_id", "status")
    `);

    console.log('Training tables created');
  }

  private async createPerformanceTables(queryRunner: QueryRunner): Promise<void> {
    // performance_reviews
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "performance_reviews" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "reviewer_id" uuid NOT NULL,
        "review_number" varchar(30) NOT NULL,
        "review_type" review_type NOT NULL DEFAULT 'annual',
        "review_period_start" date NOT NULL,
        "review_period_end" date NOT NULL,
        "overall_rating" decimal(3, 2),
        "ratings" jsonb,
        "strengths" text,
        "areas_for_improvement" text,
        "reviewer_comments" text,
        "employee_comments" text,
        "goals_achieved" int DEFAULT 0,
        "goals_partially_achieved" int DEFAULT 0,
        "goals_not_achieved" int DEFAULT 0,
        "status" review_status NOT NULL DEFAULT 'draft',
        "self_assessment_submitted_at" timestamptz,
        "reviewer_submitted_at" timestamptz,
        "acknowledged_at" timestamptz,
        "finalized_at" timestamptz,
        "next_review_date" date,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_review_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_review_reviewer" FOREIGN KEY ("reviewer_id")
          REFERENCES "employees"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_number"
      ON "performance_reviews"("tenant_id", "review_number") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_review_employee"
      ON "performance_reviews"("tenant_id", "employee_id", "review_period_start")
    `);

    // performance_goals
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "performance_goals" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "review_id" uuid,
        "title" varchar(255) NOT NULL,
        "description" text,
        "category" goal_category NOT NULL DEFAULT 'performance',
        "target_date" date,
        "progress" int DEFAULT 0,
        "status" goal_status NOT NULL DEFAULT 'not_started',
        "weight" decimal(5, 2) DEFAULT 1.0,
        "related_area" varchar(100),
        "milestones" jsonb,
        "completed_at" timestamptz,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_goal_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_goal_review" FOREIGN KEY ("review_id")
          REFERENCES "performance_reviews"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_goal_employee"
      ON "performance_goals"("tenant_id", "employee_id", "status")
    `);

    // employee_kpis
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "employee_kpis" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "goal_id" uuid,
        "name" varchar(150) NOT NULL,
        "description" text,
        "measurement_unit" varchar(50),
        "target_value" decimal(15, 4),
        "actual_value" decimal(15, 4),
        "min_value" decimal(15, 4),
        "max_value" decimal(15, 4),
        "weight" decimal(5, 2) DEFAULT 1.0,
        "period_start" date,
        "period_end" date,
        "kpi_type" kpi_type NOT NULL DEFAULT 'general',
        "achievement_percent" decimal(6, 2),
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_kpi_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_kpi_goal" FOREIGN KEY ("goal_id")
          REFERENCES "performance_goals"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kpi_employee"
      ON "employee_kpis"("tenant_id", "employee_id")
    `);

    console.log('Performance tables created');
  }

  private async createAquacultureTables(queryRunner: QueryRunner): Promise<void> {
    // work_areas
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "work_areas" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "name" varchar(150) NOT NULL,
        "code" varchar(30) NOT NULL,
        "description" text,
        "type" work_area_type NOT NULL,
        "location" jsonb,
        "vessel_name" varchar(150),
        "vessel_registration" varchar(100),
        "cage_number" varchar(50),
        "requires_diving_cert" boolean DEFAULT false,
        "requires_vessel_cert" boolean DEFAULT false,
        "requires_safety_training" boolean DEFAULT true,
        "required_certifications" text[],
        "max_personnel" int,
        "safety_equipment" jsonb,
        "emergency_procedures" text,
        "is_offshore" boolean DEFAULT false,
        "transport_required" boolean DEFAULT false,
        "transport_details" text,
        "is_active" boolean DEFAULT true,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_work_area_tenant_code"
      ON "work_areas"("tenant_id", "site_id", "code") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_work_area_offshore"
      ON "work_areas"("tenant_id", "is_offshore") WHERE "is_active" = true
    `);

    // work_rotations
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "work_rotations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "rotation_number" varchar(30) NOT NULL,
        "rotation_type" rotation_type NOT NULL,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "work_area_id" uuid,
        "site_id" uuid,
        "days_on" int,
        "days_off" int,
        "status" rotation_status NOT NULL DEFAULT 'scheduled',
        "transport_out_date" date,
        "transport_out_time" time,
        "transport_in_date" date,
        "transport_in_time" time,
        "transport_method" varchar(100),
        "accommodation_details" text,
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_rotation_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_rotation_work_area" FOREIGN KEY ("work_area_id")
          REFERENCES "work_areas"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rotation_number"
      ON "work_rotations"("tenant_id", "rotation_number") WHERE NOT "is_deleted"
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rotation_employee"
      ON "work_rotations"("tenant_id", "employee_id", "start_date")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rotation_status"
      ON "work_rotations"("tenant_id", "status")
    `);

    // safety_training_records
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "safety_training_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "training_type" safety_training_type NOT NULL,
        "training_name" varchar(200) NOT NULL,
        "description" text,
        "completed_date" date NOT NULL,
        "valid_until" date,
        "instructor_name" varchar(150),
        "training_provider" varchar(200),
        "training_location" varchar(200),
        "score" decimal(5, 2),
        "passed" boolean DEFAULT true,
        "certificate_number" varchar(100),
        "certificate_url" text,
        "regulatory_requirement" varchar(100),
        "is_mandatory" boolean DEFAULT false,
        "refresh_required" boolean DEFAULT false,
        "refresh_frequency_months" int,
        "last_refresh_date" date,
        "next_refresh_due" date,
        "notes" text,
        "created_at" timestamptz DEFAULT NOW(),
        "updated_at" timestamptz DEFAULT NOW(),
        "created_by" uuid,
        "updated_by" uuid,
        "version" int DEFAULT 1,
        "is_deleted" boolean DEFAULT false,
        "deleted_at" timestamptz,
        "deleted_by" uuid,
        CONSTRAINT "FK_safety_training_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employees"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_safety_training_employee"
      ON "safety_training_records"("tenant_id", "employee_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_safety_training_valid"
      ON "safety_training_records"("tenant_id", "valid_until") WHERE "passed" = true
    `);

    console.log('Aquaculture tables created');
  }

  private async updateEmployeesTable(queryRunner: QueryRunner): Promise<void> {
    // Add aquaculture-specific columns to employees table
    const columnsToAdd = [
      { name: 'personnel_category', type: 'personnel_category', default: null },
      { name: 'assigned_work_areas', type: 'text[]', default: null },
      { name: 'sea_worthy', type: 'boolean', default: 'false' },
      { name: 'position_id', type: 'uuid', default: null },
      { name: 'department_hr_id', type: 'uuid', default: null },
      { name: 'emergency_info', type: 'jsonb', default: null },
      { name: 'current_rotation_id', type: 'uuid', default: null },
    ];

    for (const col of columnsToAdd) {
      const exists = await this.columnExists(queryRunner, 'employees', col.name);
      if (!exists) {
        const defaultClause = col.default !== null ? ` DEFAULT ${col.default}` : '';
        await queryRunner.query(`
          ALTER TABLE "employees" ADD COLUMN "${col.name}" ${col.type}${defaultClause}
        `);
        console.log(`Added column ${col.name} to employees table`);
      }
    }

    // Add foreign key for position
    const fkExists = await queryRunner.query(`
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'FK_employee_position' AND table_name = 'employees'
    `);
    if (fkExists.length === 0) {
      await queryRunner.query(`
        ALTER TABLE "employees"
        ADD CONSTRAINT "FK_employee_position" FOREIGN KEY ("position_id")
        REFERENCES "positions"("id") ON DELETE SET NULL
      `);
    }

    // Add foreign key for department_hr
    const fkDeptExists = await queryRunner.query(`
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'FK_employee_department_hr' AND table_name = 'employees'
    `);
    if (fkDeptExists.length === 0) {
      await queryRunner.query(`
        ALTER TABLE "employees"
        ADD CONSTRAINT "FK_employee_department_hr" FOREIGN KEY ("department_hr_id")
        REFERENCES "departments_hr"("id") ON DELETE SET NULL
      `);
    }

    console.log('Employees table updated with aquaculture fields');
  }

  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<boolean> {
    const result = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
      )
    `,
      [tableName, columnName],
    );
    return result[0]?.exists === true;
  }
}
