/**
 * Which `LowStockDetected` tiers the farm tenant room may carry (plan K8,
 * V-B1-11 of PR #1697).
 *
 * WHY: farm-service emits `LowStockDetected` per stock tier. A POOL event is a
 * tenant aggregate (on-hand across every site + open orders), visible to every
 * role that reads the storage summaries. A SITE event names one site and that
 * site's on-hand, and farm-service shows site rows to a MODULE_USER only for
 * the sites they are assigned to (`low-stock-listing.ts`, SEC-HIGH-051).
 * The farm gateway has exactly one room per client — `tenant:{tenantId}`, no
 * site-scoped room and no per-socket site authorization — so broadcasting a
 * site event there would hand one site's stock to every user of the tenant.
 *
 * WHAT: `tenantRoomLowStock` admits a pool event (v2 `level: 'pool'`) or a v1
 * event (no tier; `lowStockDetectedUpcaster` lifts every v1 event to pool) and
 * refuses anything that carries a site. The admitted payload is BRANDED, and
 * `FarmGateway.broadcastLowStockDetected` accepts only the brand, so no caller
 * can hand the tenant room an event that did not pass this check.
 * INVARIANT: a payload with `level: 'site'` or any `siteId` never reaches the
 * tenant room; if violated → site stock leaks to users not assigned to it.
 */

declare const tenantRoomLowStockBrand: unique symbol;

/**
 * A `LowStockDetected` payload cleared for the tenant room: tierless (v1) or
 * the pool tier, never a site. Only {@link tenantRoomLowStock} produces it.
 */
export type TenantRoomLowStockPayload = Record<string, unknown> & {
  readonly level?: 'pool';
  readonly siteId?: undefined;
  readonly [tenantRoomLowStockBrand]: true;
};

/** Type guard behind {@link tenantRoomLowStock}: pool or tierless, no site. */
function isTenantRoomLowStock(
  payload: Record<string, unknown>,
): payload is TenantRoomLowStockPayload {
  const level = payload['level'];
  return (level === undefined || level === 'pool') && payload['siteId'] === undefined;
}

/**
 * WHY: the one decision whether a validated `LowStockDetected` payload may be
 * broadcast to the whole tenant; WHAT: the same payload object, branded, or
 * null for a site tier (the caller withholds it).
 */
export function tenantRoomLowStock(
  payload: Record<string, unknown>,
): TenantRoomLowStockPayload | null {
  return isTenantRoomLowStock(payload) ? payload : null;
}
