/**
 * useActiveAlertCounts — the one request behind every console alarm count.
 *
 * WHY one query: the annunciator (all alarms) and the workspace menu (each
 * module's alarms, ALERT-MEDIUM-010) must count the same snapshot. Both read
 * this query — alert-engine activeAlertCounts grouped by module — under one
 * tenant-scoped key, so TanStack Query sends one request per refresh and the
 * two surfaces can never show counts from different moments.
 *
 * WHAT: the query of the unresolved-alarm rows, refreshed every 15 s, and
 * whether this viewer may fetch it at all: only when the tenant holds the
 * sensor module — the alarm list (/sensor/alerts) and every surface that
 * opens it exist only then, for a tenant admin too.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import type { AlarmCountRow } from './alarmPriority';
import { ACTIVE_ALERT_COUNTS_QUERY } from './console.operations';
import { useConsoleDataAccess } from './useConsoleDataAccess';

export const ALARM_REFRESH_MS = 15_000;

export interface ActiveAlertCountsSource {
  readonly query: UseQueryResult<readonly AlarmCountRow[]>;
  /** False: the viewer cannot read alarms, nothing was requested. */
  readonly enabled: boolean;
}

export function useActiveAlertCounts(): ActiveAlertCountsSource {
  const access = useConsoleDataAccess();
  const query = useTenantQuery(
    ['console', 'activeAlertCounts'],
    async ({ signal }): Promise<readonly AlarmCountRow[]> => {
      const data = await graphqlClient.request<{ activeAlertCounts: AlarmCountRow[] }>(
        ACTIVE_ALERT_COUNTS_QUERY,
        undefined,
        { signal },
      );
      return data.activeAlertCounts;
    },
    {
      enabled: access.alarms,
      staleTime: ALARM_REFRESH_MS,
      refetchInterval: ALARM_REFRESH_MS,
    },
  );
  return { query, enabled: access.alarms };
}
