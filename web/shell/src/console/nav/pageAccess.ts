/**
 * Who may see a console page (FE-HIGH-335) — the nav's mirror of the guards
 * that serve each route, so the rail never offers a link the route refuses:
 *
 *  - module: a page under a module mount (mounts.ts) needs the tenant to hold
 *    that module (AuthContext `modules`), for every role — the nav lists only
 *    assigned modules, as today. A tenant-wide page (Company) is the exception
 *    for a tenant admin, whom the route admits whatever the modules;
 *  - roles: `requiredRoles` lists the roles that see it (finance and payroll,
 *    as their in-page gates; the tenant admin's own pages);
 *  - permission: a delegatable tenant page needs a tenant admin or a delegate
 *    holding its capability (MT-HIGH-060, DELEGATABLE_TENANT_NAV today); the
 *    new AI chat needs the AI surface capability its page checks
 *    (FE-MEDIUM-065).
 */
import { moduleForPath } from './mounts';
import type { ConsoleRole, NavPageDef } from './types';

/** The gate inputs, resolved once per build. */
export interface PageAccessContext {
  readonly role: ConsoleRole;
  readonly modules: ReadonlySet<string>;
  readonly hasPermission: (permission: string) => boolean;
}

export function canSeePage(page: NavPageDef, context: PageAccessContext): boolean {
  const isTenantAdmin = context.role === 'TENANT_ADMIN';
  const module = moduleForPath(page.path);
  if (module !== undefined && !context.modules.has(module)) {
    if (!(isTenantAdmin && page.tenantWide === true)) return false;
  }
  if (page.requiredRoles !== undefined && !page.requiredRoles.includes(context.role)) {
    return false;
  }
  if (page.requiredPermission !== undefined) {
    return isTenantAdmin || context.hasPermission(page.requiredPermission);
  }
  return true;
}
