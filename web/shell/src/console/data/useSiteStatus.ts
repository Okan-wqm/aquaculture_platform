/**
 * useSiteStatus — "2 of 3 sites live" for the console title block.
 *
 * WHY: total is farm-service activeSites (useActiveSites) and live is the
 * share of them with an online edge device in service (countLiveSites). The
 * two reads have separate keys and refresh rates: sites change rarely, device
 * presence follows the sensor module's 30 s device poll.
 *
 * WHAT: StatusResult<{ live, total }>; 'unavailable' without the farm module or
 * without device access, since half a ratio is not a value.
 */
import { useTenantQuery } from '@aquaculture/shared-ui';

import { pendingResult, readyResult, type Nulled, type StatusResult } from './dataStatus';
import { fetchAllEdgeDevices } from './edgeDevicePages';
import { countLiveSites } from './liveSites';
import { useActiveSites } from './useActiveSites';
import { useConsoleDataAccess } from './useConsoleDataAccess';

export interface SiteCounts {
  live: number;
  total: number;
}

export type SiteStatus = StatusResult<SiteCounts>;

const NO_COUNTS: Nulled<SiteCounts> = { live: null, total: null };

const DEVICES_STALE_MS = 10_000;
const DEVICES_REFRESH_MS = 30_000;

export function useSiteStatus(): SiteStatus {
  const access = useConsoleDataAccess();
  const enabled = access.sites && access.devices;

  const sites = useActiveSites(enabled);

  const devices = useTenantQuery(
    ['console', 'siteStatus', 'onlineDevices'],
    async ({ signal }) => fetchAllEdgeDevices({ isOnline: true }, signal),
    { enabled, staleTime: DEVICES_STALE_MS, refetchInterval: DEVICES_REFRESH_MS },
  );

  // Either source failing fails the ratio — after an earlier success too, since
  // the last-good half is no longer current; an error outranks the other still loading.
  if (!enabled) return pendingResult('unavailable', NO_COUNTS);
  if (sites.isError || devices.isError) return pendingResult('error', NO_COUNTS);
  if (sites.isSuccess && devices.isSuccess) {
    return readyResult({
      live: countLiveSites(
        sites.data.map((site) => site.id),
        devices.data,
      ),
      total: sites.data.length,
    });
  }
  return pendingResult('loading', NO_COUNTS);
}
