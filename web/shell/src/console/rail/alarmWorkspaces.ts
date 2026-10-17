/**
 * Which console workspaces carry an alarm column in the workspace menu
 * (design digest §6.3): Production (fish-site alarms), Greenhouse (greenhouse
 * alarms) and Control & sensors (equipment alarms). Company aggregates no
 * module's alarms — its row has no column.
 */
import type { ConsoleWorkspaceId } from '@aquaculture/shared-ui';

export const ALARM_WORKSPACES = [
  'aqua',
  'gh',
  'ctl',
] as const satisfies readonly ConsoleWorkspaceId[];

export type AlarmWorkspaceId = (typeof ALARM_WORKSPACES)[number];

export function isAlarmWorkspace(id: ConsoleWorkspaceId): id is AlarmWorkspaceId {
  return (ALARM_WORKSPACES as readonly ConsoleWorkspaceId[]).includes(id);
}
