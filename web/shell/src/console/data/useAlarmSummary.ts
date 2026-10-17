/**
 * useAlarmSummary — the annunciator's P1/P2/P3 and unacknowledged counts.
 *
 * WHY a server-side count: alert-engine activeAlertCounts groups the
 * unresolved alarms by severity and acknowledgement. Counting the latest
 * alertHistory pages instead lost an older active CRITICAL once newer rows the
 * annunciator does not count (INFO feed transitions nobody acknowledges,
 * alarms resolved without acknowledgement) filled the page, and capped every
 * count at the page size while presenting it as exact. The grouped count has
 * no page. The rows also carry each alarm's module; the annunciator sums all
 * of them, the workspace menu splits them (useWorkspaceAlarmCounts), both
 * from the same request (useActiveAlertCounts).
 *
 * WHAT: StatusResult<AlarmCounts> (the four tiles' counts and the
 * unacknowledged P1 count the CRIT flash reads), refreshed every 15 s, for
 * viewers whose tenant holds the sensor module; 'unavailable', with no
 * request, for anyone else.
 */
import { summariseAlarms, type AlarmCounts } from './alarmPriority';
import { resultFrom, type Nulled, type StatusResult } from './dataStatus';
import { useActiveAlertCounts } from './useActiveAlertCounts';

export type AlarmSummary = StatusResult<AlarmCounts>;

const NO_COUNTS: Nulled<AlarmCounts> = {
  p1: null,
  p2: null,
  p3: null,
  unack: null,
  p1Unack: null,
};

export function useAlarmSummary(): AlarmSummary {
  const { query, enabled } = useActiveAlertCounts();
  return resultFrom(query, enabled, NO_COUNTS, summariseAlarms);
}
