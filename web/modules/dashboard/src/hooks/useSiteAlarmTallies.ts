/**
 * One module's open alarms per site and priority (alert-engine
 * activeAlertCounts grouped by site, ALERT-MEDIUM-010) — the Active alarms
 * cell of each site row.
 */
import { graphqlClient, useTenantQuery, type AlarmPriorityTally } from '@aquaculture/shared-ui';
import type { AlertModule } from '@platform/shared-ui/generated/graphql-types';
import type { UseQueryResult } from '@tanstack/react-query';

import { tallyBySite } from '../model/alarms';

import { SITE_ALARM_COUNTS_QUERY, type DashboardOperationResults } from './dashboard.operations';

export const ALARM_REFRESH_MS = 30_000;

export function useSiteAlarmTallies(
  module: AlertModule,
): UseQueryResult<ReadonlyMap<string, AlarmPriorityTally>> {
  return useTenantQuery(
    ['dashboard', 'siteAlarmCounts', module],
    async ({ signal }): Promise<ReadonlyMap<string, AlarmPriorityTally>> => {
      const data = await graphqlClient.request<
        DashboardOperationResults['DashboardSiteAlarmCounts']
      >(SITE_ALARM_COUNTS_QUERY, { module }, { signal });
      return tallyBySite(data.activeAlertCounts);
    },
    { staleTime: ALARM_REFRESH_MS, refetchInterval: ALARM_REFRESH_MS },
  );
}
