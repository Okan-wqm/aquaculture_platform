/**
 * useAlarmSummary — the annunciator's P1/P2/P3 and unacknowledged counts.
 *
 * WHY a server-side count: alert-engine activeAlertCounts groups the
 * unresolved alarms by severity and acknowledgement. Counting the latest
 * alertHistory pages instead lost an older active CRITICAL once newer rows the
 * annunciator does not count (INFO feed transitions nobody acknowledges,
 * alarms resolved without acknowledgement) filled the page, and capped every
 * count at the page size while presenting it as exact. The grouped count has
 * no page. What alert-engine still lacks is the same count per module
 * (ALERT-MEDIUM-010, docs/reviews/claude/2026-10-16-tenant-console-d6.md),
 * which the workspace menu previews.
 *
 * WHAT: StatusResult<AlarmCounts> (the four tiles' counts and the
 * unacknowledged P1 count the CRIT flash reads), refreshed every 15 s, for viewers whose
 * tenant holds the sensor module — the alarm list (/sensor/alerts) and the
 * annunciator that opens it exist only then, for a tenant admin too;
 * 'unavailable', with no request, for anyone else.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';

import { summariseAlarms, type AlarmCountRow, type AlarmCounts } from './alarmPriority';
import { ACTIVE_ALERT_COUNTS_QUERY } from './console.operations';
import { resultOf, type Nulled, type StatusResult } from './dataStatus';
import { useConsoleDataAccess } from './useConsoleDataAccess';

export const ALARM_REFRESH_MS = 15_000;

export type AlarmSummary = StatusResult<AlarmCounts>;

const NO_COUNTS: Nulled<AlarmCounts> = {
  p1: null,
  p2: null,
  p3: null,
  unack: null,
  p1Unack: null,
};

export function useAlarmSummary(): AlarmSummary {
  const access = useConsoleDataAccess();
  const query = useTenantQuery(
    ['console', 'alarmSummary'],
    async ({ signal }): Promise<AlarmCounts> => {
      const data = await graphqlClient.request<{ activeAlertCounts: AlarmCountRow[] }>(
        ACTIVE_ALERT_COUNTS_QUERY,
        undefined,
        { signal },
      );
      return summariseAlarms(data.activeAlertCounts);
    },
    {
      enabled: access.alarms,
      staleTime: ALARM_REFRESH_MS,
      refetchInterval: ALARM_REFRESH_MS,
    },
  );

  return resultOf(query, access.alarms, NO_COUNTS);
}
