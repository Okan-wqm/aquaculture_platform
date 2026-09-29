import { EventUpcaster } from './event-upcaster';

/**
 * LowStockDetected v1 → v2 upcaster (plan K8, two-tier stock).
 *
 * v1 format: no tier. Produced by exactly one computation — the tenant-wide
 *            ledger SUM across every storage location compared with the
 *            catalog `minStock` — which is the POOL tier by definition.
 * v2 format: `level: 'site' | 'pool'`; a site event adds `siteId`, a pool
 *            event adds `onOrderQuantity` (open purchase-order remainder).
 *
 * # Why `level: 'pool'` is derived, not fabricated
 *
 * v1 had a single producer (`StockMovementService.recordMovement`, pre-K8)
 * and it only ever summed the whole tenant. There is no v1 event that
 * described one site, so every v1 event IS a pool event.
 *
 * # Why `onOrderQuantity` becomes `null`, not `0`
 *
 * v1 never read purchase orders. Writing `0` would assert "nothing was on
 * order" as fact; `null` is the contract's explicit "unknown" and the pool
 * type spells that out. (Same honesty rule as the BatchHarvested isFinal
 * upcaster.)
 */
export const lowStockDetectedUpcaster: EventUpcaster = {
  eventType: 'LowStockDetected',
  fromVersion: 1,
  toVersion: 2,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    return { ...event, version: 2, level: 'pool', onOrderQuantity: null };
  },
};
