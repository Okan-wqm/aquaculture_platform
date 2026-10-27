import {
  OWNER_MODULE_CODES,
  decideAccess,
  type ModuleRole,
  type NonEmptyReadonlyArray,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';

import {
  moduleRoom,
  registryRoom,
  type ModuleResource,
  type ModuleSocketRoom,
} from './module-socket-rooms';
import type { SocketMember } from './socket-member';

/**
 * Which module rooms a socket may join, and which rooms an event reaches (ADR-051 §1, §3 step 1;
 * SEC-CRITICAL-206, SEC-CRITICAL-207).
 *
 * Every answer comes from `decideAccess`; nothing here reads the global role:
 *   - module(m), read, @Roles MODULE_MANAGER allows: the member is tenant-wide in m (a module
 *     manager, TENANT_ADMIN through its claim, SUPER_ADMIN) and joins the module room;
 *   - module(m), read, no @Roles allows: the member holds a MODULE_USER grant, which a site
 *     assignment restricts (ADR-051 §1), and joins the room of each assigned site; with no site
 *     it joins nothing;
 *   - scoped(common-registry), read: the registry room of every module in the scope.
 * An event attributed to a site reaches the module room and that site's room; an event without a
 * site reaches the module room only, so a site-bound member never sees rows of no site.
 */
export type ModuleSocketScope =
  | { readonly kind: 'module' }
  | { readonly kind: 'sites'; readonly siteIds: NonEmptyReadonlyArray<string> };

const MODULE_WIDE: ModuleSocketScope = Object.freeze({ kind: 'module' });

function readsModule(
  member: SocketMember,
  module: OwnerModuleCode,
  roles: readonly ModuleRole[],
): boolean {
  return decideAccess(member.caller, { spec: { kind: 'module', module }, intent: 'read', roles })
    .allowed;
}

/** The member's scope in `module`, or null when it may join no room of the module. */
export function moduleSocketScope(
  member: SocketMember,
  module: OwnerModuleCode,
): ModuleSocketScope | null {
  if (readsModule(member, module, ['MODULE_MANAGER'])) return MODULE_WIDE;
  if (!readsModule(member, module, [])) return null;
  const [first, ...rest] = [...new Set(member.assignedSiteIds)];
  if (first === undefined) return null;
  const siteIds: NonEmptyReadonlyArray<string> = [first, ...rest];
  return Object.freeze({ kind: 'sites', siteIds: Object.freeze(siteIds) });
}

/** Whether a row on `siteId` (null: on no site) lies inside the scope. */
export function scopeAdmitsSite(scope: ModuleSocketScope, siteId: string | null): boolean {
  if (scope.kind === 'module') return true;
  return siteId !== null && scope.siteIds.includes(siteId);
}

/** The rooms of `module` (or of one of its resources) the member may join; [] for none. */
export function memberModuleRooms(
  member: SocketMember,
  module: OwnerModuleCode,
  resource?: ModuleResource,
): readonly ModuleSocketRoom[] {
  const scope = moduleSocketScope(member, module);
  if (scope === null) return [];
  if (scope.kind === 'module') return [moduleRoom(member.tenantId, module, { resource })];
  return scope.siteIds.map((siteId) => moduleRoom(member.tenantId, module, { siteId, resource }));
}

/** The common-registry rooms of every module in the member's scope; [] for none. */
export function memberRegistryRooms(member: SocketMember): readonly ModuleSocketRoom[] {
  const decision = decideAccess(member.caller, {
    spec: { kind: 'scoped', scope: 'common-registry' },
    intent: 'read',
    roles: [],
  });
  if (!decision.allowed || decision.kind !== 'scoped') return [];
  const modules = decision.scope.kind === 'all' ? OWNER_MODULE_CODES : decision.scope.modules;
  return modules.map((module) => registryRoom(member.tenantId, module));
}

/** The rooms an event of `module` on `siteId` (null: on no site) reaches. */
export function eventModuleRooms(
  tenantId: string,
  module: OwnerModuleCode,
  siteId: string | null,
  resource?: ModuleResource,
): NonEmptyReadonlyArray<ModuleSocketRoom> {
  const moduleWide = moduleRoom(tenantId, module, { resource });
  if (siteId === null) return [moduleWide];
  return [moduleWide, moduleRoom(tenantId, module, { siteId, resource })];
}
