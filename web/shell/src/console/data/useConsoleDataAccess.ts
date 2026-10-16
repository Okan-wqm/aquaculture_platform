/**
 * Which console data sources this viewer may read.
 *
 * WHY: a source the viewer cannot use must not be fetched at all — its hook
 * reports 'unavailable' and the cell is not drawn. Each gate is the condition
 * under which the console shows the source:
 *  - alarms: the sensor module, for every role. The alarm list (/sensor/alerts)
 *    lives in that module, and the annunciator and rail badge are drawn only
 *    when the nav offers it, so a tenant admin without the module has nothing
 *    that would show the counts;
 *  - devices: the sensor module, or a tenant admin — the tenant console's
 *    Devices page needs no module;
 *  - sites: the farm module;
 *  - people: users:view, the guard of auth-service tenantUsers and of the
 *    users page a person entry opens (hasPermission lets admins through);
 *  - roles: roles:view, the guard of auth-service tenantRoles.
 * Every gate also needs an authenticated tenant session, the same condition
 * useTenantQuery fires on.
 *
 * WHAT: one boolean per source, derived from useAuth and the assigned modules.
 */
import { useAuth, useAuthContext } from '@aquaculture/shared-ui';
import { useMemo } from 'react';

export interface ConsoleDataAccess {
  /** alert-engine activeAlertCounts (annunciator). */
  readonly alarms: boolean;
  /** sensor-service edgeDeviceStats / edgeDevices. */
  readonly devices: boolean;
  /** farm-service activeSites. */
  readonly sites: boolean;
  /** auth-service tenantUsers. */
  readonly people: boolean;
  /** auth-service tenantRoles. */
  readonly roles: boolean;
}

export function useConsoleDataAccess(): ConsoleDataAccess {
  const { token, tenantId, isTenantAdmin, hasPermission } = useAuth();
  const { modules } = useAuthContext();
  const session = Boolean(token && tenantId);
  const canViewUsers = hasPermission('users:view');
  const canViewRoles = hasPermission('roles:view');

  return useMemo((): ConsoleDataAccess => {
    const assigned = new Set(modules.map((module) => module.code));
    const sensorModule = session && assigned.has('sensor');
    return {
      alarms: sensorModule,
      devices: sensorModule || (session && isTenantAdmin),
      sites: session && assigned.has('farm'),
      people: session && canViewUsers,
      roles: session && canViewRoles,
    };
  }, [session, isTenantAdmin, modules, canViewUsers, canViewRoles]);
}
