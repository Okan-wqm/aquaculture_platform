/**
 * The workspace menu's alarm column (design handoff §7.3; ALERT-MEDIUM-010).
 *
 * WHAT: `renderWorkspaceAlarms` is the slot IndustrialRail hands its
 * WorkspaceMenu: for a workspace with an alarm column, its P1/P2/P3 pairs
 * rendered through MockPreview's inline variant — the sample counts always sit
 * beside the MOCK chip naming the missing per-module summary and the finding;
 * for Company, nothing. `useWorkspaceAlarmsSlot` gives the slot only where
 * the annunciator is drawn: the nav on screen lists the alarm list (ConsoleShell
 * passes the same `findNavPage(workspaces, 'alarms')` result that gates the
 * annunciator — the previewed role's nav while an admin views as one) and the
 * viewer may read alarm data. A farm-only tenant, or a viewed role without the
 * alarm list, therefore gets no alarm column, as it gets no annunciator.
 *
 * WHY here and not in shared-ui: the rail and menu stay free of preview data;
 * the shell owns which source feeds them. When alert-engine serves the
 * summary, this file reads it instead and the preview file is deleted.
 */
import { AlarmPriorityCounts, MockPreview, type ConsoleWorkspaceId } from '@aquaculture/shared-ui';
import type { ReactNode } from 'react';

import { useConsoleDataAccess } from '../data/useConsoleDataAccess';

import { isAlarmWorkspace } from './alarmWorkspaces';
import { WORKSPACE_ALARMS_PREVIEW } from './workspaceAlarms.preview';

export type WorkspaceAlarmsSlot = (id: ConsoleWorkspaceId) => ReactNode;

export function renderWorkspaceAlarms(id: ConsoleWorkspaceId): ReactNode {
  if (!isAlarmWorkspace(id)) return null;
  return (
    <MockPreview data={WORKSPACE_ALARMS_PREVIEW} variant="inline">
      {(byWorkspace) => <AlarmPriorityCounts counts={byWorkspace[id]} />}
    </MockPreview>
  );
}

/**
 * The menu's alarm slot, or undefined for no column.
 *
 * @param alarmListShown whether the nav on screen lists the alarm list — the
 *   annunciator's gate, passed in so the two cannot disagree.
 */
export function useWorkspaceAlarmsSlot(alarmListShown: boolean): WorkspaceAlarmsSlot | undefined {
  const { alarms } = useConsoleDataAccess();
  return alarms && alarmListShown ? renderWorkspaceAlarms : undefined;
}
