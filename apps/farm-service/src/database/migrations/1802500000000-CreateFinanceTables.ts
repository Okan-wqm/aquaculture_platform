import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const CATEGORIES = 'finance_categories';
const ENTRIES = 'finance_expense_entries';
const SETTINGS = 'finance_settings';

/**
 * Farm finance ledger — dynamic per-tenant categories, manual expense
 * entries, and the tenant finance settings row (currency SSoT).
 *
 * Derived costs (feed / fingerlings / maintenance / treatments / harvest
 * revenue) are NOT persisted here — they are query-time projections of
 * their source tables (see finance/services/derived-cost-sources.ts), so
 * this migration only creates the manual-entry surface.
 *
 * All three tables are per-tenant (unqualified DDL — search_path routes
 * into tenant_<uuid>; declared in MODULE_SCHEMAS farm.tables in the same
 * commit because farm has strictOwnership enabled).
 */
export class CreateFinanceTables1802500000000 implements MigrationInterface {
  name = 'CreateFinanceTables1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureEnums(queryRunner);
    await this.ensureCategoriesTable(queryRunner);
    await this.ensureEntriesTable(queryRunner);
    await this.ensureSettingsTable(queryRunner);
    await this.ensureIndexes(queryRunner);

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
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'UQ_finance_categories_tenant_scope_code'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'UQ_finance_settings_tenant'
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
    // Forward-only. Finance entries are the tenant's bookkeeping record —
    // never drop.
  }

  private async ensureEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE finance_category_scope_enum AS ENUM (
          'FARM_OPEX',
          'FARM_REVENUE'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE finance_category_kind_enum AS ENUM (
          'EXPENSE',
          'REVENUE'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  private async ensureCategoriesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${CATEGORIES} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "name" VARCHAR(120) NOT NULL,
        "code" VARCHAR(40) NULL,
        "scope" finance_category_scope_enum NOT NULL,
        "kind" finance_category_kind_enum NOT NULL DEFAULT 'EXPENSE',
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
  }

  private async ensureEntriesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${ENTRIES} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "categoryId" UUID NOT NULL REFERENCES ${CATEGORIES}("id"),
        "entryDate" DATE NOT NULL,
        "periodStart" DATE NULL,
        "periodEnd" DATE NULL,
        "amount" DECIMAL(15,2) NOT NULL CHECK ("amount" >= 0),
        "currency" VARCHAR(3) NOT NULL,
        "description" TEXT NULL,
        "siteId" UUID NULL,
        "batchId" UUID NULL,
        "createdBy" UUID NULL,
        "updatedBy" UUID NULL,
        "isDeleted" BOOLEAN NOT NULL DEFAULT false,
        "deletedAt" TIMESTAMPTZ NULL,
        "version" INT NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  private async ensureSettingsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${SETTINGS} (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "defaultCurrency" VARCHAR(3) NOT NULL DEFAULT 'NOK',
        "fiscalYearStartMonth" SMALLINT NOT NULL DEFAULT 1
          CHECK ("fiscalYearStartMonth" BETWEEN 1 AND 12),
        "updatedBy" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  private async ensureIndexes(queryRunner: QueryRunner): Promise<void> {
    // System-category identity — the seed's ON CONFLICT target.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_finance_categories_tenant_scope_code"
        ON ${CATEGORIES} ("tenantId", "scope", "code")
        WHERE "code" IS NOT NULL
    `);
    // Active display names stay unique per scope (case-insensitive);
    // archived categories free their name for reuse.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_finance_categories_tenant_scope_name"
        ON ${CATEGORIES} ("tenantId", "scope", lower("name"))
        WHERE "isActive" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_categories_tenant_scope_active"
        ON ${CATEGORIES} ("tenantId", "scope", "isActive")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_categories_tenant_id"
        ON ${CATEGORIES} ("tenantId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_date"
        ON ${ENTRIES} ("tenantId", "entryDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_category_date"
        ON ${ENTRIES} ("tenantId", "categoryId", "entryDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_batch"
        ON ${ENTRIES} ("tenantId", "batchId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_site"
        ON ${ENTRIES} ("tenantId", "siteId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_id"
        ON ${ENTRIES} ("tenantId")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_finance_settings_tenant"
        ON ${SETTINGS} ("tenantId")
    `);
  }
}
