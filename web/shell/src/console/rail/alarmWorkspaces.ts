/**
 * Which console workspaces carry an alarm column in the workspace menu
 * (design digest §6.3): Production, Greenhouse and Control & sensors.
 * Company aggregates no module's alarms — its row has no column.
 *
 * Each column counts the alert-engine alarms of its workspace's own module
 * (WorkspaceDef `module`), as alert-engine records it on every alarm
 * (AlertModule, ALERT-MEDIUM-010): farm-service signals for Production; for
 * Control & sensors, rule alarms on sensor readings and the pre-meal oxygen
 * guard; hydroponics for Greenhouse. PLC alarms and SCADA runtime alarms are
 * not alert-engine alarms and are not counted (SENSOR-MEDIUM-188); the menu
 * says so beside the counts (FE-LOW-347).
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
