/**
 * Batch → site scope for the regulatory drafts (FARM-CRITICAL-454 verification).
 *
 * WHY: health events, batches and harvest plans carry no site column, so a
 * draft decides which of them belong to a site through the tanks the batch
 * occupies. The biomass draft's stockings and the disease draft read the
 * current composition only (`tank_batches`). That answered "where was this
 * batch" only by accident: a tank emptied by mortality, cull or harvest kept
 * naming its departed batch as `primaryBatchId`, because TankBatchService left
 * the marker stale. Once the writer clears it, a batch stocked and then emptied
 * within the month dropped out of the month's stockings, and an unresolved
 * outbreak of a batch with no fish left dropped out of the disease draft.
 *
 * WHAT: two facts, each from the data that records it.
 * - Held at the site: a tank under the site holds fish of the batch now
 *   (`tankHoldsBatchSql`, the composition's membership rule).
 * - Allocated to the site: the `tank_allocations` ledger records fish of the
 *   batch going into a tank under the site (the inflow rows the stock
 *   reconstruction counts: initial stocking, split, transfer-in).
 *
 * The builders return SQL booleans. Every argument is a SQL expression written
 * in code (a column or a bind placeholder), never a value.
 */
import { tankHoldsBatchSql } from '../../batch/utils/tank-membership.util';

/** A tank under the site holds fish of the batch (`batchId`: a uuid expression). */
export function batchHeldAtSiteSql(batchId: string, tenantId: string, siteId: string): string {
  return `EXISTS (
    SELECT 1
      FROM tank_batches tb
      JOIN tanks t ON t.id = tb."tankId"
      JOIN departments d ON d.id = t."departmentId"
     WHERE tb."tenantId" = ${tenantId}
       AND d."siteId" = ${siteId}
       AND ${tankHoldsBatchSql('tb', `${batchId}::text`)}
  )`;
}

/** Some tank, at any site, holds fish of the batch. */
export function batchHeldAnywhereSql(batchId: string, tenantId: string): string {
  return `EXISTS (
    SELECT 1
      FROM tank_batches tb
     WHERE tb."tenantId" = ${tenantId}
       AND ${tankHoldsBatchSql('tb', `${batchId}::text`)}
  )`;
}

/** The allocation ledger records fish of the batch going into a tank under the site. */
export function batchAllocatedToSiteSql(batchId: string, tenantId: string, siteId: string): string {
  return `EXISTS (
    SELECT 1
      FROM tank_allocations ta
      JOIN tanks t ON t.id = ta."tankId"
      JOIN departments d ON d.id = t."departmentId"
     WHERE ta."tenantId" = ${tenantId}
       AND ta."batchId" = ${batchId}
       AND (ta."isDeleted" IS NULL OR ta."isDeleted" = false)
       AND ta."allocationType" IN ('initial_stocking', 'split', 'transfer_in')
       AND d."siteId" = ${siteId}
  )`;
}
