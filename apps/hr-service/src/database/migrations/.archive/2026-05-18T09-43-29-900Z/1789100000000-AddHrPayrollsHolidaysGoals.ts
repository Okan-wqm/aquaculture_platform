import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AddHrPayrollsHolidaysGoals1789100000000
 * ============================================================================
 *
 * Adds the three entity-declared hr tables that no prior migration creates:
 *
 *   - hr.payrolls (apps/hr-service/src/hr/entities/payroll.entity.ts)
 *   - hr.holidays (apps/hr-service/src/scheduling/entities/holiday.entity.ts)
 *   - hr.goals    (apps/hr-service/src/performance/entities/goal.entity.ts)
 *
 * The SourceSchemaBootstrapService cold-boot guard surfaced this on the
 * production droplet:
 *
 *   Bootstrap failed: Source schema "hr" is missing 3/24 declared tables:
 *   payrolls, holidays, goals. Refusing to fall back to runtime
 *   synchronize() per INFRA-CRITICAL-009.
 *
 * Prior to this commit the entities relied on TypeORM `synchronize: true`
 * in some pre-production environment, which masked the gap until cold-boot.
 * synchronize is explicitly off in production (`DATABASE_SYNC=false`) so
 * the schema-bootstrap guard fired correctly on the first cold deploy.
 *
 * # Schemas
 *
 * Each CREATE TABLE matches the entity's TypeORM column types 1:1:
 *   - decimal(12,2) for monetary, decimal(5,2) for progressPercent
 *   - jsonb for breakdowns (workHours, keyResults, milestones)
 *   - enum for status/priority/period/type fields
 *   - timestamptz for audit columns (createdAt/updatedAt/approvedAt)
 *   - date for calendar-only date columns
 *   - uuid PK with gen_random_uuid()
 *
 * # Idempotency posture (R6/R8/R9/R11)
 *
 *   - CREATE TABLE IF NOT EXISTS for the three tables
 *   - CREATE TYPE wrapped in DO/EXCEPTION duplicate_object guard
 *   - CREATE INDEX IF NOT EXISTS for every index
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-CRITICAL-068
 */
