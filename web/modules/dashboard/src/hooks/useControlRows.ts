/**
 * The Control & sensors dashboard's site rows (model/control for what each
 * cell reads and why).
 *
 * WHAT: the viewer's active sites, then per site its gateways (the same
 * query the Production rows read, so the two dashboards share the cache), its
 * registered sensor total and its PLC connections; plus the tenant's active
 * PLC alarms (attributed to sites through their connection) and the sensor
 * module's open alarms per site.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import { tallyOf } from '../model/alarms';
import { bothOf, cellAt, cellOf, mapCell } from '../model/cell';
import {
  gatewaySummary,
  plcSummary,
  type ControlSiteRow,
  type PlcAlarmRecord,
  type PlcConnectionRecord,
} from '../model/control';
import type { GatewayRecord } from '../model/production';

import {
  ACTIVE_PLC_ALARMS_QUERY,
  SITE_PLCS_QUERY,
  SITE_SENSOR_TOTAL_QUERY,
  type DashboardOperationResults,
} from './dashboard.operations';
import { SITE_REFRESH_MS, useActiveSites } from './useActiveSites';
import { useSiteGateways, type SiteRows } from './useProductionRows';
import { ALARM_REFRESH_MS, useSiteAlarmTallies } from './useSiteAlarmTallies';
import { useTenantKeys } from './useTenantKeys';

const REFRESH = { staleTime: SITE_REFRESH_MS, refetchInterval: SITE_REFRESH_MS } as const;

function useActivePlcAlarms(): UseQueryResult<readonly PlcAlarmRecord[]> {
  return useTenantQuery(
    ['dashboard', 'activePlcAlarms'],
    async ({ signal }): Promise<readonly PlcAlarmRecord[]> =>
      (
        await graphqlClient.request<DashboardOperationResults['DashboardActivePlcAlarms']>(
          ACTIVE_PLC_ALARMS_QUERY,
          undefined,
          { signal },
        )
      ).activePlcAlarms,
    { staleTime: ALARM_REFRESH_MS, refetchInterval: ALARM_REFRESH_MS },
  );
}

export function useControlRows(): SiteRows<ControlSiteRow> {
  const { key, session } = useTenantKeys();
  const sites = useActiveSites();
  const list = sites.data ?? [];
  const tallies = useSiteAlarmTallies('SENSOR');
  const plcAlarms = useActivePlcAlarms();
  const gateways = useSiteGateways(list);

  const sensors = useQueries({
    queries: list.map((site) => ({
      queryKey: key('siteSensorTotal', site.id),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<number> =>
        (
          await graphqlClient.request<DashboardOperationResults['DashboardSiteSensorTotal']>(
            SITE_SENSOR_TOTAL_QUERY,
            { siteId: site.id },
            { signal },
          )
        ).sensors.total,
      enabled: session,
      ...REFRESH,
    })),
  });

  const plcs = useQueries({
    queries: list.map((site) => ({
      queryKey: key('sitePlcs', site.id),
      queryFn: async ({
        signal,
      }: {
        signal: AbortSignal;
      }): Promise<readonly PlcConnectionRecord[]> =>
        (
          await graphqlClient.request<DashboardOperationResults['DashboardSitePlcs']>(
            SITE_PLCS_QUERY,
            { siteId: site.id },
            { signal },
          )
        ).plcConnectionsBySite,
      enabled: session,
      ...REFRESH,
    })),
  });

  const rows = list.map(
    (site, index): ControlSiteRow => ({
      siteId: site.id,
      code: site.code,
      name: site.name,
      type: site.type,
      alarms: cellOf(tallies, (map) => tallyOf(map, site.id)),
      gateways: mapCell(
        cellAt(gateways, index, (data: readonly GatewayRecord[]) => data),
        gatewaySummary,
      ),
      sensors: cellAt(sensors, index, (total: number) => total),
      plcs: bothOf(
        cellAt(plcs, index, (data: readonly PlcConnectionRecord[]) => data),
        cellOf(plcAlarms, (data) => data),
        plcSummary,
      ),
    }),
  );

  return { sites, rows };
}
