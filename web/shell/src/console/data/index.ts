/**
 * Console data hooks — the tenant-scoped reads behind the console header,
 * title block, annunciator, command palette and user menu.
 *
 * Every hook returns a StatusResult: real values when 'ready', all-null values
 * when 'loading', 'error' or 'unavailable', so a cell hides or greys out
 * instead of showing a value nobody measured.
 */
export type { DataStatus, PendingStatus, StatusResult } from './dataStatus';
export type { AlarmCounts } from './alarmPriority';
// The P1/P2/P3 scale itself is shared-ui's: the annunciator and the alarm list read it too.
export type { AlarmPriority } from '@aquaculture/shared-ui';
export { useAlarmSummary, type AlarmSummary } from './useAlarmSummary';
export { useDeviceStatus, type DeviceCounts, type DeviceStatus } from './useDeviceStatus';
export { useSiteStatus, type SiteCounts, type SiteStatus } from './useSiteStatus';
export {
  usePaletteSources,
  type PaletteDevice,
  type PalettePerson,
  type PaletteReach,
  type PaletteSources,
} from './usePaletteSources';
export {
  useViewAsRoles,
  type ViewAsRole,
  type ViewAsRoles,
  type ViewAsRolesOptions,
} from './useViewAsRoles';
export { useConsoleDataAccess, type ConsoleDataAccess } from './useConsoleDataAccess';
