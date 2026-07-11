import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

const SAFE_NUMERIC = String.raw`^\s*-?\d+(\.\d+)?\s*$`;
const SAFE_INT = String.raw`^\s*\d+\s*$`;
const SAFE_UUID = String.raw`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`;

@Injectable()
export class FarmStockProjectionService {
  async refreshContainers(
    manager: EntityManager,
    tenantId: string,
    containerIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(containerIds.filter(Boolean))];
    if (ids.length === 0) {
      return;
    }

    await this.refreshContainerSnapshots(manager, tenantId, ids);
    await this.refreshBatchSnapshots(manager, tenantId, ids);
  }

  private async refreshContainerSnapshots(
    manager: EntityManager,
    tenantId: string,
    containerIds: readonly string[],
  ): Promise<void> {
    await manager.query(
      `
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
          -- Count derives from tank_batches (the SSoT) only. currentCount is now a
          -- derived mirror (single writer), so the old fallback to t."currentCount"
          -- could only ever re-surface pre-fix drift; an absent tank_batches row is
          -- an empty tank (0). Biomass keeps its fallback until its SSoT unification.
          COALESCE(tb."totalQuantity", 0),
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
        WHERE t."tenantId" = $1 AND t."id" = ANY($2::uuid[])
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
      `,
      [tenantId, containerIds],
    );

    await manager.query(
      `
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
          COALESCE(tb."totalQuantity", 0),
          e."currentBiomass",
          false,
          COALESCE(tb."totalQuantity", 0) > 0,
          e."isActive" AND NOT e."isDeleted",
          e."updatedAt",
          now(),
          now()
        FROM equipment e
        LEFT JOIN departments d ON d."id" = e."departmentId" AND d."tenantId" = e."tenantId"
        LEFT JOIN tank_batches tb ON tb."tenantId" = e."tenantId" AND tb."tankId" = e."id"
        WHERE e."tenantId" = $1 AND e."id" = ANY($2::uuid[]) AND e."isTank" = true
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
      `,
      [tenantId, containerIds],
    );
  }

  private async refreshBatchSnapshots(
    manager: EntityManager,
    tenantId: string,
    containerIds: readonly string[],
  ): Promise<void> {
    await manager.query(
      `
        DELETE FROM farm_stock_batch_snapshots
        WHERE "tenantId" = $1 AND "containerId" = ANY($2::uuid[])
      `,
      [tenantId, containerIds],
    );

    await manager.query(
      `
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
          WHERE tb."tenantId" = $1
            AND tb."tankId" = ANY($2::uuid[])
            AND detail ->> 'batchId' ~ '${SAFE_UUID}'
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
          WHERE tb."tenantId" = $1
            AND tb."tankId" = ANY($2::uuid[])
            AND tb."primaryBatchId" IS NOT NULL
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
          "speciesId", "speciesName",
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
          b."speciesId",
          sp."commonName",
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
        LEFT JOIN species sp ON sp."tenantId" = b."tenantId" AND sp."id" = b."speciesId"
      `,
      [tenantId, containerIds],
    );
  }
}
