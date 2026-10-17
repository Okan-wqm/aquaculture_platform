/**
 * The dashboard's alarm view-models: a module's alarms per site, and the
 * handful the Active alarms panel lists.
 *
 * WHY: alert-engine stores a severity and two flags per alarm; the console
 * reads priorities (shared-ui priorityOf — the annunciator's scale, so a row
 * here and a tile there agree) and three states an operator acts on
 * (ISA-18.2): unacknowledged while the condition stands, cleared (returned to
 * normal, still unacknowledged) and acknowledged while it stands. An alarm
 * both cleared and acknowledged needs nobody and is not listed.
 *
 * WHAT: tallyBySite (per-site P1/P2/P3 from activeAlertCounts grouped by
 * site), alarmState, and topAlarms — unacknowledged first, then cleared, then
 * acknowledged; within a state the most urgent priority, then the newest.
 */
import { priorityOf, type AlarmPriority, type AlarmPriorityTally } from '@aquaculture/shared-ui';
import type { AlertSeverity } from '@platform/shared-ui/generated/graphql-types';

export interface SiteAlarmCountRow {
  readonly severity: AlertSeverity;
  readonly acknowledged: boolean;
  readonly siteId: string | null;
  readonly count: number;
}

export interface AlarmRecord {
  readonly id: string;
  readonly ruleName: string;
  readonly message: string;
  readonly severity: AlertSeverity;
  readonly acknowledged: boolean;
  readonly resolved: boolean;
  readonly triggeredAt: string;
  readonly siteId: string | null;
}

export type AlarmState = 'unack' | 'cleared' | 'acked';

export interface AlarmRow extends AlarmRecord {
  readonly priority: AlarmPriority;
  readonly state: AlarmState;
}

const EMPTY_TALLY: AlarmPriorityTally = { p1: 0, p2: 0, p3: 0 };

/** Each site's open alarms per priority; a site with none is absent (zero). */
export function tallyBySite(
  rows: readonly SiteAlarmCountRow[],
): ReadonlyMap<string, AlarmPriorityTally> {
  const tallies = new Map<string, AlarmPriorityTally>();
  for (const row of rows) {
    const priority = priorityOf(row.severity);
    if (row.siteId === null || priority === null) continue;
    const current = tallies.get(row.siteId) ?? EMPTY_TALLY;
    tallies.set(row.siteId, { ...current, [priority]: current[priority] + row.count });
  }
  return tallies;
}

/** The site's tally, zeros when it has no open alarm. */
export function tallyOf(
  tallies: ReadonlyMap<string, AlarmPriorityTally>,
  siteId: string,
): AlarmPriorityTally {
  return tallies.get(siteId) ?? EMPTY_TALLY;
}

/** The most urgent priority a tally holds, or null when it holds none. */
export function worstPriority(tally: AlarmPriorityTally): AlarmPriority | null {
  if (tally.p1 > 0) return 'p1';
  if (tally.p2 > 0) return 'p2';
  if (tally.p3 > 0) return 'p3';
  return null;
}

/** The operator state of an alarm, or null for one that needs nobody. */
export function alarmState(
  alarm: Pick<AlarmRecord, 'acknowledged' | 'resolved'>,
): AlarmState | null {
  if (!alarm.acknowledged) return alarm.resolved ? 'cleared' : 'unack';
  return alarm.resolved ? null : 'acked';
}

const STATE_RANK: Readonly<Record<AlarmState, number>> = { unack: 0, cleared: 1, acked: 2 };
const PRIORITY_RANK: Readonly<Record<AlarmPriority, number>> = { p1: 0, p2: 1, p3: 2 };

/** The `limit` alarms an operator should look at first, de-duplicated by id. */
export function topAlarms(records: readonly AlarmRecord[], limit: number): AlarmRow[] {
  const byId = new Map<string, AlarmRow>();
  for (const record of records) {
    const priority = priorityOf(record.severity);
    const state = alarmState(record);
    if (priority === null || state === null) continue;
    byId.set(record.id, { ...record, priority, state });
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt),
    )
    .slice(0, limit);
}
