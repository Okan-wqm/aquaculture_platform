/**
 * Farm-owned time-zone contract: the zone a site's day is counted in.
 *
 * Farm is the only owner of that answer. The order is the site's own zone,
 * else the tenant's localization, else UTC; feeding uses the same resolver.
 * Sensor charts ask here instead of keeping a copy, so a feeding day and a
 * chart day cannot disagree.
 *
 * The reply carries zone names only: the tenant's, and each asked-about site's
 * own zone. It never lists a tenant's sites.
 */
export const FARM_TIME_ZONE_QUERY_SUBJECTS = {
  RESOLVE: 'request.farm.resolveTimeZones',
} as const;

/** The most site ids one request may carry. */
export const MAX_TIME_ZONE_SITE_IDS = 100;

export interface ResolveFarmTimeZonesRequest {
  tenantId: string;
  siteIds: string[];
}

export interface ResolveFarmTimeZonesResponse {
  /** The tenant's zone: what a site without its own zone, or no site, uses. */
  tenantZone: string;
  /**
   * Zone per requested site that set its own zone (and exists, not deleted).
   * A site absent here — inheriting, deleted or unknown — uses `tenantZone`.
   */
  siteZones: Record<string, string>;
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');

/** Runtime trust-boundary validation for the NATS request envelope. */
export function isResolveFarmTimeZonesRequest(
  value: unknown,
): value is ResolveFarmTimeZonesRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Object.keys(value).length === 2 &&
    'tenantId' in value &&
    typeof value.tenantId === 'string' &&
    'siteIds' in value &&
    Array.isArray(value.siteIds) &&
    value.siteIds.length <= MAX_TIME_ZONE_SITE_IDS &&
    value.siteIds.every((siteId: unknown) => typeof siteId === 'string')
  );
}

/** Runtime trust-boundary validation for the NATS reply. */
export function isResolveFarmTimeZonesResponse(
  value: unknown,
): value is ResolveFarmTimeZonesResponse {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Object.keys(value).length === 2 &&
    'tenantZone' in value &&
    typeof value.tenantZone === 'string' &&
    'siteZones' in value &&
    isStringRecord(value.siteZones)
  );
}
