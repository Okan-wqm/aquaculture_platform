/**
 * The workspace menu's alarm column (design handoff §7.3; ALERT-MEDIUM-010).
 *
 * WHAT: `useWorkspaceAlarmsSlot` gives IndustrialRail the slot its
 * WorkspaceMenu draws per workspace row: for Production, Greenhouse and
 * Control & sensors, the P1/P2/P3 pairs of that workspace's module's active
 * alarms, as alert-engine counts them (useWorkspaceAlarmCounts); for Company,
 * nothing. While the counts load or after a refresh failed a row draws no
 * pairs — never a zero nobody measured. The slot exists only where the
 * annunciator is drawn: the nav on screen lists the alarm list (ConsoleShell
 * passes the same `findNavPage(workspaces, 'alarms')` result that gates the
 * annunciator — the previewed role's nav while an admin views as one) and the
 * viewer may read alarm data. A farm-only tenant, or a viewed role without the
 * alarm list, therefore gets no alarm column, as it gets no annunciator.
 *
 * WHY here and not in shared-ui: the rail and menu stay free of data access;
 * the shell owns which source feeds them.
 */
import { AlarmPriorityCounts, type ConsoleWorkspaceId } from '@aquaculture/shared-ui';
import { useCallback, type ReactNode } from 'react';

import { useWorkspaceAlarmCounts } from '../data/useWorkspaceAlarmCounts';

import { isAlarmWorkspace } from './alarmWorkspaces';

export type WorkspaceAlarmsSlot = (id: ConsoleWorkspaceId) => ReactNode;

/**
 * The menu's alarm slot, or undefined for no column.
 *
 * @param alarmListShown whether the nav on screen lists the alarm list — the
 *   annunciator's gate, passed in so the two cannot disagree.
 */
export function useWorkspaceAlarmsSlot(alarmListShown: boolean): WorkspaceAlarmsSlot | undefined {
  const counts = useWorkspaceAlarmCounts();
  const byWorkspace = counts.status === 'ready' ? counts.byWorkspace : null;
  const slot = useCallback(
    (id: ConsoleWorkspaceId): ReactNode =>
      isAlarmWorkspace(id) && byWorkspace !== null ? (
        <AlarmPriorityCounts counts={byWorkspace[id]} />
      ) : null,
    [byWorkspace],
  );
  return counts.status !== 'unavailable' && alarmListShown ? slot : undefined;
}
