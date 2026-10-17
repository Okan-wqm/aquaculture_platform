/**
 * Role preview — "view as role" (FE-HIGH-334, design README §8, decisions
 * D19/D20).
 *
 * WHY a nav input and not a second gate: a preview must show exactly what the
 * nav model would give a holder of the role, so it rebuilds the nav through
 * the same buildConsoleNav with the role's permission set. It is client-side
 * only — the input changes what the rail, palette and header offer; every
 * request still carries the real user's token, so mutations run with the real
 * role (the server never receives the viewed one).
 *
 * WHAT: the preview's nav input, the page count the user menu shows per role,
 * and whether a nav claims a location (a preview that cannot open the page on
 * screen moves to its home).
 */
import type { ViewAsRole } from '../data';
import { findActivePage, type ConsoleNavInput, type Workspace } from '../nav';

/**
 * The user-menu row of the admin's own view. Tenant role ids are UUIDs, so this
 * id cannot name a role.
 */
export const OWN_VIEW_ID = 'own-view';

/**
 * The nav input of a holder of `role`. A tenant role grants resource
 * permissions, not the global tier: its holders are module users or managers,
 * so the preview shows the floor every holder gets — a module user with exactly
 * the role's permissions (a role whose permission row is absent grants nothing,
 * as the backend reads it). The tenant's modules are the admin's own.
 */
export function viewAsNavInput(
  real: ConsoleNavInput,
  role: Pick<ViewAsRole, 'resourcePermissions'>,
): ConsoleNavInput {
  const granted = new Set(role.resourcePermissions);
  return {
    modules: real.modules,
    t: real.t,
    role: 'MODULE_USER',
    hasPermission: (permission: string): boolean => granted.has(permission),
  };
}

/** The distinct pages a nav offers — a page several workspaces share counts once. */
export function countConsolePages(workspaces: readonly Workspace[]): number {
  const ids = new Set<string>();
  for (const workspace of workspaces) {
    for (const area of workspace.areas) {
      for (const group of area.groups) {
        for (const page of group.pages) ids.add(page.id);
      }
    }
  }
  return ids.size;
}

/** Whether any workspace of `workspaces` has an entry for `path`. */
export function isPathInNav(path: string, workspaces: readonly Workspace[]): boolean {
  return workspaces.some((workspace) => findActivePage(path, workspace) !== undefined);
}
