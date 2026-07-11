import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const CATEGORIES = 'hr_finance_categories';
const ENTRIES = 'hr_finance_entries';
const SETTINGS = 'hr_payroll_cost_settings';

/**
 * HR finance surface — dynamic HR expense categories, manual HR expense
 * entries, and the per-tenant payroll-cost settings row.
 *
 * `hr_` table-name prefix is mandatory: farm and hr per-tenant tables
 * are cloned into the SAME tenant_<uuid> schema namespace (precedent:
 * departments_hr). All three tables are per-tenant (unqualified DDL —
 * declared in MODULE_SCHEMAS hr.tables in the same commit).
 *
 * hr_payroll_cost_settings:
 *   - fund percentages (pension / social insurance / compulsory medical)
 *     default 0.00 — the tenant admin enters their jurisdiction's rates
 *     (product-owner decision);
 *   - otherCostPct defaults 5.00 ("Other cost = 5% of annual salaries");
 *   - defaultCurrency defaults 'NOK' and is kept aligned with the farm
 *     finance_settings SSoT via the FinanceSettingsUpdated event
 *     projection — it is NOT independently tenant-editable, so a second
 *     currency source of truth never exists.
 */
export class CreateHrFinanceTables1801700000000 implements MigrationInterface {
  name = 'CreateHrFinanceTables1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${CATEGORIES} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "name" VARCHAR(120) NOT NULL,
        "code" VARCHAR(40) NULL,
        "computedRule" JSONB NULL,
        "isSystem" BOOLEAN NOT NULL DEFAULT false,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "displayOrder" INT NOT NULL DEFAULT 0,
        "createdBy" UUID NULL,
        "updatedBy" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${ENTRIES} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "categoryId" UUID NOT NULL REFERENCES ${CATEGORIES}("id"),
        "entryDate" DATE NOT NULL,
        "amount" DECIMAL(15,2) NOT NULL CHECK ("amount" >= 0),
        "currency" VARCHAR(3) NOT NULL,
        "description" TEXT NULL,
        "departmentHrId" UUID NULL,
        "employeeId" UUID NULL,
        "createdBy" UUID NULL,
        "updatedBy" UUID NULL,
        "isDeleted" BOOLEAN NOT NULL DEFAULT false,
        "deletedAt" TIMESTAMPTZ NULL,
        "version" INT NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${SETTINGS} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "pensionFundPct" DECIMAL(5,2) NOT NULL DEFAULT 0.00
          CHECK ("pensionFundPct" BETWEEN 0 AND 100),
        "socialInsurancePct" DECIMAL(5,2) NOT NULL DEFAULT 0.00
          CHECK ("socialInsurancePct" BETWEEN 0 AND 100),
        "medicalInsurancePct" DECIMAL(5,2) NOT NULL DEFAULT 0.00
          CHECK ("medicalInsurancePct" BETWEEN 0 AND 100),
        "otherCostPct" DECIMAL(5,2) NOT NULL DEFAULT 5.00
          CHECK ("otherCostPct" BETWEEN 0 AND 100),
        "defaultCurrency" VARCHAR(3) NOT NULL DEFAULT 'NOK',
        "updatedBy" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Indexes
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_finance_categories_tenant_code"
        ON ${CATEGORIES} ("tenantId", "code")
        WHERE "code" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_finance_categories_tenant_name"
        ON ${CATEGORIES} ("tenantId", lower("name"))
        WHERE "isActive" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_finance_categories_tenant"
        ON ${CATEGORIES} ("tenantId", "isActive")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_date"
        ON ${ENTRIES} ("tenantId", "entryDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_category_date"
        ON ${ENTRIES} ("tenantId", "categoryId", "entryDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_department"
        ON ${ENTRIES} ("tenantId", "departmentHrId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_payroll_cost_settings_tenant"
        ON ${SETTINGS} ("tenantId")
    `);

    await applyTenantRlsToSchema(queryRunner, {
      includeTables: [CATEGORIES, ENTRIES, SETTINGS],
      tenantIdColumns: ['tenantId'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${CATEGORIES}') IS NOT NULL
        AND to_regclass(current_schema() || '.${ENTRIES}') IS NOT NULL
        AND to_regclass(current_schema() || '.${SETTINGS}') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'UQ_hr_payroll_cost_settings_tenant'
        )
        AND (
          SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname IN ('${CATEGORIES}', '${ENTRIES}', '${SETTINGS}')
        ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only. HR finance entries are the tenant's bookkeeping
    // record — never drop.
  }
}
