import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFarmStockReadModel1800400000000 implements MigrationInterface {
  name = 'CreateFarmStockReadModel1800400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tenant-relative DDL: db-migrate pins search_path to `farm` or tenant schema.
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
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_farm_stock_container_snapshot_tenant_container"
          UNIQUE ("tenantId", "containerId")
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
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_farm_stock_batch_snapshot_tenant_container_batch"
          UNIQUE ("tenantId", "containerId", "batchId")
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_status" ON farm_stock_container_snapshots ("tenantId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_department" ON farm_stock_container_snapshots ("tenantId", "departmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_site" ON farm_stock_container_snapshots ("tenantId", "siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_container_tenant_active_batch" ON farm_stock_container_snapshots ("tenantId", "hasActiveBatch")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_batch_tenant_batch" ON farm_stock_batch_snapshots ("tenantId", "batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_farm_stock_batch_tenant_container" ON farm_stock_batch_snapshots ("tenantId", "containerId")`);

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

    await queryRunner.query(`
      INSERT INTO farm_stock_container_snapshots (
        "tenantId", "containerId", "containerSource", "name", "code",
        "departmentId", "status", "volume", "maxBiomassKg",
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
        e."status"::text,
        e."volume",
        NULLIF(e."specifications" ->> 'maxBiomass', '')::numeric,
        e."currentCount",
        e."currentBiomass",
        false,
        COALESCE(e."currentCount", 0) > 0,
        e."isActive" AND NOT e."isDeleted",
        e."updatedAt",
        now(),
        now()
      FROM equipment e
      WHERE e."isTank" = true
      ON CONFLICT ("tenantId", "containerId") DO UPDATE SET
        "name" = EXCLUDED."name",
        "code" = EXCLUDED."code",
        "departmentId" = EXCLUDED."departmentId",
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

    await queryRunner.query(`
      INSERT INTO farm_stock_batch_snapshots (
        "tenantId", "containerId", "batchId", "batchNumber", "batchStatus",
        "quantity", "biomassKg", "avgWeightG", "densityKgM3",
        "totalMortality", "totalCull", "harvestedQuantity",
        "isPrimary", "lastMortalityAt", "createdAt", "updatedAt"
      )
      SELECT
        tb."tenantId",
        tb."tankId",
        tb."primaryBatchId",
        COALESCE(tb."primaryBatchNumber", b."batchNumber"),
        b."status"::text,
        COALESCE(tb."totalQuantity", b."currentQuantity", 0),
        COALESCE(tb."totalBiomassKg", 0),
        COALESCE(tb."avgWeightG", 0),
        tb."densityKgM3",
        COALESCE(b."totalMortality", 0),
        COALESCE(b."cullCount", 0),
        COALESCE(b."harvestedQuantity", 0),
        true,
        tb."lastMortalityAt",
        now(),
        now()
      FROM tank_batches tb
      LEFT JOIN batches_v2 b ON b."tenantId" = tb."tenantId" AND b."id" = tb."primaryBatchId"
      WHERE tb."primaryBatchId" IS NOT NULL
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
        "lastMortalityAt" = EXCLUDED."lastMortalityAt",
        "updatedAt" = now()
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_93018beb62439a265dcb715936";
      DROP INDEX IF EXISTS "IDX_stock_movements_idempotency_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_stock_movements_tenant_idempotency"
        ON stock_movements ("tenant_id", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only expand migration. Contract cleanup happens after dual-read parity.
  }
}
