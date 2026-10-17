/**
 * Which console workspaces carry an alarm column in the workspace menu
 * (design digest §6.3): Production (fish-site alarms), Greenhouse (greenhouse
 * alarms) and Control & sensors (equipment alarms). Company aggregates no
 * module's alarms — its row has no column.
 *
 * Each column counts the alarms of its workspace's own module (WorkspaceDef
 * `module`), as alert-engine records it on every alarm (AlertModule,
 * ALERT-MEDIUM-010): farm-service signals for Production, sensor-service
 * readings and guards for Control & sensors, hydroponics for Greenhouse.
 */
import type { ConsoleWorkspaceId } from '@aquaculture/shared-ui';
import type { AlertModule } from '@platform/shared-ui/generated/graphql-types';

export const ALARM_WORKSPACES = [
  'aqua',
  'gh',
  'ctl',
] as const satisfies readonly ConsoleWorkspaceId[];

export type AlarmWorkspaceId = (typeof ALARM_WORKSPACES)[number];

export function isAlarmWorkspace(id: ConsoleWorkspaceId): id is AlarmWorkspaceId {
  return (ALARM_WORKSPACES as readonly ConsoleWorkspaceId[]).includes(id);
}

/** The alert-engine module whose alarms each workspace's column counts. */
export const ALARM_WORKSPACE_MODULE: Readonly<Record<AlarmWorkspaceId, AlertModule>> = {
  aqua: 'FARM',
  gh: 'HYDROPONICS',
  ctl: 'SENSOR',
};
