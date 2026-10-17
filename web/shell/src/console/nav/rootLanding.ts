/**
 * Where `/` lands a signed-in user.
 *
 * WHY: each module workspace now opens on a dashboard of its own, and the
 * company dashboard (/tenant) opens for every member. The old landing sent
 * every non-admin to one tenant-wide KPI page at /dashboard, which no longer
 * exists: Production's dashboard is there now, and a user without the farm
 * module would land on a workspace they cannot see.
 *
 * WHAT: a platform admin → /admin; a tenant admin → the company dashboard;
 * anyone else → the home of the first module workspace (switcher order) their
 * tenant holds — that workspace's dashboard — or the company dashboard when
 * they hold none.
 */
import { workspaceHome } from './workspaceHome';
import { CONSOLE_WORKSPACES } from './workspaces';

export const COMPANY_DASHBOARD_PATH = '/tenant';

export function rootLanding(role: string, moduleCodes: readonly string[]): string {
  if (role === 'SUPER_ADMIN') return '/admin';
  if (role === 'TENANT_ADMIN') return COMPANY_DASHBOARD_PATH;
  const assigned = new Set(moduleCodes);
  const workspace = CONSOLE_WORKSPACES.find(
    (candidate) => candidate.module !== undefined && assigned.has(candidate.module),
  );
  return (workspace && workspaceHome(workspace)) ?? COMPANY_DASHBOARD_PATH;
}