export class AddHrPayrollsHolidaysGoals1789100000000
  implements MigrationInterface
{
  name = 'AddHrPayrollsHolidaysGoals1789100000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'hr');

    this.logger.log('Creating hr.payrolls, hr.holidays, hr.goals tables.');

    // ── ENUM TYPES ──────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE hr.payrolls_status_enum AS ENUM (
          'draft','pending_approval','approved','processing','paid','cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE hr.payrolls_pay_period_type_enum AS ENUM (
          'weekly','bi_weekly','semi_monthly','monthly'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE hr.holidays_type_enum AS ENUM (
          'national','religious','regional','company'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE hr.goals_status_enum AS ENUM (
          'NOT_STARTED','IN_PROGRESS','COMPLETED','CANCELLED','DEFERRED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE hr.goals_priority_enum AS ENUM (
          'LOW','MEDIUM','HIGH','CRITICAL'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── hr.payrolls ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hr.payrolls (
        "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                    varchar NOT NULL,
        "employeeId"                  varchar NOT NULL,
        "payrollNumber"               varchar NOT NULL,
        "payPeriodType"               hr.payrolls_pay_period_type_enum NOT NULL,
        "payPeriodStart"              date NOT NULL,
        "payPeriodEnd"                date NOT NULL,
        "paymentDate"                 date NULL,
        "workHours"                   jsonb NOT NULL,
        "earningsBaseSalary"          numeric(12,2) NOT NULL,
        "earningsOvertime"            numeric(12,2) NULL,
        "earningsBonus"               numeric(12,2) NULL,
        "earningsCommission"          numeric(12,2) NULL,
        "earningsAllowances"          numeric(12,2) NULL,
        "earningsGrossPay"            numeric(12,2) NOT NULL,
        "deductionsTax"               numeric(12,2) NULL,
        "deductionsSocialSecurity"    numeric(12,2) NULL,
        "deductionsHealthInsurance"   numeric(12,2) NULL,
        "deductionsRetirement"        numeric(12,2) NULL,
        "deductionsOther"             numeric(12,2) NULL,
        "deductionsTotal"             numeric(12,2) NOT NULL,
        "netPay"                      numeric(12,2) NOT NULL,
        "currency"                    varchar NOT NULL DEFAULT 'USD',
        "status"                      hr.payrolls_status_enum NOT NULL DEFAULT 'draft',
        "approvedBy"                  varchar NULL,
        "approvedAt"                  timestamptz NULL,
        "notes"                       text NULL,
        "paymentReference"            varchar NULL,
        "createdAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"                   varchar NULL,
        "updatedBy"                   varchar NULL,
        "version"                     integer NOT NULL DEFAULT 1
      )
    `);
    // Composite indexes (start with tenantId; per-tenantId index redundant)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payrolls_tenant_employee_period"
        ON hr.payrolls ("tenantId", "employeeId", "payPeriodStart", "payPeriodEnd")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payrolls_tenant_number"
        ON hr.payrolls ("tenantId", "payrollNumber")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payrolls_tenant_status"
        ON hr.payrolls ("tenantId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payrolls_tenant_payment_date"
        ON hr.payrolls ("tenantId", "paymentDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payrolls_tenant_period_start"
        ON hr.payrolls ("tenantId", "payPeriodStart")
    `);

    // ── hr.holidays ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hr.holidays (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"            varchar NOT NULL,
        "name"                varchar NOT NULL,
        "localName"           varchar NULL,
        "date"                date NOT NULL,
        "startDate"           date NOT NULL,
        "endDate"             date NOT NULL,
        "type"                hr.holidays_type_enum NOT NULL DEFAULT 'national',
        "isActive"            boolean NOT NULL DEFAULT true,
        "isPaidLeave"         boolean NOT NULL DEFAULT false,
        "affectsScheduling"   boolean NOT NULL DEFAULT true,
        "notes"               text NULL,
        "createdAt"           timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"           timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"           varchar NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_holidays_tenant_id_col"
        ON hr.holidays ("tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_holidays_tenant_date"
        ON hr.holidays ("tenantId", "date")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_holidays_tenant_range"
        ON hr.holidays ("tenantId", "startDate", "endDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_holidays_tenant_active_scheduling"
        ON hr.holidays ("tenantId", "isActive", "affectsScheduling")
    `);

    // ── hr.goals ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hr.goals (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"            varchar NOT NULL,
        "employeeId"          varchar NOT NULL,
        "title"               varchar NOT NULL,
        "description"         text NULL,
        "category"            varchar NULL,
        "priority"            hr.goals_priority_enum NOT NULL DEFAULT 'MEDIUM',
        "status"              hr.goals_status_enum NOT NULL DEFAULT 'NOT_STARTED',
        "startDate"           date NOT NULL,
        "targetDate"          date NOT NULL,
        "completedDate"       date NULL,
        "progressPercent"     numeric(5,2) NOT NULL DEFAULT 0,
        "keyResults"          jsonb NULL,
        "alignedReviewId"     varchar NULL,
        "parentGoalId"        varchar NULL,
        "milestones"          jsonb NULL,
        "createdAt"           timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"           timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"           varchar NULL,
        "updatedBy"           varchar NULL,
        "version"             integer NOT NULL DEFAULT 1,
        "isDeleted"           boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_goals_tenant_id_col"
        ON hr.goals ("tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_goal_tenant_employee"
        ON hr.goals ("tenantId", "employeeId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_goal_tenant_status"
        ON hr.goals ("tenantId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_goal_tenant_priority"
        ON hr.goals ("tenantId", "priority")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_goal_tenant_target_date"
        ON hr.goals ("tenantId", "targetDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_goal_parent"
        ON hr.goals ("parentGoalId")
    `);

    this.logger.log('hr.payrolls + hr.holidays + hr.goals created.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Dropping hr.payrolls + hr.holidays + hr.goals. ' +
        'Intended for ephemeral test environments only.',
    );

    await pinSearchPath(queryRunner, 'hr');

    await queryRunner.query(`DROP TABLE IF EXISTS hr.goals`);
    await queryRunner.query(`DROP TABLE IF EXISTS hr.holidays`);
    await queryRunner.query(`DROP TABLE IF EXISTS hr.payrolls`);

    await queryRunner.query(`DROP TYPE IF EXISTS hr.goals_priority_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS hr.goals_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS hr.holidays_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS hr.payrolls_pay_period_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS hr.payrolls_status_enum`);
  }
}
