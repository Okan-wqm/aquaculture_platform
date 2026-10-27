/**
 * Where an alarm comes from — its module and its site (ALERT-MEDIUM-010).
 *
 * WHY: every alarm alert-engine records belongs to the module whose service
 * produced the signal and, where the producer knew one, to a farm site. The
 * console counts and lists alarms by both. Each consumer states its origin
 * through these helpers, so the module is decided once per signal family and
 * an absent site is always a stored NULL — never `undefined` on one path and
 * NULL on another.
 *
 * WHAT: `farmOrigin` / `sensorOrigin` for signals from farm-service and
 * sensor-service; `siteOfScopeKey` reads a feed-coverage scope key (a site
 * UUID, or `tenant` for the tenant-wide stock pool — FeedStockoutForecast).
 *
 * Every site passes `storableSite` (ALERT-MEDIUM-013): `alert_history.site_id`
 * is uuid, and a producer's site can be a label that is not one — a sensor's
 * site is a varchar column (SENSOR-MEDIUM-187), SensorReading has no wire
 * schema. Stored as given, such a label failed the alarm insert after the
 * Redis cooldown was claimed, so the redelivered reading was suppressed and
 * the alarm lost. A site is placement, never a reason to drop an alarm: one
 * that is not a UUID is recorded as no site.
 */
import { isValidUUID } from '@aquaculture/backend-common/database';

import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';

export interface AlertOrigin {
  readonly module: OwnerModuleCode;
  readonly siteId: string | null;
}

export function farmOrigin(siteId: string | null | undefined): AlertOrigin {
  return { module: OWNER_MODULE.FARM, siteId: storableSite(siteId) };
}

export function sensorOrigin(siteId: string | null | undefined): AlertOrigin {
  return { module: OWNER_MODULE.SENSOR, siteId: storableSite(siteId) };
}

/** A feed-coverage scope key's site: the key itself when it is a site UUID, else none. */
export function siteOfScopeKey(siteScopeKey: string): string | null {
  return storableSite(siteScopeKey);
}

/** The site as `alert_history.site_id` (uuid) stores it: the UUID, or no site. */
function storableSite(siteId: string | null | undefined): string | null {
  return typeof siteId === 'string' && isValidUUID(siteId) ? siteId : null;
}
