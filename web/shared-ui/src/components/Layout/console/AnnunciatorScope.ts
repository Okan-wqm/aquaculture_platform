/**
 * AnnunciatorScope — the alarms each annunciator tile stands for.
 *
 * WHY one declaration for both sides of a tile: a tile shows a count (the
 * shell's summariseAlarms over alert-engine activeAlertCounts) and, pressed,
 * opens the alarm list filtered to its alarms (sensor-module
 * alertPriorityFilter, sent to alertHistory). If the two sides described the
 * tile apart, "CRIT 2" could open a list of every critical alarm ever raised,
 * or UNACK a list padded with advisories — the tile and its list would stop
 * holding the same rows. Both read the scope from here, below both packages.
 *
 * WHAT the tiles hold (README §7.5, the prototype's counting rules): only
 * open alarms — a cleared (resolved) alarm is on no tile. P1/P2/P3 hold the
 * open alarms of their severities (AnnunciatorPriority severitiesOf),
 * acknowledged or not; UNACK holds the open alarms of every priority that
 * nobody has acknowledged yet. Advisories (LOW, INFO) have no priority and
 * so are on no tile.
 */
import type { AlertSeverity } from '../../../generated/graphql-types';

import { ALARM_PRIORITIES, severitiesOf, type AnnunciatorFilter } from './AnnunciatorPriority';

/** An alarm as a tile reads it. */
export interface AnnunciatorAlarm {
  readonly severity: AlertSeverity;
  readonly acknowledged: boolean;
  readonly resolved: boolean;
}

/** The open alarms a tile holds: these severities, and for UNACK only the unacknowledged ones. */
export interface AnnunciatorScope {
  readonly severities: readonly AlertSeverity[];
  readonly unacknowledgedOnly: boolean;
}

/** Every severity on a priority (P1–P3): the alarms, advisories left out. */
export const ALARM_SEVERITIES: readonly AlertSeverity[] = ALARM_PRIORITIES.flatMap(severitiesOf);

export function annunciatorScope(filter: AnnunciatorFilter): AnnunciatorScope {
  return filter === 'unack'
    ? { severities: ALARM_SEVERITIES, unacknowledgedOnly: true }
    : { severities: severitiesOf(filter), unacknowledgedOnly: false };
}

/** Whether this alarm counts on this tile — and so is in the list the tile opens. */
export function isOnTile(filter: AnnunciatorFilter, alarm: AnnunciatorAlarm): boolean {
  const scope = annunciatorScope(filter);
  return (
    !alarm.resolved &&
    scope.severities.includes(alarm.severity) &&
    (!scope.unacknowledgedOnly || !alarm.acknowledged)
  );
}
