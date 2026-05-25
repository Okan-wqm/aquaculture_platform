import { applyTenantRlsToSchema, tableExists } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const SAFE_NUMERIC = String.raw`^\s*-?\d+(\.\d+)?\s*$`;
const SAFE_INT = String.raw`^\s*\d+\s*$`;
const SAFE_UUID = String.raw`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`;

export class ExtendFarmStockReadModelFanout1800600000000 implements MigrationInterface {
  name = 'ExtendFarmStockReadModelFanout1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureFarmStockTables(queryRunner);
    await this.ensureFarmMobileCommandReceipts(queryRunner);
    await this.backfillContainers(queryRunner);
    await this.backfillBatches(queryRunner);
    await this.reconcileStockMovementIdempotencyIndex(queryRunner);

    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const result: unknown = await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.farm_stock_container_snapshots') IS NOT NULL
        AND to_regclass(current_schema() || '.farm_stock_batch_snapshots') IS NOT NULL
        AND to_regclass(current_schema() || '.farm_mobile_command_receipts') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'farm_stock_container_snapshots'
            AND c.conname = 'uq_farm_stock_container_snapshot_tenant_container'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'farm_stock_batch_snapshots'
            AND c.conname = 'uq_farm_stock_batch_snapshot_tenant_container_batch'
        )
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'idx_farm_mobile_command_receipts_tenant_command'
        )
        AND EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = 'farm_stock_container_snapshots'
            AND c.relrowsecurity = true
            AND c.relforcerowsecurity = true
        )
        AND EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = 'farm_stock_batch_snapshots'
            AND c.relrowsecurity = true
            AND c.relforcerowsecurity = true
        ) AS ok
      `);
    const rows = Array.isArray(result) ? (result as Array<{ ok: boolean }>) : [];
    return rows[0]?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only repair migration. Rollback is application deploy rollback.
  }

  private async ensureFarmStockTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm_stock_container_snapshots (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "containerId" UUID NOT NULL,
        "containerSource" VARCHAR(20) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "code" VARCHAR(50) NOT NULL,
        "departmentId" UUID NULL,
        "siteId" UUID NULL,
        "status" VARCHAR(80) NULL,
        "volume" NUMERIC(15,2) NULL,
        "maxBiomassKg" NUMERIC(15,2) NULL,
        "currentQuantity" INTEGER NULL,
        "currentBiomassKg" NUMERIC(15,2) NULL,
        "capacityUsedPercent" NUMERIC(5,2) NULL,
        "isOverCapacity" BOOLEAN NOT NULL DEFAULT false,
        "hasActiveBatch" BOOLEAN NOT NULL DEFAULT false,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "lastStockEventAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm_stock_batch_snapshots (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "containerId" UUID NOT NULL,
        "batchId" UUID NOT NULL,
        "batchNumber" VARCHAR(50) NULL,
        "batchStatus" VARCHAR(80) NULL,
        "quantity" INTEGER NOT NULL DEFAULT 0,
        "biomassKg" NUMERIC(15,2) NOT NULL DEFAULT 0,
        "avgWeightG" NUMERIC(10,2) NOT NULL DEFAULT 0,
        "densityKgM3" NUMERIC(10,2) NULL,
        "totalMortality" INTEGER NOT NULL DEFAULT 0,
        "totalCull" INTEGER NOT NULL DEFAULT 0,
        "harvestedQuantity" INTEGER NOT NULL DEFAULT 0,
        "isPrimary" BOOLEAN NOT NULL DEFAULT true,
        "lastMortalityAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_farm_stock_container_snapshot_tenant_container'
            AND conrelid = 'farm_stock_container_snapshots'::regclass
        ) THEN
          ALTER TABLE farm_stock_container_snapshots
            ADD CONSTRAINT "uq_farm_stock_container_snapshot_tenant_container"
            UNIQUE ("tenantId", "containerId");
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_farm_stock_batch_snapshot_tenant_container_batch'
            AND conrelid = 'farm_stock_batch_snapshots'::regclass
        ) THEN
          ALTER TABLE farm_stock_batch_snapshots
            ADD CONSTRAINT "uq_farm_stock_batch_snapshot_tenant_container_batch"
            UNIQUE ("tenantId", "containerId", "batchId");
        END IF;
      END $$;
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_status" ON farm_stock_container_snapshots ("tenantId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_department" ON farm_stock_container_snapshots ("tenantId", "departmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_site" ON farm_stock_container_snapshots ("tenantId", "siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_active_batch" ON farm_stock_container_snapshots ("tenantId", "hasActiveBatch")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_batch_tenant_batch" ON farm_stock_batch_snapshots ("tenantId", "batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_batch_tenant_container" ON farm_stock_batch_snapshots ("tenantId", "containerId")`);
  }

  private async ensureFarmMobileCommandReceipts(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm_mobile_command_receipts (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "clientCommandId" UUID NOT NULL,
        "payloadHash" VARCHAR(128) NOT NULL,
        "operationType" VARCHAR(80) NOT NULL,
        "deviceId" UUID NULL,
        "clientCreatedAt" TIMESTAMPTZ NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
        "responseType" VARCHAR(120) NULL,
        "responseId" UUID NULL,
        "responsePayload" JSONB NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_farm_mobile_command_receipt_tenant_command"
          UNIQUE ("tenantId", "clientCommandId")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_farm_mobile_command_receipts_tenant_command" ON farm_mobile_command_receipts ("tenantId", "clientCommandId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_mobile_command_receipts_tenant_status" ON farm_mobile_command_receipts ("tenantId", "status")`);
  }

  private async backfillContainers(queryRunner: QueryRunner): Promise<void> {
    if (await tableExists(queryRunner, 'tanks')) {
      await queryRunner.query(`
        INSERT INTO farm_stock_container_snapshots (
          "tenantId", "containerId", "containerSource", "name", "code",
          "departmentId", "siteId", "status", "volume", "maxBiomassKg",
          "currentQuantity", "currentBiomassKg", "capacityUsedPercent",
          "isOverCapacity", "hasActiveBatch", "isActive", "lastStockEventAt",
          "createdAt", "updatedAt"
        )
        SELECT
          t."tenantId",
          t."id",
          'TANK',
          t."name",
          t."code",
          t."departmentId",
          d."siteId",
          t."status"::text,
          t."volume",
          t."maxBiomass",
          COALESCE(tb."totalQuantity", t."currentCount"),
          COALESCE(tb."totalBiomassKg", t."currentBiomass"),
          tb."capacityUsedPercent",
          COALESCE(tb."isOverCapacity", false),
          COALESCE(tb."totalQuantity", 0) > 0,
          t."isActive",
          GREATEST(
            COALESCE(tb."lastMortalityAt", '-infinity'::timestamptz),
            COALESCE(tb."lastFeedingAt", '-infinity'::timestamptz),
            COALESCE(t."updatedAt", '-infinity'::timestamptz)
          ),
          now(),
          now()
        FROM tanks t
        LEFT JOIN departments d ON d."id" = t."departmentId" AND d."tenantId" = t."tenantId"
        LEFT JOIN tank_batches tb ON tb."tenantId" = t."tenantId" AND tb."tankId" = t."id"
        ON CONFLICT ("tenantId", "containerId") DO UPDATE SET
          "name" = EXCLUDED."name",
          "code" = EXCLUDED."code",
          "departmentId" = EXCLUDED."departmentId",
          "siteId" = EXCLUDED."siteId",
          "status" = EXCLUDED."status",
          "volume" = EXCLUDED."volume",
          "maxBiomassKg" = EXCLUDED."maxBiomassKg",
          "currentQuantity" = EXCLUDED."currentQuantity",
          "currentBiomassKg" = EXCLUDED."currentBiomassKg",
          "capacityUsedPercent" = EXCLUDED."capacityUsedPercent",
          "isOverCapacity" = EXCLUDED."isOverCapacity",
          "hasActiveBatch" = EXCLUDED."hasActiveBatch",
          "isActive" = EXCLUDED."isActive",
          "lastStockEventAt" = EXCLUDED."lastStockEventAt",
          "updatedAt" = now()
      `);
    }

    if (await tableExists(queryRunner, 'equipment')) {
      await queryRunner.query(`
        INSERT INTO farm_stock_container_snapshots (
          "tenantId", "containerId", "containerSource", "name", "code",
          "departmentId", "siteId", "status", "volume", "maxBiomassKg",
          "currentQuantity", "currentBiomassKg", "isOverCapacity",
          "hasActiveBatch", "isActive", "lastStockEventAt", "createdAt", "updatedAt"
        )
        SELECT
          e."tenantId",
          e."id",
          'EQUIPMENT',
          e."name",
          e."code",
          e."departmentId",
          d."siteId",
          e."status"::text,
          e."volume",
          CASE
            WHEN NULLIF(trim(e."specifications" ->> 'maxBiomass'), '') ~ '${SAFE_NUMERIC}'
              THEN NULLIF(trim(e."specifications" ->> 'maxBiomass'), '')::numeric
            ELSE NULL
          END,
          e."currentCount",
          e."currentBiomass",
          false,
          COALESCE(e."currentCount", 0) > 0,
          e."isActive" AND NOT e."isDeleted",
          e."updatedAt",
          now(),
          now()
        FROM equipment e
        LEFT JOIN departments d ON d."id" = e."departmentId" AND d."tenantId" = e."tenantId"
        WHERE e."isTank" = true
        ON CONFLICT ("tenantId", "containerId") DO UPDATE SET
          "name" = EXCLUDED."name",
          "code" = EXCLUDED."code",
          "departmentId" = EXCLUDED."departmentId",
          "siteId" = EXCLUDED."siteId",
          "status" = EXCLUDED."status",
          "volume" = EXCLUDED."volume",
          "maxBiomassKg" = EXCLUDED."maxBiomassKg",
          "currentQuantity" = EXCLUDED."currentQuantity",
          "currentBiomassKg" = EXCLUDED."currentBiomassKg",
          "hasActiveBatch" = EXCLUDED."hasActiveBatch",
          "isActive" = EXCLUDED."isActive",
          "lastStockEventAt" = EXCLUDED."lastStockEventAt",
          "updatedAt" = now()
      `);
    }
  }

  private async backfillBatches(queryRunner: QueryRunner): Promise<void> {
    if (!(await tableExists(queryRunner, 'tank_batches'))) {
      return;
    }

    await queryRunner.query(`
      WITH detail_rows AS (
        SELECT
          tb."tenantId",
          tb."tankId",
          detail ->> 'batchId' AS "batchIdText",
          detail ->> 'batchNumber' AS "batchNumber",
          CASE WHEN NULLIF(trim(detail ->> 'quantity'), '') ~ '${SAFE_INT}'
            THEN NULLIF(trim(detail ->> 'quantity'), '')::int ELSE 0 END AS "quantity",
          CASE WHEN NULLIF(trim(detail ->> 'biomassKg'), '') ~ '${SAFE_NUMERIC}'
            THEN NULLIF(trim(detail ->> 'biomassKg'), '')::numeric ELSE 0 END AS "biomassKg",
          CASE WHEN NULLIF(trim(detail ->> 'avgWeightG'), '') ~ '${SAFE_NUMERIC}'
            THEN NULLIF(trim(detail ->> 'avgWeightG'), '')::numeric ELSE 0 END AS "avgWeightG",
          tb."densityKgM3",
          false AS "isPrimary",
          tb."lastMortalityAt"
        FROM tank_batches tb
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(tb."batchDetails") = 'array' THEN tb."batchDetails"
            ELSE '[]'::jsonb
          END
        ) detail
        WHERE detail ->> 'batchId' ~ '${SAFE_UUID}'
      ),
      primary_rows AS (
        SELECT
          tb."tenantId",
          tb."tankId",
          tb."primaryBatchId"::text AS "batchIdText",
          COALESCE(tb."primaryBatchNumber", b."batchNumber") AS "batchNumber",
          COALESCE(tb."totalQuantity", b."currentQuantity", 0) AS "quantity",
          COALESCE(tb."totalBiomassKg", 0) AS "biomassKg",
          COALESCE(tb."avgWeightG", 0) AS "avgWeightG",
          tb."densityKgM3",
          true AS "isPrimary",
          tb."lastMortalityAt"
        FROM tank_batches tb
        LEFT JOIN batches_v2 b ON b."tenantId" = tb."tenantId" AND b."id" = tb."primaryBatchId"
        WHERE tb."primaryBatchId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM detail_rows d
            WHERE d."tenantId" = tb."tenantId"
              AND d."tankId" = tb."tankId"
          )
      ),
      projected AS (
        SELECT * FROM detail_rows
        UNION ALL
        SELECT * FROM primary_rows
      )
      DELETE FROM farm_stock_batch_snapshots bs
      WHERE NOT EXISTS (
        SELECT 1 FROM projected p
        WHERE p."tenantId" = bs."tenantId"
          AND p."tankId" = bs."containerId"
          AND p."batchIdText"::uuid = bs."batchId"
      )
    `);

    await queryRunner.query(`
      WITH detail_rows AS (
        SELECT
          tb."tenantId",
          tb."tankId",
          (detail ->> 'batchId')::uuid AS "batchId",
          detail ->> 'batchNumber' AS "batchNumber",
          CASE WHEN NULLIF(trim(detail ->> 'quantity'), '') ~ '${SAFE_INT}'
            THEN NULLIF(trim(detail ->> 'quantity'), '')::int ELSE 0 END AS "quantity",
          CASE WHEN NULLIF(trim(detail ->> 'biomassKg'), '') ~ '${SAFE_NUMERIC}'
            THEN NULLIF(trim(detail ->> 'biomassKg'), '')::numeric ELSE 0 END AS "biomassKg",
          CASE WHEN NULLIF(trim(detail ->> 'avgWeightG'), '') ~ '${SAFE_NUMERIC}'
            THEN NULLIF(trim(detail ->> 'avgWeightG'), '')::numeric ELSE 0 END AS "avgWeightG",
          tb."densityKgM3",
          false AS "isPrimary",
          tb."lastMortalityAt"
        FROM tank_batches tb
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(tb."batchDetails") = 'array' THEN tb."batchDetails"
            ELSE '[]'::jsonb
          END
        ) detail
        WHERE detail ->> 'batchId' ~ '${SAFE_UUID}'
      ),
      primary_rows AS (
        SELECT
          tb."tenantId",
          tb."tankId",
          tb."primaryBatchId" AS "batchId",
          COALESCE(tb."primaryBatchNumber", b."batchNumber") AS "batchNumber",
          COALESCE(tb."totalQuantity", b."currentQuantity", 0) AS "quantity",
          COALESCE(tb."totalBiomassKg", 0) AS "biomassKg",
          COALESCE(tb."avgWeightG", 0) AS "avgWeightG",
          tb."densityKgM3",
          true AS "isPrimary",
          tb."lastMortalityAt"
        FROM tank_batches tb
        LEFT JOIN batches_v2 b ON b."tenantId" = tb."tenantId" AND b."id" = tb."primaryBatchId"
        WHERE tb."primaryBatchId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM detail_rows d
            WHERE d."tenantId" = tb."tenantId"
              AND d."tankId" = tb."tankId"
          )
      ),
      projected AS (
        SELECT * FROM detail_rows
        UNION ALL
        SELECT * FROM primary_rows
      )
      INSERT INTO farm_stock_batch_snapshots (
        "tenantId", "containerId", "batchId", "batchNumber", "batchStatus",
        "quantity", "biomassKg", "avgWeightG", "densityKgM3",
        "totalMortality", "totalCull", "harvestedQuantity",
        "isPrimary", "lastMortalityAt", "createdAt", "updatedAt"
      )
      SELECT
        p."tenantId",
        p."tankId",
        p."batchId",
        COALESCE(p."batchNumber", b."batchNumber"),
        b."status"::text,
        p."quantity",
        p."biomassKg",
        p."avgWeightG",
        p."densityKgM3",
        COALESCE(b."totalMortality", 0),
        COALESCE(b."cullCount", 0),
        COALESCE(b."harvestedQuantity", 0),
        p."isPrimary",
        p."lastMortalityAt",
        now(),
        now()
      FROM projected p
      LEFT JOIN batches_v2 b ON b."tenantId" = p."tenantId" AND b."id" = p."batchId"
      ON CONFLICT ("tenantId", "containerId", "batchId") DO UPDATE SET
        "batchNumber" = EXCLUDED."batchNumber",
        "batchStatus" = EXCLUDED."batchStatus",
        "quantity" = EXCLUDED."quantity",
        "biomassKg" = EXCLUDED."biomassKg",
        "avgWeightG" = EXCLUDED."avgWeightG",
        "densityKgM3" = EXCLUDED."densityKgM3",
        "totalMortality" = EXCLUDED."totalMortality",
        "totalCull" = EXCLUDED."totalCull",
        "harvestedQuantity" = EXCLUDED."harvestedQuantity",
        "isPrimary" = EXCLUDED."isPrimary",
        "lastMortalityAt" = EXCLUDED."lastMortalityAt",
        "updatedAt" = now()
    `);
  }

  private async reconcileStockMovementIdempotencyIndex(queryRunner: QueryRunner): Promise<void> {
    if (!(await tableExists(queryRunner, 'stock_movements'))) {
      return;
    }

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_93018beb62439a265dcb715936";
      DROP INDEX IF EXISTS "IDX_stock_movements_idempotency_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_stock_movements_tenant_idempotency"
        ON stock_movements ("tenant_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
  }
}
