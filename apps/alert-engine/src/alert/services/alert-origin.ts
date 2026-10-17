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
 */
import { isValidUUID } from '@aquaculture/backend-common/database';

import { AlertModule } from '../entities/alert-module.enum';

export interface AlertOrigin {
  readonly module: AlertModule;
  readonly siteId: string | null;
}

export function farmOrigin(siteId: string | null | undefined): AlertOrigin {
  return { module: AlertModule.FARM, siteId: siteId ?? null };
}

export function sensorOrigin(siteId: string | null | undefined): AlertOrigin {
  return { module: AlertModule.SENSOR, siteId: siteId ?? null };
}

/** A feed-coverage scope key's site: the key itself when it is a site UUID, else none. */
export function siteOfScopeKey(siteScopeKey: string): string | null {
  return isValidUUID(siteScopeKey) ? siteScopeKey : null;
}
