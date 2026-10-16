/**
 * The command log's route element (/sensor/commands).
 *
 * WHY a role gate: the drive trail and the deployment history the page shows
 * are served only to TENANT_ADMIN / MODULE_MANAGER (vfdCommandAuditLog,
 * deploymentHistory), so a module user would get a page whose records all
 * fail to load, with a retry that can never succeed. RequireRole is
 * hierarchy-aware: MODULE_MANAGER admits a tenant admin too; anyone else is
 * sent to /unauthorized. The console nav lists the page for the same roles
 * (web/shell console nav, SENSOR_PAGES.commands).
 */
import React from 'react';
import { RequireRole, type UserRole } from '@aquaculture/shared-ui';

import { CommandLogPage } from './CommandLogPage';

/** The lowest role the command log admits. */
export const COMMAND_LOG_ROLES: readonly UserRole[] = ['MODULE_MANAGER'];

export function CommandLogRoute(): React.JSX.Element {
  return (
    <RequireRole requiredRoles={COMMAND_LOG_ROLES}>
      <CommandLogPage />
    </RequireRole>
  );
}

export default CommandLogRoute;
