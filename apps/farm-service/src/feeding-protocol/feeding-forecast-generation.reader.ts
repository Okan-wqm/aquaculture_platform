import type { EntityManager } from 'typeorm';

import {
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  assertFeedingForecastMortalityProvenanceV1,
} from '@aquaculture/feeding-contracts';

import {
  FeedingForecastSnapshot,
  type ForecastPoolScope,
} from './entities/feeding-forecast-snapshot.entity';

interface ActiveForecastSnapshotRow extends FeedingForecastSnapshot {
  poolScope: ForecastPoolScope;
}

export interface FeedingForecastStockPoolRowV1 {
  readonly siteId: string;
  readonly feedId: string;
  readonly totalKg: number;
}

/**
 * Sole inventory projection admitted into forecast compilation. Both sides of
 * the inventory/location join are tenant-qualified and soft-deleted locations
 * are excluded in SQL, before aggregation can contaminate the pool.
 */
export async function loadFeedingForecastStockPoolV1(
  manager: Pick<EntityManager, 'query'>,
  tenantId: string,
): Promise<readonly FeedingForecastStockPoolRowV1[]> {
  const rows: Array<{ siteId: string; feedId: string; totalKg: string | number }> =
    await manager.query(
      `SELECT sl.site_id AS "siteId", si.item_id AS "feedId",
              COALESCE(SUM(si.quantity), 0) AS "totalKg"
         FROM storage_inventory si
         JOIN storage_locations sl
           ON sl.id = si.storage_location_id
          AND sl.tenant_id = si.tenant_id
          AND sl.is_deleted = false
        WHERE si.item_type = 'feed'
          AND si.tenant_id = $1
        GROUP BY sl.site_id, si.item_id
        ORDER BY sl.site_id COLLATE "C", si.item_id COLLATE "C"`,
      [tenantId],
    );
  return Object.freeze(
    rows.map((row) => {
      const totalKg = Number(row.totalKg);
      if (!row.siteId || !row.feedId || !Number.isFinite(totalKg) || totalKg < 0) {
        throw new Error('Forecast stock projection contains an invalid qualified inventory row');
      }
      return Object.freeze({ siteId: row.siteId, feedId: row.feedId, totalKg });
    }),
  );
}

/**
 * Sole read projection for forecast consumers. The view is empty until a
 * qualified generation wins the active-pointer CAS, so legacy quarantine and
 * partially-built generations can never leak through ordinary entity reads.
 */
export async function findActiveFeedingForecastSnapshotsV1(
  manager: Pick<EntityManager, 'query'>,
  tenantId: string,
  siteScopeKey?: string,
): Promise<readonly FeedingForecastSnapshot[]> {
  const relation = FEEDING_FORECAST_GENERATION_AUTHORITY.activeProjection;
  const parameters: string[] = [tenantId];
  const scopePredicate = siteScopeKey === undefined ? '' : ` AND "siteScopeKey" = $2`;
  if (siteScopeKey !== undefined) parameters.push(siteScopeKey);
  const rows: ActiveForecastSnapshotRow[] = await manager.query(
    `SELECT * FROM "${relation}" WHERE "tenantId" = $1${scopePredicate}
      ORDER BY "siteScopeKey" COLLATE "C"`,
    parameters,
  );
  for (const row of rows) {
    if (row.poolScope !== 'TENANT' && row.poolScope !== 'SITE') {
      throw new Error('Active forecast projection contains an unqualified pool scope');
    }
    row.mortalityAssumption = assertFeedingForecastMortalityProvenanceV1(
      row.mortalityAssumption,
      row.perUnit.map((unit) => unit.unitId),
    );
  }
  return Object.freeze(rows);
}

export async function findActiveFeedingForecastSnapshotV1(
  manager: Pick<EntityManager, 'query'>,
  tenantId: string,
  siteScopeKey: string,
): Promise<FeedingForecastSnapshot | null> {
  const rows = await findActiveFeedingForecastSnapshotsV1(manager, tenantId, siteScopeKey);
  if (rows.length > 1) {
    throw new Error(`Active forecast projection duplicated scope ${siteScopeKey}`);
  }
  return rows[0] ?? null;
}
