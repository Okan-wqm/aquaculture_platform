/**
 * useWorkspaceAlarmCounts — each module workspace's P1/P2/P3 for the
 * workspace menu (design handoff §7.3; ALERT-MEDIUM-010).
 *
 * WHY: alert-engine records the module an alarm comes from, so the menu shows
 * real counts per workspace, read from the same request as the annunciator
 * (useActiveAlertCounts) — never a workspace count from another moment than
 * the tiles above it. An alarm recorded before alarms carried a module counts
 * on the annunciator and in no workspace: it belongs to none that could be
 * named.
 *
 * WHAT: StatusResult<{ byWorkspace }> — Production's, Greenhouse's and
 * Control & sensors' tallies when ready; null while loading, after a failed
 * refresh, or for a viewer who cannot read alarms (no request then).
 */
import { useMemo } from 'react';

import { workspaceAlarmTallies, type WorkspaceAlarmTallies } from './alarmPriority';
import { pendingResult, readyResult, type Nulled, type StatusResult } from './dataStatus';
import { useActiveAlertCounts } from './useActiveAlertCounts';

interface MenuCounts {
  readonly byWorkspace: WorkspaceAlarmTallies;
}

export type WorkspaceAlarmCounts = StatusResult<MenuCounts>;

const NO_COUNTS: Nulled<MenuCounts> = { byWorkspace: null };

export function useWorkspaceAlarmCounts(): WorkspaceAlarmCounts {
  const { query, enabled } = useActiveAlertCounts();
  // Tallied once per fetched snapshot, so the menu's slot keeps its identity
  // between refreshes that change nothing.
  const byWorkspace = useMemo(
    () => (query.data === undefined ? undefined : workspaceAlarmTallies(query.data)),
    [query.data],
  );
  if (!enabled) return pendingResult('unavailable', NO_COUNTS);
  if (query.isError) return pendingResult('error', NO_COUNTS);
  if (query.isSuccess && byWorkspace !== undefined) return readyResult({ byWorkspace });
  return pendingResult('loading', NO_COUNTS);
}
