/**
 * useDeviceStatus — "11 of 12 devices online" for the console title block.
 *
 * WHY: sensor-service already counts the tenant's edge devices server-side
 * (edgeDeviceStats, kept current by the 60 s stale-offline sweep), so the cell
 * reads that rather than counting a device list in the browser. It reads the
 * fleet in service (inService / onlineInService): decommissioning keeps a
 * device's row, and counting it would show a retired device as one that is
 * down. Which lifecycle states are out of service is sensor-service's rule,
 * not a copy here. The refresh matches the sensor module's own stats hook
 * (15 s fresh, 60 s poll).
 *
 * WHAT: StatusResult<{ online, total }> for viewers with device access (sensor
 * module or tenant admin); 'unavailable' for anyone else.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type { EdgeDeviceStats } from '@platform/shared-ui/generated/graphql-types';

import { EDGE_DEVICE_STATS_QUERY } from './console.operations';
import { resultOf, type Nulled, type StatusResult } from './dataStatus';
import { useConsoleDataAccess } from './useConsoleDataAccess';

export interface DeviceCounts {
  online: number;
  total: number;
}

export type DeviceStatus = StatusResult<DeviceCounts>;

const NO_COUNTS: Nulled<DeviceCounts> = { online: null, total: null };

const DEVICE_STATS_STALE_MS = 15_000;
const DEVICE_STATS_REFRESH_MS = 60_000;

export function useDeviceStatus(): DeviceStatus {
  const access = useConsoleDataAccess();
  const query = useTenantQuery(
    ['console', 'deviceStatus'],
    async ({ signal }): Promise<DeviceCounts> => {
      const data = await graphqlClient.request<{
        edgeDeviceStats: Pick<EdgeDeviceStats, 'inService' | 'onlineInService'>;
      }>(EDGE_DEVICE_STATS_QUERY, undefined, { signal });
      return {
        online: data.edgeDeviceStats.onlineInService,
        total: data.edgeDeviceStats.inService,
      };
    },
    {
      enabled: access.devices,
      staleTime: DEVICE_STATS_STALE_MS,
      refetchInterval: DEVICE_STATS_REFRESH_MS,
    },
  );

  return resultOf(query, access.devices, NO_COUNTS);
}
