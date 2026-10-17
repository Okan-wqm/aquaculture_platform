/**
 * countLiveSites — how many of the viewer's active sites report right now.
 *
 * WHY: no service aggregates "live sites" (verified: no siteStatus or per-site
 * device count exists), so the title block derives it from two real reads: a
 * site is live when at least one of its edge devices is online. Only sites in
 * the active set count, so live can never exceed total — a device still bound
 * to a closed site, or to no site, lights nothing.
 */
import type { EdgeDeviceRow } from './edgeDevicePages';

export function countLiveSites(
  activeSiteIds: readonly string[],
  onlineDevices: readonly Pick<EdgeDeviceRow, 'siteId'>[],
): number {
  const reporting = new Set(onlineDevices.map((device) => device.siteId));
  return activeSiteIds.filter((siteId) => reporting.has(siteId)).length;
}
