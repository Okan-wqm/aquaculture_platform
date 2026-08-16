import type { EntityManager } from 'typeorm';
import type { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, type UnfedUnitDetectedEvent } from '@platform/event-contracts';

export type UnfedUnitReason = 'no_assignment' | 'assignment_paused' | 'draft_protocol';

export interface UnfedStockedUnitV1 {
  readonly unitId: string;
  readonly unitCode: string | null;
  readonly siteId: string | null;
  readonly fishCount: string | number;
  readonly biomassKg: string | number | null;
  readonly reason: UnfedUnitReason;
}

/**
 * Canonical detection read for stocked units that cannot receive a v2 plan.
 * The query starts from positive live stock, not assignments, so a newly
 * provisioned tenant with no protocol assignment cannot disappear from the
 * readiness surface.
 */
export async function findUnfedStockedUnitsV1(
  manager: Pick<EntityManager, 'query'>,
  tenantId: string,
  siteId: string,
): Promise<readonly UnfedStockedUnitV1[]> {
  const rows: UnfedStockedUnitV1[] = await manager.query(
    `SELECT tb."tankId" AS "unitId",
            COALESCE(a."unitCode", tb."tankCode") AS "unitCode",
            COALESCE(a."siteId", d."siteId") AS "siteId",
            tb."totalQuantity" AS "fishCount",
            tb."totalBiomassKg" AS "biomassKg",
            CASE
              WHEN a.id IS NULL THEN 'no_assignment'
              WHEN a.status = 'paused' THEN 'assignment_paused'
              ELSE 'draft_protocol'
            END AS reason
       FROM "tank_batches" tb
       LEFT JOIN "feeding_protocol_assignments" a
         ON a."tenantId" = tb."tenantId" AND a."unitId" = tb."tankId"
        AND a.status IN ('active', 'paused')
       LEFT JOIN "feeding_protocols_v2" p
         ON p.id = a."protocolId" AND p."tenantId" = a."tenantId"
       LEFT JOIN "equipment" e
         ON e.id = tb."tankId" AND e."tenantId" = tb."tenantId"
       LEFT JOIN "departments" d
         ON d.id = e."departmentId" AND d."tenantId" = e."tenantId"
      WHERE tb."tenantId" = $1
        AND tb."totalQuantity" > 0
        AND COALESCE(a."siteId", d."siteId") = $2::uuid
        AND (a.id IS NULL OR a.status = 'paused' OR p.status IS DISTINCT FROM 'active')
      ORDER BY tb."tankId" COLLATE "C"`,
    [tenantId, siteId],
  );
  return Object.freeze(rows);
}

/** Detection and durable signal publication share one operation boundary. */
export async function publishUnfedStockedUnitSignalsV1(
  manager: EntityManager,
  outbox: Pick<OutboxPublisher, 'enqueue'>,
  tenantId: string,
  siteId: string,
): Promise<number> {
  const rows = await findUnfedStockedUnitsV1(manager, tenantId, siteId);
  for (const row of rows) {
    if (!row.siteId || row.siteId !== siteId) {
      throw new Error(`Governed Site ${siteId} returned an unfed unit without Site authority`);
    }
    const event: UnfedUnitDetectedEvent = {
      ...createBaseEvent<UnfedUnitDetectedEvent>('UnfedUnitDetected', tenantId, {
        aggregateId: row.unitId,
        aggregateType: 'FeedingUnit',
      }),
      unitId: row.unitId,
      unitCode: row.unitCode ?? '',
      siteId: row.siteId,
      reason: row.reason,
      fishCount: Number(row.fishCount),
      biomassKg: Number(row.biomassKg ?? 0),
    };
    await outbox.enqueue(event, manager);
  }
  return rows.length;
}
