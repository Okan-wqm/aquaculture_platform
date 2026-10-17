/**
 * AnnunciatorPriority — the console's alarm priority scale (P1/P2/P3) and the
 * `?priority=` filter that links an annunciator tile to the alarm list.
 *
 * WHY here, in shared-ui: three packages read the same scale — the shell
 * counts alarms per priority for the annunciator, the annunciator writes the
 * filter on a tile click, and the sensor module's alarm list turns that filter
 * back into its severity and acknowledgement filters. Only shared-ui is below
 * all three, so the mapping lives once, here; a copy in any one of them could
 * drift from the tile it is supposed to match.
 *
 * WHY a Record over the supergraph's AlertSeverity: alert-engine stores a
 * six-level severity and no priority, so the priority is derived. A new
 * severity fails the build until someone places it. alert-engine has no
 * EMERGENCY level (that exists only on PLC alarms, which the annunciator does
 * not read), so P1 is CRITICAL alone; LOW and INFO are advisories and light no
 * tile. WARNING sits on P3 with MEDIUM because alert-engine's own system
 * alarms (feed coverage, FCR, mortality) raise WARNING as their non-critical
 * level — an operator must see them.
 *
 * WHAT: the priority and filter ids, priorityOf() / severitiesOf() (inverse
 * of each other by construction) and parseAnnunciatorFilter() for the URL.
 */
import type { AlertSeverity } from '../../../generated/graphql-types';

/** The three alarm priorities, most urgent first. */
export const ALARM_PRIORITIES = ['p1', 'p2', 'p3'] as const;
export type AlarmPriority = (typeof ALARM_PRIORITIES)[number];

/** The four annunciator tiles, in display order — and the values of `?priority=`. */
export const ANNUNCIATOR_FILTERS = ['p1', 'p2', 'p3', 'unack'] as const;
export type AnnunciatorFilter = (typeof ANNUNCIATOR_FILTERS)[number];

/** The query parameter a tile click writes on the alarm list's route. */
export const ALARM_PRIORITY_PARAM = 'priority';

const PRIORITY_BY_SEVERITY: Readonly<Record<AlertSeverity, AlarmPriority | null>> = {
  CRITICAL: 'p1',
  HIGH: 'p2',
  MEDIUM: 'p3',
  WARNING: 'p3',
  LOW: null,
  INFO: null,
};

// Keys of PRIORITY_BY_SEVERITY, typed: Object.keys widens to string[].
const SEVERITIES = Object.keys(PRIORITY_BY_SEVERITY).filter(
  (key): key is AlertSeverity => key in PRIORITY_BY_SEVERITY,
);

/** The priority an alarm of this severity counts on, or null for an advisory. */
export function priorityOf(severity: AlertSeverity): AlarmPriority | null {
  return PRIORITY_BY_SEVERITY[severity];
}

/** The severities that count on this priority — derived from priorityOf, never listed twice. */
export function severitiesOf(priority: AlarmPriority): readonly AlertSeverity[] {
  return SEVERITIES.filter((severity) => PRIORITY_BY_SEVERITY[severity] === priority);
}

function isAnnunciatorFilter(value: string): value is AnnunciatorFilter {
  return (ANNUNCIATOR_FILTERS as readonly string[]).includes(value);
}

/** A `?priority=` value as a tile id; anything else (absent, mistyped) is no filter. */
export function parseAnnunciatorFilter(raw: string | null): AnnunciatorFilter | null {
  return raw !== null && isAnnunciatorFilter(raw) ? raw : null;
}
