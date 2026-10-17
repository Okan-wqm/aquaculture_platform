/**
 * Alarm priority counts — alert-engine alarms as the annunciator's four tiles.
 *
 * WHY: the annunciator shows three priority tiles plus "awaiting
 * acknowledgement" and lights a tile whenever its count is above zero (design
 * decision D16, README §7.5 — not the prototype's ISA-101 high-performance
 * colouring, which would light on a per-priority unacknowledged count), so
 * one count per tile is all it reads. alert-engine stores a six-level
 * AlertSeverity and no priority; which alarms a tile holds is shared-ui's
 * isOnTile (AnnunciatorScope), the same declaration the alarm list a tile
 * opens is filtered from, so the count and the list cannot disagree. It sits
 * below all three packages, and alert-engine counts by severity
 * (activeAlertCounts) rather than keep a copy.
 *
 * The one per-priority unacknowledged count read is P1's: the CRIT square
 * flashes while a P1 alarm awaits acknowledgement and stops once all are
 * acknowledged (ISA-18.2: flashing marks an unacknowledged alarm), which is
 * the way to stop it that WCAG 2.2.2 asks of a flash lasting over 5 s.
 *
 * WHAT: summariseAlarms(), which folds the server's per-(severity,
 * acknowledged) counts of unresolved alarms into the count of each tile and
 * the unacknowledged P1 count. Advisories (LOW, INFO) count nowhere.
 */
import { isOnTile, type AnnunciatorFilter } from '@aquaculture/shared-ui';
import type { ActiveAlertCount } from '@platform/shared-ui/generated/graphql-types';

/** One row of activeAlertCounts: unresolved alarms of a severity, acknowledged or not. */
export type AlarmCountRow = Pick<ActiveAlertCount, 'severity' | 'acknowledged' | 'count'>;

/** Open alarms per annunciator tile, keyed by its id — a tile added in shared-ui must be counted. */
export interface AlarmCounts extends Record<AnnunciatorFilter, number> {
  /** The P1 alarms nobody has acknowledged yet — the CRIT square flashes while any wait. */
  readonly p1Unack: number;
}

export function summariseAlarms(rows: readonly AlarmCountRow[]): AlarmCounts {
  const total = (counted: (row: AlarmCountRow) => boolean): number =>
    rows.reduce((sum, row) => (counted(row) ? sum + row.count : sum), 0);
  // activeAlertCounts counts unresolved alarms only, so every row is open.
  const onTile = (tile: AnnunciatorFilter, row: AlarmCountRow): boolean =>
    isOnTile(tile, { ...row, resolved: false });
  return {
    p1: total((row) => onTile('p1', row)),
    p2: total((row) => onTile('p2', row)),
    p3: total((row) => onTile('p3', row)),
    unack: total((row) => onTile('unack', row)),
    p1Unack: total((row) => onTile('p1', row) && !row.acknowledged),
  };
}
